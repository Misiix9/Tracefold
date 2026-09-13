//! Plugin catalog: a signed-free, checksum-verified index of installable plugin packages.
//!
//! The frontend never supplies a download URL. It asks for an `id` and `version`, and the
//! host resolves both against the catalog it fetched itself, so a compromised webview cannot
//! point the installer at an arbitrary host. Every package is verified against the SHA-256
//! recorded in the catalog before a single byte reaches plugin storage, and the manifest
//! inside the package must agree with the catalog entry that advertised it.

use crate::error::{AppError, Result};
use crate::plugin_manager::{self, PluginRuntime, MAX_PACKAGE_BYTES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The public catalog that ships with Tracefold. Overridable per install so a team can
/// point at its own reviewed catalog without waiting for an application release.
pub const DEFAULT_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/Misiix9/Tracefold/main/catalog/catalog.json";

const CATALOG_SCHEMA: &str = "tracefold.catalog.v1";
const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;
const MAX_PLUGINS: usize = 500;
const MAX_VERSIONS: usize = 100;
const MAX_URL_LEN: usize = 500;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(900);
const USER_AGENT: &str = concat!("Tracefold/", env!("CARGO_PKG_VERSION"), " (plugin catalog)");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogIndex {
    pub schema: String,
    #[serde(default)]
    pub updated: String,
    pub plugins: Vec<CatalogPlugin>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    pub id: String,
    pub name: String,
    pub publisher: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub homepage: String,
    pub versions: Vec<CatalogVersion>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVersion {
    pub version: String,
    pub api_version: u32,
    pub min_tracefold_version: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub published: String,
    #[serde(default)]
    pub notes: String,
}

/// What the plugin browser renders: catalog metadata already reconciled against what is
/// installed, so the UI never has to compare versions itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub description: String,
    pub category: String,
    pub homepage: String,
    pub latest: Option<CatalogVersion>,
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub compatible: bool,
    /// Why no version of this plugin can run on this build, when none can.
    pub incompatible_reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResult {
    pub source: String,
    pub updated: String,
    pub entries: Vec<CatalogEntry>,
}

pub struct CatalogService {
    plugins: Arc<PluginRuntime>,
    /// Where to read a catalog override from. Host-owned: a file Tracefold placed in its
    /// own application data directory, never anything the webview supplies.
    root: PathBuf,
    /// The last successfully fetched index. Installs resolve URLs from here, never from
    /// anything the webview passes in.
    cached: Mutex<Option<CatalogIndex>>,
}

impl CatalogService {
    pub fn new(plugins: Arc<PluginRuntime>, root: PathBuf) -> Self {
        Self {
            plugins,
            root,
            cached: Mutex::new(None),
        }
    }

    pub async fn fetch(&self) -> Result<CatalogResult> {
        let url = self.source()?;
        let body = fetch_bytes(&url, MAX_INDEX_BYTES, REQUEST_TIMEOUT).await?;
        let index: CatalogIndex = serde_json::from_slice(&body)
            .map_err(|e| catalog_error("CATALOG_INVALID", format!("The plugin catalog is not valid JSON: {e}")))?;
        validate_index(&index)?;
        let result = self.reconcile(&url, &index)?;
        *self
            .cached
            .lock()
            .map_err(|_| catalog_error("CATALOG_UNAVAILABLE", "The plugin catalog state is unavailable."))? = Some(index);
        Ok(result)
    }

    /// Resolve `id`/`version` against the cached catalog, download, verify and install.
    pub async fn install(&self, id: &str, version: &str) -> Result<crate::plugin_manager::PluginInfo> {
        let entry = self.resolve(id, version)?;
        let bytes = fetch_bytes(&entry.url, MAX_PACKAGE_BYTES as usize, DOWNLOAD_TIMEOUT).await?;
        verify_checksum(&bytes, &entry.sha256)?;
        let plugins = Arc::clone(&self.plugins);
        let expected_id = id.to_string();
        let expected_version = entry.version.clone();
        tauri::async_runtime::spawn_blocking(move || {
            plugin_manager::install_package_bytes(&plugins, &bytes, Some((&expected_id, &expected_version)))
        })
        .await
        .map_err(|_| catalog_error("CATALOG_UNAVAILABLE", "The plugin installer stopped unexpectedly."))?
    }

    fn resolve(&self, id: &str, version: &str) -> Result<CatalogVersion> {
        let cached = self
            .cached
            .lock()
            .map_err(|_| catalog_error("CATALOG_UNAVAILABLE", "The plugin catalog state is unavailable."))?;
        let index = cached
            .as_ref()
            .ok_or_else(|| catalog_error("CATALOG_UNAVAILABLE", "Refresh the plugin catalog before installing."))?;
        let plugin = index
            .plugins
            .iter()
            .find(|plugin| plugin.id == id)
            .ok_or_else(|| catalog_error("CATALOG_NOT_FOUND", "That plugin is not in the current catalog."))?;
        let entry = plugin
            .versions
            .iter()
            .find(|candidate| candidate.version == version)
            .ok_or_else(|| catalog_error("CATALOG_NOT_FOUND", "That plugin version is not in the current catalog."))?;
        compatibility(entry)?;
        Ok(entry.clone())
    }

    fn reconcile(&self, source: &str, index: &CatalogIndex) -> Result<CatalogResult> {
        let installed = self.plugins.list()?;
        let mut entries = Vec::with_capacity(index.plugins.len());
        for plugin in &index.plugins {
            let installed_version = installed
                .iter()
                .find(|candidate| candidate.id == plugin.id)
                .map(|candidate| candidate.version.clone());
            let mut newest: Option<&CatalogVersion> = None;
            let mut reason = String::new();
            for candidate in &plugin.versions {
                match compatibility(candidate) {
                    Ok(()) => {
                        if newest.is_none_or(|current| {
                            plugin_manager::compare_versions(&candidate.version, &current.version).is_gt()
                        }) {
                            newest = Some(candidate);
                        }
                    }
                    Err(error) if reason.is_empty() => reason = error.message.clone(),
                    Err(_) => {}
                }
            }
            let update_available = match (&installed_version, newest) {
                (Some(installed), Some(latest)) => {
                    plugin_manager::compare_versions(&latest.version, installed).is_gt()
                }
                _ => false,
            };
            entries.push(CatalogEntry {
                id: plugin.id.clone(),
                name: plugin.name.clone(),
                publisher: plugin.publisher.clone(),
                description: plugin.description.clone(),
                category: plugin.category.clone(),
                homepage: plugin.homepage.clone(),
                latest: newest.cloned(),
                installed_version,
                update_available,
                compatible: newest.is_some(),
                incompatible_reason: if newest.is_some() { String::new() } else { reason },
            });
        }
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(CatalogResult {
            source: source.to_string(),
            updated: index.updated.clone(),
            entries,
        })
    }
}

/// Only absolute HTTPS URLs are accepted, for the catalog itself and for every package it
/// advertises. A catalog that downgrades to plain HTTP is rejected rather than trusted.
fn validate_https_url(value: &str, what: &str) -> Result<()> {
    if value.len() > MAX_URL_LEN {
        return Err(catalog_error("CATALOG_INVALID", format!("The {what} URL is too long.")));
    }
    let parsed = reqwest::Url::parse(value)
        .map_err(|_| catalog_error("CATALOG_INVALID", format!("The {what} URL is not a valid absolute URL.")))?;
    if parsed.scheme() != "https" {
        return Err(catalog_error("CATALOG_INVALID", format!("The {what} URL must use HTTPS.")));
    }
    if !parsed.has_host() {
        return Err(catalog_error("CATALOG_INVALID", format!("The {what} URL has no host.")));
    }
    Ok(())
}

fn normalize_source(source: Option<String>) -> Result<String> {
    let value = source
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CATALOG_URL.to_string());
    validate_https_url(&value, "plugin catalog")?;
    Ok(value)
}

impl CatalogService {
    /// The catalog address, in order: the `TRACEFOLD_PLUGIN_CATALOG` environment variable,
    /// then a `catalog-source` file in Tracefold's own plugin storage, then the shipped
    /// default.
    ///
    /// Deliberately never a value from the webview. Checksum verification only proves a
    /// package matches the catalog that advertised it, so whoever chooses the catalog
    /// chooses what is trusted — that decision belongs to the host and the person at the
    /// keyboard, not to a page.
    fn source(&self) -> Result<String> {
        if let Ok(value) = std::env::var("TRACEFOLD_PLUGIN_CATALOG") {
            return normalize_source(Some(value));
        }
        let configured = std::fs::read_to_string(self.root.join("catalog-source"))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        normalize_source(configured)
    }
}

fn validate_index(index: &CatalogIndex) -> Result<()> {
    if index.schema != CATALOG_SCHEMA {
        return Err(catalog_error("CATALOG_INVALID", "Unsupported plugin catalog schema."));
    }
    if index.plugins.len() > MAX_PLUGINS {
        return Err(catalog_error("CATALOG_INVALID", "The plugin catalog lists too many plugins."));
    }
    if index.updated.len() > 64 {
        return Err(catalog_error("CATALOG_INVALID", "The plugin catalog timestamp is invalid."));
    }
    let mut seen = HashSet::new();
    for plugin in &index.plugins {
        plugin_manager::validate_plugin_id(&plugin.id)?;
        if !seen.insert(plugin.id.as_str()) {
            return Err(catalog_error("CATALOG_INVALID", "The plugin catalog lists the same plugin twice."));
        }
        if plugin.name.trim().is_empty() || plugin.name.len() > 120 {
            return Err(catalog_error("CATALOG_INVALID", "A catalog plugin name is invalid."));
        }
        if plugin.publisher.trim().is_empty() || plugin.publisher.len() > 120 {
            return Err(catalog_error("CATALOG_INVALID", "A catalog plugin publisher is invalid."));
        }
        if plugin.description.len() > 2000 || plugin.category.len() > 60 {
            return Err(catalog_error("CATALOG_INVALID", "A catalog plugin description or category is too long."));
        }
        if !plugin.homepage.is_empty() {
            validate_https_url(&plugin.homepage, "plugin homepage")?;
        }
        if plugin.versions.is_empty() || plugin.versions.len() > MAX_VERSIONS {
            return Err(catalog_error("CATALOG_INVALID", "A catalog plugin must list between one and 100 versions."));
        }
        let mut versions = HashSet::new();
        for entry in &plugin.versions {
            if !versions.insert(entry.version.as_str()) {
                return Err(catalog_error("CATALOG_INVALID", "A catalog plugin lists the same version twice."));
            }
            validate_version_entry(entry)?;
        }
    }
    Ok(())
}

fn validate_version_entry(entry: &CatalogVersion) -> Result<()> {
    plugin_manager::validate_version_string(&entry.version)?;
    plugin_manager::validate_version_string(&entry.min_tracefold_version)?;
    validate_https_url(&entry.url, "plugin package")?;
    if entry.sha256.len() != 64 || !entry.sha256.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(catalog_error("CATALOG_INVALID", "A catalog entry has an invalid SHA-256 checksum."));
    }
    if entry.size > MAX_PACKAGE_BYTES {
        return Err(catalog_error("CATALOG_INVALID", "A catalog entry exceeds the 256 MiB package limit."));
    }
    if entry.capabilities.len() > 64 || entry.capabilities.iter().any(|value| value.len() > 100) {
        return Err(catalog_error("CATALOG_INVALID", "A catalog entry declares unsupported capabilities."));
    }
    if entry.notes.len() > 4000 || entry.published.len() > 64 {
        return Err(catalog_error("CATALOG_INVALID", "A catalog entry has oversized release notes."));
    }
    Ok(())
}

/// A catalog may advertise versions this build cannot run. They are reported, not hidden,
/// so the browser can explain why a plugin is unavailable instead of silently omitting it.
fn compatibility(entry: &CatalogVersion) -> Result<()> {
    if entry.api_version != plugin_manager::CURRENT_PLUGIN_API_VERSION {
        return Err(catalog_error(
            "CATALOG_INCOMPATIBLE",
            "This plugin targets a different Tracefold plugin API version.",
        ));
    }
    if plugin_manager::compare_versions(&entry.min_tracefold_version, env!("CARGO_PKG_VERSION")).is_gt() {
        return Err(catalog_error(
            "CATALOG_INCOMPATIBLE",
            "This plugin requires a newer Tracefold version.",
        ));
    }
    Ok(())
}

fn verify_checksum(bytes: &[u8], expected: &str) -> Result<()> {
    let digest = Sha256::digest(bytes);
    let actual = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(catalog_error(
            "CATALOG_CHECKSUM",
            "The downloaded plugin package does not match the checksum in the catalog. It was not installed.",
        ));
    }
    Ok(())
}

async fn fetch_bytes(url: &str, limit: usize, timeout: Duration) -> Result<Vec<u8>> {
    // Mirrors the updater: the rustls provider is installed lazily and only once.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .redirect(https_only_redirects())
        .build()
        .map_err(|e| catalog_error("CATALOG_NETWORK", format!("Could not prepare the download: {e}")))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| catalog_error("CATALOG_NETWORK", format!("Could not reach the plugin catalog: {e}")))?;
    if !response.status().is_success() {
        return Err(catalog_error(
            "CATALOG_NETWORK",
            format!("The plugin catalog request failed with status {}.", response.status()),
        ));
    }
    // Trust the advertised length only to fail early; the real limit is enforced per chunk.
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(catalog_error("LIMIT_EXCEEDED", "The download exceeds its supported size limit."));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| catalog_error("CATALOG_NETWORK", format!("The download was interrupted: {e}")))?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(catalog_error("LIMIT_EXCEEDED", "The download exceeds its supported size limit."));
        }
        body.extend_from_slice(&chunk);
    }
    if body.is_empty() {
        return Err(catalog_error("CATALOG_NETWORK", "The download returned no content."));
    }
    Ok(body)
}

fn https_only_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if attempt.url().scheme() != "https" {
            attempt.error("refusing to follow a non-HTTPS redirect")
        } else {
            attempt.follow()
        }
    })
}

/// Read a `.tracefold-plugin` archive into host-owned staging without trusting any path
/// inside it. Entry names go through the same validation as the streaming installer.
pub fn extract_package(runtime: &PluginRuntime, archive: &[u8]) -> Result<String> {
    let reader = std::io::Cursor::new(archive);
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|e| catalog_error("PLUGIN_INVALID", format!("The plugin package is not a readable archive: {e}")))?;
    let install_id = runtime.begin_install()?;
    let result = (|| -> Result<()> {
        for index in 0..zip.len() {
            let mut file = zip
                .by_index(index)
                .map_err(|e| catalog_error("PLUGIN_INVALID", format!("The plugin package could not be read: {e}")))?;
            if file.is_dir() {
                continue;
            }
            // `enclosed_name` rejects absolute paths, drive prefixes and `..` traversal;
            // the installer validates the name again before touching the filesystem.
            let name = file
                .enclosed_name()
                .ok_or_else(|| catalog_error("PLUGIN_INVALID", "The plugin package contains an unsafe file path."))?
                .to_string_lossy()
                .replace('\\', "/");
            let declared = file.size();
            if declared > plugin_manager::MAX_FILE_BYTES as u64 {
                return Err(catalog_error("LIMIT_EXCEEDED", "A plugin file exceeds the 64 MiB limit."));
            }
            let mut data = Vec::with_capacity(declared.min(1024 * 1024) as usize);
            // Read one byte past the limit so a lying central directory cannot smuggle
            // an oversized file through.
            file.by_ref()
                .take(plugin_manager::MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut data)
                .map_err(|e| catalog_error("PLUGIN_INVALID", format!("The plugin package could not be read: {e}")))?;
            if data.len() > plugin_manager::MAX_FILE_BYTES {
                return Err(catalog_error("LIMIT_EXCEEDED", "A plugin file exceeds the 64 MiB limit."));
            }
            runtime.append_install_file(&install_id, &name, data)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = runtime.abort_install(&install_id);
        return Err(error);
    }
    Ok(install_id)
}

fn catalog_error(code: &str, message: impl Into<String>) -> AppError {
    let message = message.into();
    AppError::new(code, &message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(url: &str) -> CatalogVersion {
        CatalogVersion {
            version: "1.0.0".into(),
            api_version: 1,
            min_tracefold_version: "0.2.0".into(),
            url: url.into(),
            sha256: "a".repeat(64),
            size: 1024,
            capabilities: vec![],
            published: String::new(),
            notes: String::new(),
        }
    }

    fn index(url: &str) -> CatalogIndex {
        CatalogIndex {
            schema: CATALOG_SCHEMA.into(),
            updated: String::new(),
            plugins: vec![CatalogPlugin {
                id: "example.plugin".into(),
                name: "Example".into(),
                publisher: "Tracefold Tests".into(),
                description: String::new(),
                category: String::new(),
                homepage: String::new(),
                versions: vec![version(url)],
            }],
        }
    }

    #[test]
    fn rejects_plain_http_and_relative_package_urls() {
        assert!(validate_index(&index("http://example.com/a.tracefold-plugin")).is_err());
        assert!(validate_index(&index("/a.tracefold-plugin")).is_err());
        assert!(validate_index(&index("file:///etc/passwd")).is_err());
        assert!(validate_index(&index("https://example.com/a.tracefold-plugin")).is_ok());
    }

    #[test]
    fn rejects_unsupported_schema_and_duplicate_ids() {
        let mut value = index("https://example.com/a.tracefold-plugin");
        value.schema = "tracefold.catalog.v2".into();
        assert!(validate_index(&value).is_err());

        let mut duplicated = index("https://example.com/a.tracefold-plugin");
        duplicated.plugins.push(duplicated.plugins[0].clone());
        assert!(validate_index(&duplicated).is_err());
    }

    #[test]
    fn rejects_malformed_checksums() {
        let mut value = index("https://example.com/a.tracefold-plugin");
        value.plugins[0].versions[0].sha256 = "not-a-checksum".into();
        assert!(validate_index(&value).is_err());
        value.plugins[0].versions[0].sha256 = "a".repeat(63);
        assert!(validate_index(&value).is_err());
    }

    #[test]
    fn checksum_mismatch_is_rejected_before_installation() {
        let payload = b"plugin package";
        let digest = Sha256::digest(payload);
        let correct = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        assert!(verify_checksum(payload, &correct).is_ok());
        assert!(verify_checksum(payload, &correct.to_uppercase()).is_ok());
        assert!(verify_checksum(payload, &"b".repeat(64)).is_err());
        assert!(verify_checksum(b"tampered", &correct).is_err());
    }

    #[test]
    fn incompatible_versions_are_reported_rather_than_installed() {
        let mut future = version("https://example.com/a.tracefold-plugin");
        future.min_tracefold_version = "99.0.0".into();
        assert!(compatibility(&future).is_err());

        let mut other_api = version("https://example.com/a.tracefold-plugin");
        other_api.api_version = 99;
        assert!(compatibility(&other_api).is_err());

        assert!(compatibility(&version("https://example.com/a.tracefold-plugin")).is_ok());
    }

    /// The catalog this repository publishes must always satisfy the parser that will
    /// read it. A malformed entry would otherwise only surface in a shipped build.
    #[test]
    fn the_published_catalog_is_valid_and_installable() {
        const PUBLISHED: &str = include_str!("../../catalog/catalog.json");
        let index: CatalogIndex = serde_json::from_str(PUBLISHED).expect("catalog.json must parse");
        validate_index(&index).expect("catalog.json must satisfy the host's validation");
        assert!(!index.plugins.is_empty(), "the catalog should list at least one plugin");
        for plugin in &index.plugins {
            for entry in &plugin.versions {
                assert!(entry.url.starts_with("https://"), "{} must be served over HTTPS", entry.url);
                assert_eq!(entry.sha256.len(), 64);
                assert!(entry.size > 0, "a catalog entry must record its package size");
            }
        }
    }

    #[test]
    fn source_falls_back_to_the_shipped_catalog_and_rejects_insecure_overrides() {
        assert_eq!(normalize_source(None).unwrap(), DEFAULT_CATALOG_URL);
        assert_eq!(normalize_source(Some("   ".into())).unwrap(), DEFAULT_CATALOG_URL);
        assert!(normalize_source(Some("http://example.com/catalog.json".into())).is_err());
        assert!(normalize_source(Some("javascript:alert(1)".into())).is_err());
        assert_eq!(
            normalize_source(Some("https://example.com/catalog.json".into())).unwrap(),
            "https://example.com/catalog.json"
        );
    }

    /// Whoever chooses the catalog chooses what is trusted, because a checksum only proves
    /// a package matches the catalog that advertised it. The address must therefore come
    /// from host-owned configuration and never from the webview.
    #[test]
    fn the_catalog_address_comes_from_host_configuration_only() {
        let root = tempfile::tempdir().unwrap();
        let service = CatalogService::new(
            Arc::new(PluginRuntime::open(root.path().join("plugins")).unwrap()),
            root.path().to_path_buf(),
        );
        assert_eq!(service.source().unwrap(), DEFAULT_CATALOG_URL);

        std::fs::write(root.path().join("catalog-source"), "  https://example.com/own.json \n").unwrap();
        assert_eq!(service.source().unwrap(), "https://example.com/own.json");

        // An override still has to be a real HTTPS address.
        std::fs::write(root.path().join("catalog-source"), "http://example.com/own.json").unwrap();
        assert!(service.source().is_err());

        // An empty file falls back rather than failing.
        std::fs::write(root.path().join("catalog-source"), "\n  \n").unwrap();
        assert_eq!(service.source().unwrap(), DEFAULT_CATALOG_URL);
    }
}
