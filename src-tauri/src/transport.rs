use crate::error::{AppError, Result};
use tauri::ipc::{InvokeBody, Request};
pub fn header(request: &Request<'_>, name: &str) -> Result<String> {
    let value = request
        .headers()
        .get(name)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| AppError::invalid("headers", "Missing binary transfer metadata."))?;
    if value.len() > 4096 {
        return Err(AppError::invalid(
            "headers",
            "Transfer metadata is too long.",
        ));
    }
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .map(|v| v.into_owned())
        .map_err(|_| AppError::invalid("headers", "Invalid transfer metadata."))
}
pub fn bytes(request: &Request<'_>, maximum: u64) -> Result<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() as u64 <= maximum => Ok(bytes.clone()),
        InvokeBody::Raw(_) => Err(AppError::new(
            "LIMIT_EXCEEDED",
            "The file exceeds the supported transfer size.",
        )),
        _ => Err(AppError::invalid(
            "body",
            "File transfers require a binary body.",
        )),
    }
}
