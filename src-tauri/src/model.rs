use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prefix: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
    pub revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entity {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub body: Value,
    pub tags: Vec<String>,
    pub data: Value,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordQuery {
    pub project_id: String,
    pub kind: Option<String>,
    pub search: Option<String>,
    #[serde(default)]
    pub include_deleted: bool,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    pub entity_id: String,
    pub revision: u64,
    pub at: String,
    pub title: String,
    pub entity: Entity,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    #[serde(default = "default_language")]
    pub language: String,
    pub theme: String,
    pub density: String,
    pub editor_font_size: u32,
    pub last_project_id: Option<String>,
    pub last_view: String,
    pub onboarding_complete: bool,
    pub author: String,
    pub page_size: String,
    pub backup_enabled: bool,
    pub shortcuts: BTreeMap<String, String>,
}
fn default_language() -> String {
    "hu".into()
}
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: "hu".into(),
            theme: "system".into(),
            density: "comfortable".into(),
            editor_font_size: 15,
            last_project_id: None,
            last_view: "notebook".into(),
            onboarding_complete: false,
            author: String::new(),
            page_size: "A4".into(),
            backup_enabled: true,
            shortcuts: BTreeMap::new(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupInfo {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub created_at: String,
    pub size: u64,
    pub valid: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub location: String,
    pub database_bytes: u64,
    pub asset_bytes: u64,
    pub backup_bytes: u64,
    pub project_count: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCapabilities {
    pub supported: bool,
    pub targets: Vec<String>,
    pub permission: String,
    pub reason: String,
}
pub fn capture_capabilities() -> CaptureCapabilities {
    crate::capture::capabilities()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
