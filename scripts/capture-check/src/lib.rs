#![allow(dead_code)]
mod error {
    pub type Result<T> = std::result::Result<T, AppError>;
    #[derive(Debug)]
    pub struct AppError { pub code: String, pub message: String }
    impl AppError { pub fn new(code: &str, message: &str) -> Self { Self { code: code.into(), message: message.into() } } }
    impl From<std::io::Error> for AppError { fn from(_: std::io::Error) -> Self { Self::new("IO", "IO") } }
}
mod files { pub const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024; }
mod model { pub struct CaptureCapabilities { pub supported: bool, pub targets: Vec<String>, pub permission: String, pub reason: String } }
#[path = "../../../src-tauri/src/capture.rs"]
mod capture;
