use serde::Serialize;
use std::collections::BTreeMap;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_errors: Option<BTreeMap<String, String>>,
}
impl AppError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            field_errors: None,
        }
    }
    pub fn invalid(field: &str, message: &str) -> Self {
        Self {
            field_errors: Some([(field.into(), message.into())].into()),
            ..Self::new("VALIDATION", message)
        }
    }
    pub fn conflict() -> Self {
        Self::new(
            "CONFLICT",
            "This item changed. Reload its current revision before saving.",
        )
    }
    pub fn missing() -> Self {
        Self::new(
            "NOT_FOUND",
            "The requested item does not exist in this project.",
        )
    }
    pub fn integrity() -> Self {
        Self::new("INTEGRITY", "Stored data failed integrity verification. Keep the originals and restore a verified backup.")
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind;
        match e.kind() {
            ErrorKind::NotFound => Self::missing(),
            ErrorKind::PermissionDenied => Self::new("PERMISSION_DENIED", "Storage access was denied."),
            ErrorKind::StorageFull => Self::new("STORAGE_FULL", "The storage device is full. Free space before retrying."),
            _ => Self::new("IO", "The local storage operation failed. The operation may need recovery before retrying."),
        }
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(ref failure, _) = e {
            use rusqlite::ErrorCode;
            return match failure.code {
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => Self {
                    retryable: true,
                    ..Self::new("BUSY", "Storage is busy. Retry shortly.")
                },
                ErrorCode::DiskFull => Self::new("STORAGE_FULL", "The storage device is full."),
                ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => Self::integrity(),
                ErrorCode::ReadOnly | ErrorCode::PermissionDenied => {
                    Self::new("PERMISSION_DENIED", "Database access was denied.")
                }
                ErrorCode::ConstraintViolation => Self::new(
                    "INTEGRITY",
                    "A database integrity constraint rejected this operation.",
                ),
                _ => Self::new("DATABASE", "The database operation failed."),
            };
        }
        Self::new("DATABASE", "The database operation failed.")
    }
}
impl From<serde_json::Error> for AppError {
    fn from(_: serde_json::Error) -> Self {
        Self::new(
            "INVALID_DATA",
            "The data does not match the supported schema.",
        )
    }
}
