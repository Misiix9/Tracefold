use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_FILES: usize = 2_000;
const MAX_TOTAL_BYTES: usize = 256 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;

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
    #[serde(default)]
    pub api_version: u32,
    #[serde(default)]
    pub min_tracefold_version: String,
    pub runtime: PluginRuntimeManifest,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuntimeManifest {
    #[serde(rename = "type")]
    pub kind: String,
    pub entry: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_bind")]
    pub bind: String,
    #[serde(default)]
    pub health: String,
}

fn default_bind() -> String { "127.0.0.1".to_string() }

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

#[derive(Debug, Clone, Deserialize)]
pub struct PluginFile {
    pub path: String,
    pub data: Vec<u8>,
}

pub struct PluginRuntime {
    root: PathBuf,
    running: Mutex<HashMap<String, Child>>,
}

impl PluginRuntime {
    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not create plugin storage: {e}")))?;
        Ok(Self { root, running: Mutex::new(HashMap::new()) })
    }

    fn plugin_dir(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        Ok(self.root.join(id))
    }

    fn manifest_path(&self, id: &str) -> Result<PathBuf> { Ok(self.plugin_dir(id)?.join("manifest.json")) }

    fn read_manifest(&self, id: &str) -> Result<PluginManifest> {
        let path = self.manifest_path(id)?;
        let bytes = fs::read(&path).map_err(|_| AppError::new("PLUGIN_NOT_FOUND", "Plugin is not installed."))?;
        serde_json::from_slice(&bytes).map_err(|_| AppError::new("PLUGIN_INVALID", "Plugin manifest is invalid."))
    }

    fn enabled_path(&self, id: &str) -> Result<PathBuf> { Ok(self.plugin_dir(id)?.join("disabled")) }

    fn data_dir(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        let root = self.root.parent().ok_or_else(|| AppError::new("PLUGIN_STORAGE", "Plugin storage has no parent directory."))?;
        Ok(root.join("plugin-data").join(id))
    }

    fn is_enabled(&self, id: &str) -> Result<bool> { Ok(!self.enabled_path(id)?.exists()) }

    pub fn list(&self) -> Result<Vec<PluginInfo>> {
        let mut out = Vec::new();
        let entries = fs::read_dir(&self.root).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not read plugin storage: {e}")))?;
        let running = self.running.lock().map_err(|_| AppError::new("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() { continue; }
            let Some(id) = path.file_name().and_then(|s| s.to_str()) else { continue; };
            let Ok(manifest) = self.read_manifest(id) else { continue; };
            let is_running = running.contains_key(id);
            let url = if is_running { read_runtime_url(&path) } else { None };
            out.push(PluginInfo {
                id: manifest.id,
                name: manifest.name,
                version: manifest.version,
                publisher: manifest.publisher,
                description: manifest.description,
                api_version: manifest.api_version,
                min_tracefold_version: manifest.min_tracefold_version,
                capabilities: manifest.capabilities,
                enabled: self.is_enabled(id)?,
                running: is_running,
                url,
            });
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        let path = self.enabled_path(id)?;
        if !self.manifest_path(id)?.exists() { return Err(AppError::new("PLUGIN_NOT_FOUND", "Plugin is not installed.")); }
        if enabled {
            let _ = fs::remove_file(path);
        } else {
            fs::write(path, b"disabled\n").map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not disable plugin: {e}")))?;
            self.stop(id)?;
        }
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        self.stop(id)?;
        let dir = self.plugin_dir(id)?;
        if !dir.exists() { return Err(AppError::new("PLUGIN_NOT_FOUND", "Plugin is not installed.")); }
        fs::remove_dir_all(dir).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not remove plugin: {e}")))
    }

    pub fn install_files(&self, files: Vec<PluginFile>) -> Result<PluginInfo> {
        if files.is_empty() || files.len() > MAX_FILES { return Err(AppError::new("PLUGIN_LIMIT", "Plugin package contains an invalid number of files.")); }
        let total = files.iter().try_fold(0usize, |sum, file| {
            if file.data.len() > MAX_FILE_BYTES { return Err(AppError::new("PLUGIN_LIMIT", "A plugin file is too large.")); }
            sum.checked_add(file.data.len()).ok_or_else(|| AppError::new("PLUGIN_LIMIT", "Plugin package is too large."))
        })?;
        if total > MAX_TOTAL_BYTES { return Err(AppError::new("PLUGIN_LIMIT", "Plugin package exceeds 256 MiB.")); }
        let manifest_file = files.iter().find(|f| f.path == "manifest.json").ok_or_else(|| AppError::new("PLUGIN_INVALID", "Plugin package must contain manifest.json at its root."))?;
        let manifest: PluginManifest = serde_json::from_slice(&manifest_file.data).map_err(|_| AppError::new("PLUGIN_INVALID", "Plugin manifest is invalid JSON."))?;
        validate_manifest(&manifest)?;
        if !files.iter().any(|file| file.path == manifest.runtime.entry) { return Err(AppError::new("PLUGIN_INVALID", "The plugin entrypoint is missing from the package.")); }
        let dir = self.plugin_dir(&manifest.id)?;
        let staging = self.root.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&staging).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not create staging directory: {e}")))?;
        let result = (|| {
            for file in files {
                let relative = safe_relative_path(&file.path)?;
                let destination = staging.join(&relative);
                if !destination.starts_with(&staging) { return Err(AppError::new("PLUGIN_INVALID", "Plugin contains an unsafe path.")); }
                if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not create plugin directory: {e}")))?; }
                let temp = destination.with_extension("tracefold-part");
                let mut handle = fs::File::create(&temp).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not write plugin file: {e}")))?;
                handle.write_all(&file.data).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not write plugin file: {e}")))?;
                handle.sync_all().ok();
                fs::rename(temp, destination).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not finalize plugin file: {e}")))?;
            }
            self.stop(&manifest.id)?;
            if dir.exists() { fs::remove_dir_all(&dir).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not replace existing plugin: {e}")))?; }
            fs::rename(&staging, &dir).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not install plugin: {e}")))?;
            self.info(&manifest.id)
        })();
        if result.is_err() { let _ = fs::remove_dir_all(&staging); }
        result
    }

    fn info(&self, id: &str) -> Result<PluginInfo> {
        let manifest = self.read_manifest(id)?;
        let running = self.running.lock().map_err(|_| AppError::new("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?.contains_key(id);
        Ok(PluginInfo {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            publisher: manifest.publisher,
            description: manifest.description,
            api_version: manifest.api_version,
            min_tracefold_version: manifest.min_tracefold_version,
            capabilities: manifest.capabilities,
            enabled: self.is_enabled(id)?,
            running,
            url: if running { read_runtime_url(&self.plugin_dir(id)?) } else { None },
        })
    }

    pub fn start(&self, id: &str) -> Result<String> {
        if !self.is_enabled(id)? { return Err(AppError::new("PLUGIN_DISABLED", "Enable the plugin before opening it.")); }
        {
            let running = self.running.lock().map_err(|_| AppError::new("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?;
            if running.contains_key(id) {
                if let Some(url) = read_runtime_url(&self.plugin_dir(id)?) { return Ok(url); }
            }
        }
        let manifest = self.read_manifest(id)?;
        if manifest.runtime.kind != "loopback-web" { return Err(AppError::new("PLUGIN_RUNTIME", "Only loopback-web plugins are supported by this host version.")); }
        let port = free_port()?;
        let dir = self.plugin_dir(id)?;
        let data_dir = self.data_dir(id)?;
        fs::create_dir_all(&data_dir).map_err(|e| AppError::new("PLUGIN_STORAGE", format!("Could not create plugin data directory: {e}")))?;
        let args = manifest.runtime.args.iter().map(|arg| substitute(arg, port, &dir, &data_dir)).collect::<Vec<_>>();
        let command = resolve_command(&manifest.runtime.command);
        let mut child = Command::new(&command);
        child.args(args).current_dir(&dir).env("TRACEFOLD_PLUGIN_ID", &manifest.id).env("TRACEFOLD_PLUGIN_DATA_DIR", &data_dir).env("TRACEFOLD_PLUGIN_PORT", port.to_string()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let process = child.spawn().map_err(|e| AppError::new("PLUGIN_START", format!("Could not start plugin runtime: {e}")))?;
        let url = format!("http://127.0.0.1:{port}");
        fs::write(dir.join("runtime.json"), serde_json::json!({"port": port, "url": url}).to_string()).ok();
        self.running.lock().map_err(|_| AppError::new("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?.insert(id.to_string(), process);
        for _ in 0..1200 {
            let address = format!("127.0.0.1:{port}").parse().map_err(|_| AppError::new("PLUGIN_RUNTIME", "Invalid plugin address."))?;
            if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() { return Ok(url); }
            std::thread::sleep(Duration::from_millis(100));
        }
        self.stop(id)?;
        Err(AppError::new("PLUGIN_START", "Plugin started but did not open its local web port in time."))
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        let mut running = self.running.lock().map_err(|_| AppError::new("PLUGIN_RUNTIME", "Plugin runtime state is unavailable."))?;
        if let Some(mut child) = running.remove(id) { let _ = child.kill(); let _ = child.wait(); }
        let _ = fs::remove_file(self.plugin_dir(id)?.join("runtime.json"));
        Ok(())
    }

    pub fn info_for_title(&self, id: &str) -> Result<String> { Ok(self.read_manifest(id)?.name) }

    pub fn stop_all(&self) {
        if let Ok(mut running) = self.running.lock() {
            for (_, mut child) in running.drain() { let _ = child.kill(); let _ = child.wait(); }
        }
    }
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_')) { return Err(AppError::new("PLUGIN_INVALID", "Plugin ID contains unsupported characters.")); }
    Ok(())
}

fn validate_manifest(manifest: &PluginManifest) -> Result<()> {
    if manifest.schema != "tracefold.plugin.v1" { return Err(AppError::new("PLUGIN_INVALID", "Unsupported plugin manifest schema.")); }
    validate_id(&manifest.id)?;
    if manifest.name.trim().is_empty() || manifest.name.len() > 200 { return Err(AppError::new("PLUGIN_INVALID", "Plugin name is invalid.")); }
    if manifest.version.trim().is_empty() || manifest.version.len() > 64 { return Err(AppError::new("PLUGIN_INVALID", "Plugin version is invalid.")); }
    if manifest.runtime.kind != "loopback-web" { return Err(AppError::new("PLUGIN_INVALID", "Unsupported plugin runtime type.")); }
    safe_relative_path(&manifest.runtime.entry)?;
    if manifest.runtime.command.len() > 100 { return Err(AppError::new("PLUGIN_INVALID", "Plugin runtime command is too long.")); }
    Ok(())
}

fn safe_relative_path(value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    if value.is_empty() || path.is_absolute() || value.contains('\\') { return Err(AppError::new("PLUGIN_INVALID", "Plugin paths must be relative and use '/'.")); }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(AppError::new("PLUGIN_INVALID", "Plugin contains an unsafe path.")),
        }
    }
    Ok(path.to_path_buf())
}

fn free_port() -> Result<u16> {
    TcpListener::bind("127.0.0.1:0").and_then(|listener| listener.local_addr()).map(|a| a.port()).map_err(|e| AppError::new("PLUGIN_RUNTIME", format!("Could not allocate a local plugin port: {e}")))
}

fn substitute(value: &str, port: u16, dir: &Path, data_dir: &Path) -> String {
    value.replace("{port}", &port.to_string()).replace("{pluginDir}", &dir.to_string_lossy()).replace("{dataDir}", &data_dir.to_string_lossy())
}

fn resolve_command(command: &str) -> String {
    if command == "python" {
        if cfg!(target_os = "windows") { "python".to_string() } else { "python3".to_string() }
    } else { command.to_string() }
}

fn read_runtime_url(dir: &Path) -> Option<String> {
    let bytes = fs::read(dir.join("runtime.json")).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()?.get("url")?.as_str().map(ToOwned::to_owned)
}

pub fn pick_plugin_archive(app: &AppHandle) -> Result<Vec<u8>> {
    let selected = app.dialog().file().add_filter("Tracefold plugin", &["tracefold-plugin", "zip"]).blocking_pick_file();
    let Some(selected) = selected else { return Err(AppError::new("CANCELLED", "Plugin installation was cancelled.")); };
    let path = selected.into_path().map_err(|_| AppError::new("PLUGIN_INPUT", "Choose a local plugin package."))?;
    let bytes = fs::read(&path).map_err(|e| AppError::new("PLUGIN_INPUT", format!("Could not read plugin package: {e}")))?;
    if bytes.len() > MAX_TOTAL_BYTES { return Err(AppError::new("PLUGIN_LIMIT", "Plugin package exceeds 256 MiB.")); }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::safe_relative_path;

    #[test]
    fn rejects_parent_traversal() {
        assert!(safe_relative_path("../evil").is_err());
        assert!(safe_relative_path("safe/file.txt").is_ok());
    }
}
