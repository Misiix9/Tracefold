use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

pub const MAX_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOTAL_UNPACKED_BYTES: usize = 128 * 1024 * 1024;
const MAX_FILES: usize = 512;
const START_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(200);
const CURRENT_PLUGIN_API_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub schema: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    #[serde(default)]
    pub description: String,
    pub api_version: u32,
    pub min_tracefold_version: String,
    pub runtime: RuntimeManifest,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    #[serde(rename = "type")]
    pub kind: String,
    pub entry: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub health: String,
    pub bind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub description: String,
    pub api_version: u32,
    pub min_tracefold_version: String,
    pub capabilities: Vec<String>,
    pub enabled: bool,
    pub running: bool,
    pub url: Option<String>,
}

struct RunningPlugin {
    child: Child,
    port: u16,
}

struct InstallSession {
    root: PathBuf,
    file_count: usize,
    total_bytes: usize,
    paths: HashSet<String>,
}

pub struct PluginRuntime {
    root: PathBuf,
    running: Mutex<HashMap<String, RunningPlugin>>,
    starting: Mutex<HashSet<String>>,
    installs: Mutex<HashMap<String, InstallSession>>,
    shutting_down: Mutex<bool>,
}

impl PluginRuntime {
    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)
            .map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not create plugin storage: {e}")))?;
        recover_interrupted_replacements(&root)?;
        cleanup_installing_directories(&root)?;
        Ok(Self {
            root,
            running: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashSet::new()),
            installs: Mutex::new(HashMap::new()),
            shutting_down: Mutex::new(false),
        })
    }

    pub fn list(&self) -> Result<Vec<PluginInfo>> {
        self.reap_dead()?;
        let mut plugins = Vec::new();
        let entries = fs::read_dir(&self.root)
            .map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not list plugins: {e}")))?;
        for entry in entries {
            let entry = entry.map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not read plugin entry: {e}")))?;
            let path = entry.path();
            if !entry.file_type().map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not inspect plugin entry: {e}")))?.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|v| v.to_str()) else { continue; };
            if name.starts_with('.') { continue; }
            let manifest = match read_manifest(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if validate_manifest(&manifest).is_err() { continue; }
            plugins.push(self.info_from_manifest(&manifest)?);
        }
        plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(plugins)
    }

    pub fn begin_install(&self) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let staging = self.root.join(format!(".installing-{id}"));
        fs::create_dir_all(&staging)
            .map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not create staging directory: {e}")))?;
        self.installs.lock().map_err(|_| plugin_error("PLUGIN_STORAGE", "Plugin installation state is unavailable."))?.insert(id.clone(), InstallSession {
            root: staging,
            file_count: 0,
            total_bytes: 0,
            paths: HashSet::new(),
        });
        Ok(id)
    }

    pub fn append_install_file(&self, install_id: &str, relative_path: &str, data: Vec<u8>) -> Result<()> {
        validate_install_id(install_id)?;
        let safe = safe_relative_path(relative_path)?;
        if data.len() > MAX_FILE_BYTES {
            return Err(plugin_error("LIMIT_EXCEEDED", "A plugin file exceeds the 64 MiB limit."));
        }
        let key = package_path_key(&safe);
        let mut installs = self.installs.lock().map_err(|_| plugin_error("PLUGIN_STORAGE", "Plugin installation state is unavailable."))?;
        let session = installs.get_mut(install_id).ok_or_else(|| plugin_error("PLUGIN_INPUT", "The plugin installation session is no longer available."))?;
        if session.file_count >= MAX_FILES {
            return Err(plugin_error("LIMIT_EXCEEDED", "A plugin package contains too many files."));
        }
        if session.total_bytes.saturating_add(data.len()) > MAX_TOTAL_UNPACKED_BYTES {
            return Err(plugin_error("LIMIT_EXCEEDED", "The unpacked plugin package exceeds the 128 MiB limit."));
        }
        if !session.paths.insert(key.clone()) {
            return Err(plugin_error("PLUGIN_INVALID", "The plugin package contains duplicate file paths."));
        }
        let destination = session.root.join(&safe);
        if destination.exists() {
            session.paths.remove(&key);
            return Err(plugin_error("PLUGIN_INVALID", "The plugin package contains a duplicate destination path."));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not create plugin directory: {e}")))?;
        }
        let temp = session.root.join(format!(".part-{}", Uuid::new_v4()));
        let write_result = (|| -> Result<()> {
            let mut handle = fs::File::create(&temp).map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not write plugin file: {e}")))?;
            handle.write_all(&data).map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not write plugin file: {e}")))?;
            handle.sync_all().map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not finalize plugin file: {e}")))?;
            fs::rename(&temp, &destination).map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not finalize plugin file: {e}")))?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temp);
            session.paths.remove(&key);
            return write_result;
        }
        session.file_count += 1;
        session.total_bytes += data.len();
        Ok(())
    }

    pub fn finalize_install(&self, install_id: &str) -> Result<PluginInfo> {
        validate_install_id(install_id)?;
        let session = self.installs.lock().map_err(|_| plugin_error("PLUGIN_STORAGE", "Plugin installation state is unavailable."))?.remove(install_id)
            .ok_or_else(|| plugin_error("PLUGIN_INPUT", "The plugin installation session is no longer available."))?;
        let result = self.finalize_install_inner(&session);
        if result.is_err() {
            let _ = fs::remove_dir_all(&session.root);
        }
        result
    }

    fn finalize_install_inner(&self, session: &InstallSession) -> Result<PluginInfo> {
        let manifest = read_manifest(&session.root)?;
        validate_manifest(&manifest)?;
        if session.file_count == 0 {
            return Err(plugin_error("PLUGIN_INVALID", "The plugin package is empty."));
        }
        let entry = session.root.join(safe_relative_path(&manifest.runtime.entry)?);
        if !entry.is_file() {
            return Err(plugin_error("PLUGIN_INVALID", "The plugin runtime entrypoint is missing."));
        }
        let manifest_path = session.root.join("manifest.json");
        if !manifest_path.is_file() {
            return Err(plugin_error("PLUGIN_INVALID", "The plugin package must contain a root manifest.json."));
        }
        self.stop(&manifest.id)?;
        let dir = self.plugin_dir(&manifest.id)?;
        swap_staged_plugin(&dir, &session.root, false)?;
        self.info(&manifest.id)
    }

    pub fn abort_install(&self, install_id: &str) -> Result<()> {
        validate_install_id(install_id)?;
        let session = self.installs.lock().map_err(|_| plugin_error("PLUGIN_STORAGE", "Plugin installation state is unavailable."))?.remove(install_id);
        if let Some(session) = session {
            let _ = fs::remove_dir_all(session.root);
        }
        Ok(())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        validate_id(id)?;
        let dir = self.plugin_dir(id)?;
        if !dir.is_dir() { return Err(AppError::missing()); }
        let marker = dir.join(".disabled");
        if enabled {
            match fs::remove_file(marker) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(plugin_error("PLUGIN_STORAGE", format!("Could not enable plugin: {e}"))),
            }
        } else {
            self.stop(id)?;
            fs::write(marker, b"disabled\n").map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not disable plugin: {e}")))
        }
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        self.stop(id)?;
        let dir = self.plugin_dir(id)?;
        if !dir.exists() { return Err(AppError::missing()); }
        fs::remove_dir_all(dir).map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not remove plugin: {e}")))
    }

    pub fn is_running(&self, id: &str) -> Result<bool> {
        validate_id(id)?;
        self.reap_dead()?;
        Ok(self.running.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?.contains_key(id))
    }

    pub fn start(&self, id: &str) -> Result<String> {
        validate_id(id)?;
        if *self.shutting_down.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))? {
            return Err(plugin_error("PLUGIN_RUNTIME", "Tracefold is shutting down."));
        }
        self.reap_dead()?;
        {
            let mut starting = self.starting.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?;
            if !starting.insert(id.to_string()) {
                return Err(plugin_error("PLUGIN_RUNTIME", "The plugin is already starting."));
            }
        }
        let result = self.start_inner(id);
        self.starting.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?.remove(id);
        result
    }

    fn start_inner(&self, id: &str) -> Result<String> {
        let manifest = read_manifest(&self.plugin_dir(id)?)?;
        validate_manifest(&manifest)?;
        if !self.is_enabled(id)? { return Err(plugin_error("PLUGIN_DISABLED", "The plugin is disabled.")); }
        if self.is_running(id)? {
            return self.runtime_url(id);
        }
        let plugin_dir = self.plugin_dir(id)?;
        let data_dir = self.root.join("plugin-data").join(id);
        fs::create_dir_all(&data_dir).map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not create plugin data directory: {e}")))?;
        let port = free_loopback_port()?;
        let command_path = resolve_command(&manifest.runtime.command, &plugin_dir)?;
        let mut args = if manifest.runtime.args.is_empty() { vec![manifest.runtime.entry.clone()] } else { manifest.runtime.args.clone() };
        for arg in &mut args {
            *arg = arg.replace("{port}", &port.to_string())
                .replace("{pluginDir}", &plugin_dir.to_string_lossy())
                .replace("{dataDir}", &data_dir.to_string_lossy());
        }
        let mut command = Command::new(command_path);
        command.args(args)
            .current_dir(&plugin_dir)
            .env("TRACEFOLD_PLUGIN_ID", &manifest.id)
            .env("TRACEFOLD_PLUGIN_VERSION", &manifest.version)
            .env("TRACEFOLD_PLUGIN_API_VERSION", manifest.api_version.to_string())
            .env("TRACEFOLD_PLUGIN_BIND", "127.0.0.1")
            .env("TRACEFOLD_PLUGIN_PORT", port.to_string())
            .env("TRACEFOLD_PLUGIN_DATA_DIR", &data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
            });
        }
        let mut child = command.spawn().map_err(|e| plugin_error("PLUGIN_RUNTIME", format!("Could not start plugin runtime: {e}")))?;
        if *self.shutting_down.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))? {
            let _ = kill_process_tree(&mut child);
            let _ = child.wait();
            return Err(plugin_error("PLUGIN_RUNTIME", "Tracefold is shutting down."));
        }
        self.running.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?.insert(id.to_string(), RunningPlugin { child, port });
        let started = Instant::now();
        while started.elapsed() < START_TIMEOUT {
            if self.child_exited(id)? {
                return Err(plugin_error("PLUGIN_RUNTIME", "The plugin runtime exited before its health check became ready."));
            }
            if health_check(port, &manifest.runtime.health) {
                return Ok(format!("http://127.0.0.1:{port}"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.stop(id);
        Err(plugin_error("PLUGIN_RUNTIME", "The plugin runtime did not become ready within 120 seconds."))
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        if self.starting.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?.contains(id) {
            return Err(plugin_error("PLUGIN_RUNTIME", "The plugin is still starting. Wait for startup to finish before stopping it."));
        }
        self.reap_dead()?;
        let runtime = self.running.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?.remove(id);
        let Some(mut runtime) = runtime else { return Ok(()); };
        if runtime.child.try_wait().map_err(|e| plugin_error("PLUGIN_RUNTIME", format!("Could not inspect plugin process: {e}")))?.is_some() {
            return Ok(());
        }
        kill_process_tree(&mut runtime.child).map_err(|e| plugin_error("PLUGIN_RUNTIME", format!("Could not stop plugin runtime: {e}")))?;
        runtime.child.wait().map_err(|e| plugin_error("PLUGIN_RUNTIME", format!("Could not reap plugin runtime: {e}")))?;
        Ok(())
    }

    pub fn stop_all(&self) {
        let ids = self.running.lock().ok().map(|running| running.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
        for id in ids { let _ = self.stop(&id); }
    }

    pub fn shutdown(&self) {
        if let Ok(mut shutting_down) = self.shutting_down.lock() {
            *shutting_down = true;
        }
        self.stop_all();
    }

    pub fn info(&self, id: &str) -> Result<PluginInfo> {
        validate_id(id)?;
        self.reap_dead()?;
        let manifest = read_manifest(&self.plugin_dir(id)?)?;
        validate_manifest(&manifest)?;
        self.info_from_manifest(&manifest)
    }

    fn info_from_manifest(&self, manifest: &PluginManifest) -> Result<PluginInfo> {
        let running = self.running.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?;
        let runtime = running.get(&manifest.id);
        Ok(PluginInfo {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            publisher: manifest.publisher.clone(),
            description: manifest.description.clone(),
            api_version: manifest.api_version,
            min_tracefold_version: manifest.min_tracefold_version.clone(),
            capabilities: manifest.capabilities.clone(),
            enabled: self.is_enabled(&manifest.id)?,
            running: runtime.is_some(),
            url: runtime.map(|value| format!("http://127.0.0.1:{}", value.port)),
        })
    }

    fn is_enabled(&self, id: &str) -> Result<bool> {
        Ok(!self.plugin_dir(id)?.join(".disabled").exists())
    }

    fn runtime_url(&self, id: &str) -> Result<String> {
        let running = self.running.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?;
        running.get(id).map(|runtime| format!("http://127.0.0.1:{}", runtime.port)).ok_or_else(|| plugin_error("PLUGIN_RUNTIME", "The plugin runtime is not running."))
    }

    fn child_exited(&self, id: &str) -> Result<bool> {
        let mut running = self.running.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?;
        let Some(runtime) = running.get_mut(id) else { return Ok(true); };
        match runtime.child.try_wait().map_err(|e| plugin_error("PLUGIN_RUNTIME", format!("Could not inspect plugin process: {e}")))? {
            Some(_) => {
                running.remove(id);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn reap_dead(&self) -> Result<()> {
        let mut running = self.running.lock().map_err(|_| plugin_error("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?;
        let mut dead = Vec::new();
        for (id, runtime) in running.iter_mut() {
            if runtime.child.try_wait().map_err(|e| plugin_error("PLUGIN_RUNTIME", format!("Could not inspect plugin process: {e}")))?.is_some() {
                dead.push(id.clone());
            }
        }
        for id in dead { running.remove(&id); }
        Ok(())
    }

    fn plugin_dir(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        Ok(self.root.join(id))
    }
}

impl Drop for PluginRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn pick_plugin_archive(app: &AppHandle) -> Result<Vec<u8>> {
    let selected = app.dialog().file().add_filter("Tracefold plugin", &["tracefold-plugin", "zip"]).blocking_pick_file();
    let Some(selected) = selected else { return Ok(Vec::new()); };
    let path = selected.into_path().map_err(|_| plugin_error("PLUGIN_INPUT", "Choose a local plugin package."))?;
    let size = fs::metadata(&path).map_err(|e| plugin_error("PLUGIN_INPUT", format!("Could not inspect plugin package: {e}")))?.len();
    if size > MAX_PACKAGE_BYTES { return Err(plugin_error("LIMIT_EXCEEDED", "The plugin package exceeds the 256 MiB limit.")); }
    fs::read(&path).map_err(|e| plugin_error("PLUGIN_INPUT", format!("Could not read plugin package: {e}")))
}

fn read_manifest(dir: &Path) -> Result<PluginManifest> {
    let bytes = fs::read(dir.join("manifest.json")).map_err(|e| plugin_error("PLUGIN_INVALID", format!("Could not read plugin manifest: {e}")))?;
    serde_json::from_slice(&bytes).map_err(|e| plugin_error("PLUGIN_INVALID", format!("The plugin manifest is invalid JSON: {e}")))
}

fn validate_manifest(manifest: &PluginManifest) -> Result<()> {
    if manifest.schema != "tracefold.plugin.v1" { return Err(plugin_error("PLUGIN_INVALID", "Unsupported plugin manifest schema.")); }
    validate_id(&manifest.id)?;
    if manifest.name.trim().is_empty() || manifest.name.len() > 120 { return Err(plugin_error("PLUGIN_INVALID", "Plugin name is invalid.")); }
    if !is_version(&manifest.version) || !is_version(&manifest.min_tracefold_version) { return Err(plugin_error("PLUGIN_INVALID", "Plugin versions must use major.minor.patch format.")); }
    if parse_version(&manifest.min_tracefold_version)? > parse_version(env!("CARGO_PKG_VERSION"))? { return Err(plugin_error("PLUGIN_INVALID", "This plugin requires a newer Tracefold version.")); }
    if manifest.publisher.trim().is_empty() || manifest.publisher.len() > 120 { return Err(plugin_error("PLUGIN_INVALID", "Plugin publisher is invalid.")); }
    if manifest.description.len() > 2000 { return Err(plugin_error("PLUGIN_INVALID", "Plugin description is too long.")); }
    if manifest.api_version != CURRENT_PLUGIN_API_VERSION { return Err(plugin_error("PLUGIN_INVALID", "Unsupported plugin API version.")); }
    if manifest.runtime.kind != "loopback-web" { return Err(plugin_error("PLUGIN_INVALID", "Unsupported plugin runtime type.")); }
    safe_relative_path(&manifest.runtime.entry)?;
    if manifest.runtime.entry.trim().is_empty() { return Err(plugin_error("PLUGIN_INVALID", "Plugin runtime entrypoint is required.")); }
    if manifest.runtime.command.trim().is_empty() || manifest.runtime.command.len() > 100 { return Err(plugin_error("PLUGIN_INVALID", "Plugin runtime command is invalid.")); }
    if manifest.runtime.args.len() > 64 { return Err(plugin_error("PLUGIN_INVALID", "Plugin runtime has too many arguments.")); }
    if manifest.runtime.health.is_empty() || manifest.runtime.health.len() > 200 || !manifest.runtime.health.starts_with('/') || manifest.runtime.health.contains("..") || manifest.runtime.health.contains('\\') || manifest.runtime.health.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(plugin_error("PLUGIN_INVALID", "Plugin health path must be a local HTTP path."));
    }
    if manifest.runtime.bind != "127.0.0.1" { return Err(plugin_error("PLUGIN_INVALID", "Plugin runtimes must declare 127.0.0.1 as their bind address.")); }
    if manifest.capabilities.len() > 64 { return Err(plugin_error("PLUGIN_INVALID", "Plugin declares too many capabilities.")); }
    let mut capabilities = HashSet::new();
    for capability in &manifest.capabilities {
        if capability.trim().is_empty() || capability.len() > 100 || !capabilities.insert(capability) { return Err(plugin_error("PLUGIN_INVALID", "Plugin capabilities must be unique and non-empty.")); }
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 || id == "." || id == ".." || id.starts_with('.') || id.ends_with('.') || !id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_')) {
        return Err(plugin_error("PLUGIN_INVALID", "Plugin ID contains unsupported characters."));
    }
    Ok(())
}

fn validate_install_id(id: &str) -> Result<()> {
    if Uuid::parse_str(id).is_err() { return Err(plugin_error("PLUGIN_INPUT", "Invalid plugin installation session.")); }
    Ok(())
}

fn safe_relative_path(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.len() > 240 || value.contains('\\') || value.contains('\0') || value.starts_with('/') {
        return Err(plugin_error("PLUGIN_INVALID", "Plugin paths must be relative and use forward slashes."));
    }
    let path = Path::new(value);
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(plugin_error("PLUGIN_INVALID", "Plugin paths cannot contain parent, root, or current-directory components.")),
        }
    }
    Ok(path.to_path_buf())
}

fn package_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
    #[cfg(target_os = "windows")]
    { value.to_ascii_lowercase() }
    #[cfg(not(target_os = "windows"))]
    { value }
}

fn is_version(value: &str) -> bool { parse_version(value).is_ok() }

fn parse_version(value: &str) -> Result<(u64, u64, u64)> {
    let mut parts = value.split('.');
    let a = parts.next().and_then(|v| v.parse::<u64>().ok());
    let b = parts.next().and_then(|v| v.parse::<u64>().ok());
    let c = parts.next().and_then(|v| v.parse::<u64>().ok());
    if parts.next().is_some() || a.is_none() || b.is_none() || c.is_none() { return Err(plugin_error("PLUGIN_INVALID", "Version must use major.minor.patch format.")); }
    Ok((a.unwrap(), b.unwrap(), c.unwrap()))
}

fn free_loopback_port() -> Result<u16> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|e| plugin_error("PLUGIN_RUNTIME", format!("Could not allocate a loopback port: {e}")))
}

fn resolve_command(command: &str, plugin_dir: &Path) -> Result<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() || command.contains('/') || command.contains('\\') {
        let candidate = if path.is_absolute() { path.to_path_buf() } else { plugin_dir.join(path) };
        if candidate.is_file() { return Ok(candidate); }
        return Err(plugin_error("PLUGIN_RUNTIME", "The plugin runtime command was not found."));
    }
    let path_var = std::env::var_os("PATH").ok_or_else(|| plugin_error("PLUGIN_RUNTIME", "The plugin runtime command is not available on PATH."))?;
    let mut candidates = Vec::new();
    for directory in std::env::split_paths(&path_var) {
        candidates.push(directory.join(command));
        #[cfg(windows)]
        if Path::new(command).extension().is_none() {
            for extension in [".exe", ".cmd", ".bat", ".com"] { candidates.push(directory.join(format!("{command}{extension}"))); }
        }
    }
    candidates.into_iter().find(|candidate| candidate.is_file()).ok_or_else(|| plugin_error("PLUGIN_RUNTIME", "The plugin runtime command was not found on PATH."))
}

fn health_check(port: u16, health: &str) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT) else { return false; };
    let _ = stream.set_read_timeout(Some(HEALTH_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HEALTH_TIMEOUT));
    let request = format!("GET {health} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() { return false; }
    let mut buffer = [0u8; 4096];
    let Ok(size) = stream.read(&mut buffer) else { return false; };
    let first_line = String::from_utf8_lossy(&buffer[..size]).lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let _version = parts.next();
    matches!(parts.next().and_then(|value| value.parse::<u16>().ok()), Some(200..=299))
}

fn kill_process_tree(child: &mut Child) -> io::Result<()> {
    if child.try_wait()?.is_some() { return Ok(()); }
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        let result = unsafe { libc::kill(-pid, libc::SIGKILL) };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) { return Err(error); }
        }
    }
    #[cfg(windows)]
    {
        let status = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).status()?;
        if !status.success() && child.try_wait()?.is_none() {
            return Err(io::Error::new(io::ErrorKind::Other, "taskkill could not terminate the plugin process tree"));
        }
    }
    Ok(())
}

fn swap_staged_plugin(dir: &Path, staging: &Path, fail_after_backup: bool) -> Result<()> {
    let backup = dir.with_file_name(format!(".backup-{}", Uuid::new_v4()));
    let had_existing = dir.exists();
    if had_existing {
        fs::rename(dir, &backup).map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not preserve the existing plugin for rollback: {e}")))?;
    }
    if fail_after_backup {
        if had_existing { let _ = fs::rename(&backup, dir); }
        return Err(plugin_error("PLUGIN_STORAGE", "Tested plugin replacement failure."));
    }
    match fs::rename(staging, dir) {
        Ok(()) => {
            if had_existing { let _ = fs::remove_dir_all(&backup); }
            Ok(())
        }
        Err(error) => {
            if had_existing { let _ = fs::rename(&backup, dir); }
            Err(plugin_error("PLUGIN_STORAGE", format!("Could not install plugin: {error}")))
        }
    }
}

fn recover_interrupted_replacements(root: &Path) -> Result<()> {
    let entries = fs::read_dir(root).map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not inspect plugin storage: {e}")))?;
    for entry in entries {
        let entry = entry.map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not inspect plugin storage: {e}")))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else { continue; };
        if !name.starts_with(".backup-") || !path.is_dir() { continue; }
        let manifest = match read_manifest(&path) { Ok(value) => value, Err(_) => { let _ = fs::remove_dir_all(&path); continue; } };
        if validate_manifest(&manifest).is_err() { let _ = fs::remove_dir_all(&path); continue; }
        let destination = root.join(&manifest.id);
        if destination.exists() { let _ = fs::remove_dir_all(&path); } else { let _ = fs::rename(&path, destination); }
    }
    Ok(())
}

fn cleanup_installing_directories(root: &Path) -> Result<()> {
    let entries = fs::read_dir(root).map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not inspect plugin storage: {e}")))?;
    for entry in entries {
        let entry = entry.map_err(|e| plugin_error("PLUGIN_STORAGE", format!("Could not inspect plugin storage: {e}")))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else { continue; };
        if name.starts_with(".installing-") { let _ = fs::remove_dir_all(path); }
    }
    Ok(())
}

fn plugin_error(code: &str, message: impl Into<String>) -> AppError {
    let message = message.into();
    AppError::new(code, &message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    fn manifest(id: &str) -> PluginManifest {
        PluginManifest {
            schema: "tracefold.plugin.v1".into(),
            id: id.into(),
            name: "Test Plugin".into(),
            version: "1.0.0".into(),
            publisher: "Tracefold Tests".into(),
            description: String::new(),
            api_version: 1,
            min_tracefold_version: "0.2.0".into(),
            runtime: RuntimeManifest {
                kind: "loopback-web".into(),
                entry: "run.py".into(),
                command: "python".into(),
                args: vec!["run.py".into(), "--port".into(), "{port}".into()],
                health: "/api/health".into(),
                bind: "127.0.0.1".into(),
            },
            capabilities: vec!["network.targeted-http".into()],
        }
    }

    #[test]
    fn rejects_reserved_plugin_ids() {
        for id in [".", "..", ".hidden", "trailing."] {
            assert!(validate_id(id).is_err(), "expected {id} to be rejected");
        }
    }

    #[test]
    fn validates_manifest_and_entrypoint() {
        let value = manifest("example.plugin");
        assert!(validate_manifest(&value).is_ok());
        let mut invalid = value.clone();
        invalid.runtime.command = "   ".into();
        assert!(validate_manifest(&invalid).is_err());
        invalid = value.clone();
        invalid.runtime.bind = "0.0.0.0".into();
        assert!(validate_manifest(&invalid).is_err());
    }

    #[test]
    fn installation_rejects_traversal_and_duplicates() {
        let runtime = PluginRuntime::open(tempdir().unwrap().keep().unwrap()).unwrap();
        let install = runtime.begin_install().unwrap();
        assert!(runtime.append_install_file(&install, "../evil.txt", b"x".to_vec()).is_err());
        runtime.append_install_file(&install, "manifest.json", serde_json::to_vec(&manifest("example.plugin")).unwrap()).unwrap();
        assert!(runtime.append_install_file(&install, "manifest.json", b"duplicate".to_vec()).is_err());
        runtime.abort_install(&install).unwrap();
    }

    #[test]
    fn package_file_limit_is_enforced_before_write() {
        let runtime = PluginRuntime::open(tempdir().unwrap().keep().unwrap()).unwrap();
        let install = runtime.begin_install().unwrap();
        let data = vec![0u8; MAX_FILE_BYTES];
        runtime.append_install_file(&install, "large.bin", data).unwrap();
        assert!(runtime.append_install_file(&install, "too-large.bin", vec![0u8; MAX_FILE_BYTES + 1]).is_err());
        runtime.abort_install(&install).unwrap();
    }

    #[test]
    fn replacement_failure_restores_existing_plugin() {
        let root = tempdir().unwrap();
        let destination = root.path().join("example.plugin");
        let staging = root.path().join(".installing-test");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("manifest.json"), serde_json::to_vec(&manifest("example.plugin")).unwrap()).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("manifest.json"), serde_json::to_vec(&manifest("example.plugin")).unwrap()).unwrap();
        assert!(swap_staged_plugin(&destination, &staging, true).is_err());
        assert!(destination.join("manifest.json").is_file());
        assert!(staging.is_dir());
    }

    #[test]
    fn reap_dead_child_removes_runtime_state() {
        let root = tempdir().unwrap();
        let runtime = PluginRuntime::open(root.path().to_path_buf()).unwrap();
        let child = Command::new(std::env::current_exe().unwrap()).arg("--help").spawn().unwrap();
        runtime.running.lock().unwrap().insert("example.plugin".into(), RunningPlugin { child, port: 1 });
        std::thread::sleep(Duration::from_millis(100));
        runtime.reap_dead().unwrap();
        assert!(!runtime.running.lock().unwrap().contains_key("example.plugin"));
    }
}
