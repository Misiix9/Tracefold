//! User-initiated native capture. No workspace, renderer paths, shell, or network.
//!
//! Both entry points are blocking: call them on a worker WITHOUT the database
//! mutex. See docs/CAPTURE.md for the command/storage integration contract.
use crate::{
    error::{AppError, Result},
    model::CaptureCapabilities,
};
use std::sync::atomic::{AtomicBool, Ordering};

static CAPTURING: AtomicBool = AtomicBool::new(false);
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

struct CaptureGuard;
impl CaptureGuard {
    fn acquire() -> Result<Self> {
        CAPTURING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| AppError::new("CAPTURE_BUSY", "A screenshot chooser is already open. Finish or cancel it before capturing again."))?;
        Ok(Self)
    }
}
impl Drop for CaptureGuard {
    fn drop(&mut self) {
        CAPTURING.store(false, Ordering::Release);
    }
}

/// Read-only, never prompts for permission or takes a screenshot.
pub fn capabilities() -> CaptureCapabilities {
    platform::capabilities()
}

/// Opens the OS chooser only in response to an explicit Capture action.
/// `None` means no image was returned; it must not create an evidence record.
pub fn capture_png(language: &str) -> Result<Option<Vec<u8>>> {
    let _guard = CaptureGuard::acquire()?;
    #[cfg(target_os = "windows")]
    let image = platform::capture(language)?;
    #[cfg(not(target_os = "windows"))]
    let _ = language;
    #[cfg(not(target_os = "windows"))]
    let image = platform::capture()?;
    if let Some(bytes) = &image {
        validate_png(bytes)?;
    }
    Ok(image)
}

fn unavailable(reason: &str) -> CaptureCapabilities {
    CaptureCapabilities {
        supported: false,
        targets: vec![],
        permission: "unavailable".into(),
        reason: reason.into(),
    }
}

fn timeout_error() -> AppError {
    AppError::new(
        "CAPTURE_TIMEOUT",
        "The screenshot chooser timed out after three minutes. Start Capture again when ready.",
    )
}

/// Validate the entire PNG with bounded decoder memory before labeling it PNG.
/// This does not sanitize metadata or produce a shareable/redacted derivative.
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
pub(crate) fn validate_png(bytes: &[u8]) -> Result<()> {
    const MAX_PIXELS: u64 = 16_000_000;
    let invalid = || {
        AppError::new("CAPTURE_INVALID", "The capture service returned an invalid or incomplete PNG. Try Capture again, or import a saved PNG.")
    };
    if bytes.len() as u64 > crate::files::MAX_ASSET_BYTES {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "The screenshot exceeds 64 MiB. Capture a smaller region.",
        ));
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 64 * 1024 * 1024,
    });
    let mut reader = decoder.read_info().map_err(|_| invalid())?;
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || info.width > 8192
        || info.height > 8192
        || u64::from(info.width) * u64::from(info.height) > MAX_PIXELS
    {
        return Err(AppError::new("LIMIT_EXCEEDED", "The screenshot exceeds 16 megapixels or 8192 pixels per side. Capture a smaller region."));
    }
    if info.animation_control.is_some() {
        return Err(invalid());
    }
    // Rows avoid allocating the entire uncompressed image (including on Retina).
    while reader.next_row().map_err(|_| invalid())?.is_some() {}
    reader.finish().map_err(|_| invalid())?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(crate) fn validate_png(_: &[u8]) -> Result<()> {
    Err(AppError::new("UNSUPPORTED", &capabilities().reason))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn read_capture_file(path: &std::path::Path) -> Result<Vec<u8>> {
    use std::{fs::OpenOptions, io::Read, os::unix::fs::OpenOptionsExt};
    // No-follow and nonblocking open protect against a final-component swap to
    // a symlink/FIFO between metadata inspection and opening the portal file.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(AppError::new(
            "CAPTURE_INVALID",
            "The capture service did not return a regular image file.",
        ));
    }
    if meta.len() > crate::files::MAX_ASSET_BYTES {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "The screenshot exceeds 64 MiB. Capture a smaller region.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(crate::files::MAX_ASSET_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > crate::files::MAX_ASSET_BYTES {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "The screenshot exceeds 64 MiB. Capture a smaller region.",
        ));
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{
        fs::{self, File},
        io::Read,
        os::unix::{fs::PermissionsExt, process::CommandExt},
        path::Path,
        process::{Child, Command, ExitStatus, Stdio},
        time::Instant,
    };

    const EXECUTABLE: &str = "/usr/sbin/screencapture";
    const PERMISSION_HELP: &str = "Allow Tracefold in System Settings > Privacy & Security > Screen Recording (Screen & System Audio Recording on newer macOS), then quit and reopen Tracefold. Development launches may list Terminal or the launching app instead.";

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    fn permitted() -> bool {
        // SAFETY: parameterless CoreGraphics API, available since macOS 10.15.
        unsafe { CGPreflightScreenCaptureAccess() }
    }
    pub(super) fn capabilities() -> CaptureCapabilities {
        if !Path::new(EXECUTABLE).is_file() {
            return unavailable(
                "The macOS screenshot utility is missing. Import or paste a screenshot.",
            );
        }
        CaptureCapabilities {
            supported: true, targets: vec!["region".into(), "window".into()],
            // Preflight false cannot distinguish not-yet-asked from denied.
            permission: if permitted() { "granted" } else { "prompt" }.into(),
            reason: format!("Drag a region; press Space to choose a window; Escape cancels. Holding Control sends the image to the clipboard instead; paste it into Tracefold. Full-screen mode is not exposed by this picker. {PERMISSION_HELP}"),
        }
    }

    struct RunningCapture(Child);
    impl Drop for RunningCapture {
        fn drop(&mut self) {
            // Also runs on timeout, I/O errors, and unwinding; no orphan chooser.
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }
    fn wait(
        child: &mut RunningCapture,
        diagnostics: &Path,
        timeout: std::time::Duration,
    ) -> Result<ExitStatus> {
        let start = Instant::now();
        loop {
            if let Some(status) = child.0.try_wait()? {
                return Ok(status);
            }
            if fs::metadata(diagnostics)?.len() > 16 * 1024 {
                return Err(AppError::new(
                    "CAPTURE_FAILED",
                    "The macOS capture utility failed. Try again, or import a screenshot.",
                ));
            }
            if start.elapsed() >= timeout {
                return Err(timeout_error());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    fn classify(
        status: ExitStatus,
        has_image: bool,
        diagnostics: &[u8],
        permission: bool,
    ) -> Result<bool> {
        if !permission {
            return Err(AppError::new("CAPTURE_PERMISSION_DENIED", PERMISSION_HELP));
        }
        if status.success() && has_image {
            return Ok(true);
        }
        // Escape commonly exits 1; Control-to-clipboard can exit 0 without a file.
        // Never silently turn a diagnostic or a signal termination into Cancel.
        if !has_image && diagnostics.is_empty() && matches!(status.code(), Some(0 | 1)) {
            return Ok(false);
        }
        Err(AppError::new("CAPTURE_FAILED", "macOS could not finish the screenshot. Check Screen Recording access, free disk space, and an unlocked desktop; then retry or import a saved screenshot."))
    }

    pub(super) fn capture() -> Result<Option<Vec<u8>>> {
        if !Path::new(EXECUTABLE).is_file() {
            return Err(AppError::new("UNSUPPORTED", &capabilities().reason));
        }
        // Request only on the explicit capture action, never during discovery.
        // SAFETY: parameterless permission API supported by our macOS minimum.
        if !permitted() && !unsafe { CGRequestScreenCaptureAccess() } {
            return Err(AppError::new("CAPTURE_PERMISSION_DENIED", PERMISSION_HELP));
        }
        let directory = tempfile::Builder::new()
            .prefix("tracefold-capture-")
            .tempdir()?;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))?;
        let output = directory.path().join("capture.png");
        let diagnostics = directory.path().join("diagnostics");
        let mut command = Command::new(EXECUTABLE);
        command
            .args(["-i", "-x", "-r", "-t", "png"])
            .arg(&output)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(File::create(&diagnostics)?));
        // SAFETY: only async-signal-safe libc operations between fork and exec.
        // The OS enforces the output-file bound, even before our next poll.
        unsafe {
            command.pre_exec(|| {
                libc::umask(0o077);
                let limit = libc::rlimit {
                    rlim_cur: crate::files::MAX_ASSET_BYTES as libc::rlim_t,
                    rlim_max: crate::files::MAX_ASSET_BYTES as libc::rlim_t,
                };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = RunningCapture(command.spawn().map_err(|_| AppError::new("CAPTURE_FAILED", "Could not start the macOS screenshot chooser. Retry from an unlocked desktop, or import a screenshot."))?);
        let status = wait(&mut child, &diagnostics, CAPTURE_TIMEOUT)?;
        let has_image = match fs::symlink_metadata(&output) {
            Ok(meta) => meta.len() > 0,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        let mut message = Vec::new();
        File::open(&diagnostics)?
            .take(16 * 1024)
            .read_to_end(&mut message)?;
        if !classify(status, has_image, &message, permitted())? {
            return Ok(None);
        }
        Ok(Some(read_capture_file(&output)?))
        // Child is reaped before TempDir removes output and private diagnostics.
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::process::ExitStatusExt;
        #[test]
        fn cancellation_is_not_permission_denial_or_failure() {
            for code in [0, 1] {
                assert!(!classify(ExitStatus::from_raw(code << 8), false, b"", true).unwrap());
            }
            assert_eq!(
                classify(ExitStatus::from_raw(256), false, b"", false)
                    .unwrap_err()
                    .code,
                "CAPTURE_PERMISSION_DENIED"
            );
            assert!(classify(ExitStatus::from_raw(256), false, b"disk error", true).is_err());
            assert!(classify(ExitStatus::from_raw(9), false, b"", true).is_err());
            assert!(classify(ExitStatus::from_raw(0), true, b"", true).unwrap());
            assert!(classify(ExitStatus::from_raw(256), true, b"", true).is_err());
        }
        #[test]
        fn timeout_kills_and_reaps_child() {
            let directory = tempfile::tempdir().unwrap();
            let log = directory.path().join("log");
            File::create(&log).unwrap();
            let mut child = RunningCapture(Command::new("/bin/sleep").arg("30").spawn().unwrap());
            let pid = child.0.id();
            assert_eq!(
                wait(&mut child, &log, std::time::Duration::ZERO)
                    .unwrap_err()
                    .code,
                "CAPTURE_TIMEOUT"
            );
            drop(child);
            // SAFETY: waitpid observes this test's already-reaped child only.
            assert_eq!(
                unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) },
                -1
            );
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use ashpd::{
        desktop::{
            ResponseError,
            screenshot::{AvailableTargets, ScreenshotOptions, ScreenshotProxy},
        },
        zbus, Error, PortalError,
    };
    use std::{path::PathBuf, time::Duration};
    const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
    const PORTAL_HELP: &str = "A Screenshot portal (version 2 or newer) and a working desktop backend are required. Install/enable xdg-desktop-portal and the backend for your desktop, then log out and back in. Import or paste a screenshot if capture remains unavailable.";

    // A dedicated runtime/thread avoids nesting block_on in Tauri's runtime.
    fn run<T: Send + 'static>(
        task: impl std::future::Future<Output = Result<T>> + Send + 'static,
    ) -> Result<T> {
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| AppError::new("CAPTURE_UNAVAILABLE", PORTAL_HELP))?
                .block_on(task)
        })
        .join()
        .map_err(|_| {
            AppError::new(
                "CAPTURE_FAILED",
                "The portal worker stopped unexpectedly. Retry Capture.",
            )
        })?
    }
    fn portal_error(error: Error) -> AppError {
        match error {
            Error::Portal(PortalError::NotAllowed(_)) => AppError::new("CAPTURE_PERMISSION_DENIED", "The desktop denied screenshot access. Allow Tracefold in your desktop's application/privacy permissions and retry Capture; contact your administrator if capture is disabled by policy."),
            Error::Response(ResponseError::Other) => AppError::new("CAPTURE_FAILED", "The desktop declined or failed the screenshot request. Check screenshot/privacy permissions and the portal backend, then retry. The portal did not distinguish denial from another failure."),
            _ => AppError::new("CAPTURE_UNAVAILABLE", PORTAL_HELP),
        }
    }
    async fn connect() -> Result<zbus::Connection> {
        tokio::time::timeout(PROBE_TIMEOUT, zbus::Connection::session())
            .await
            .map_err(|_| AppError::new("CAPTURE_UNAVAILABLE", PORTAL_HELP))?
            .map_err(|_| AppError::new("CAPTURE_UNAVAILABLE", PORTAL_HELP))
    }
    async fn proxy(connection: zbus::Connection) -> Result<ScreenshotProxy> {
        let proxy = ScreenshotProxy::with_connection(connection)
            .await
            .map_err(portal_error)?;
        if proxy.version() < 2 {
            return Err(AppError::new("CAPTURE_UNAVAILABLE", PORTAL_HELP));
        }
        Ok(proxy)
    }
    pub(super) fn capabilities() -> CaptureCapabilities {
        run(async {
            let connection = connect().await?;
            let result = tokio::time::timeout(PROBE_TIMEOUT, async {
                let proxy = proxy(connection.clone()).await?;
                let mut targets = vec![];
                if proxy.version() >= 3 {
                    let supported = proxy.available_targets().await.map_err(portal_error)?;
                    for (flag, name) in [(AvailableTargets::Screen, "screen"), (AvailableTargets::Window, "window"), (AvailableTargets::Area, "region")] {
                        if supported.contains(flag) { targets.push(name.into()); }
                    }
                }
                Ok(CaptureCapabilities { supported: true, targets, permission: "prompt".into(),
                    reason: "The desktop portal chooses which capture controls to show. Version 2 does not advertise targets, so an empty target list means unknown, not no capture. Permission is decided by the desktop for each request; interactive mode is a hint the backend may ignore.".into() })
            }).await.map_err(|_| AppError::new("CAPTURE_UNAVAILABLE", PORTAL_HELP))?;
            // Own the connection, rather than keeping ashpd's global bus alive.
            let _ = tokio::time::timeout(PROBE_TIMEOUT, connection.close()).await;
            result
        }).unwrap_or_else(|error| unavailable(&error.message))
    }
    fn local_path(uri: &str) -> Result<PathBuf> {
        let invalid = || {
            AppError::new("CAPTURE_INVALID", "The desktop returned a non-local screenshot URI. Save the screenshot locally and import it.")
        };
        let url = url::Url::parse(uri).map_err(|_| invalid())?;
        if url.scheme() != "file"
            || url.host_str().is_some_and(|h| h != "localhost")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        let path = url.to_file_path().map_err(|_| invalid())?;
        if !path.is_absolute() {
            return Err(invalid());
        }
        Ok(path)
    }
    pub(super) fn capture() -> Result<Option<Vec<u8>>> {
        run(async {
            let connection = connect().await?;
            let result = tokio::time::timeout(CAPTURE_TIMEOUT, async {
                let proxy = proxy(connection.clone()).await?;
                // No parent window token is fabricated. Modal=false is deliberate
                // for the unparented chooser; Tauri can keep saving in the meantime.
                let options = ScreenshotOptions::default()
                    .set_interactive(true)
                    .set_modal(false);
                let response = match proxy
                    .screenshot(None, options)
                    .await
                    .and_then(|r| r.response())
                {
                    Ok(response) => response,
                    Err(
                        Error::Response(ResponseError::Cancelled)
                        | Error::Portal(PortalError::Cancelled(_)),
                    ) => return Ok(None),
                    Err(error) => return Err(portal_error(error)),
                };
                // The URI comes only from the OS portal, never from the renderer.
                // No fetch, URI launch, shell command, or remote host is allowed.
                let path = local_path(response.uri().as_str())?;
                let bytes = read_capture_file(&path)?;
                // This file belongs to the portal. It may be a Documents export
                // or a user's saved screenshot; do not unlink an arbitrary URI.
                Ok(Some(bytes))
            })
            .await
            .map_err(|_| timeout_error());
            // ashpd send waits for Response before exposing Request::close.
            // Disconnect our private bus on timeout to release pending requests.
            let _ = tokio::time::timeout(PROBE_TIMEOUT, connection.close()).await;
            result?
        })
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn portal_uris_are_local_and_percent_decoded() {
            assert_eq!(
                local_path("file:///tmp/a%20b.png").unwrap(),
                PathBuf::from("/tmp/a b.png")
            );
            for uri in [
                "https://example.com/image.png",
                "file://server/share/image.png",
                "file:///tmp/a.png?x=1",
                "file:///tmp/a.png#fragment",
            ] {
                assert!(local_path(uri).is_err());
            }
        }
        #[test]
        fn portal_denial_is_actionable_and_other_is_not_cancel() {
            assert_eq!(
                portal_error(Error::Portal(PortalError::NotAllowed(
                    "private details".into()
                )))
                .code,
                "CAPTURE_PERMISSION_DENIED"
            );
            assert_eq!(
                portal_error(Error::Response(ResponseError::Other)).code,
                "CAPTURE_FAILED"
            );
        }
    }
}

#[cfg(target_os = "windows")]
#[path = "capture_windows.rs"]
mod platform;

// Exercise the Windows pixel boundary on Unix too, without linking Windows APIs.
#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
#[path = "capture_windows.rs"]
mod windows_pixel_tests;

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    use super::*;
    pub(super) fn capabilities() -> CaptureCapabilities {
        unavailable("Native capture is not implemented for this platform in this build. On Windows, use Win+Shift+S, then paste or import the screenshot. Tracefold does not monitor or replace the clipboard.")
    }
    pub(super) fn capture() -> Result<Option<Vec<u8>>> {
        Err(AppError::new("UNSUPPORTED", &capabilities().reason))
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod tests {
    use super::*;
    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![];
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&vec![127; width as usize * height as usize * 4])
            .unwrap();
        writer.finish().unwrap();
        bytes
    }
    #[test]
    fn accepts_png_and_rejects_wrong_format_truncation_and_bad_crc() {
        let bytes = png_bytes(2, 2);
        validate_png(&bytes).unwrap();
        for invalid in [&b"not an image"[..], &bytes[..bytes.len() / 2]] {
            assert!(validate_png(invalid).is_err());
        }
        let mut corrupt = bytes.clone();
        corrupt[29] ^= 1; // IHDR CRC.
        assert!(validate_png(&corrupt).is_err());
    }
    #[test]
    fn rejects_excessive_dimensions_before_decoding_pixels() {
        let bytes = png_bytes(32769, 1);
        assert_eq!(validate_png(&bytes).unwrap_err().code, "LIMIT_EXCEEDED");
    }
    #[test]
    fn capture_slot_rejects_overlap_and_releases_on_drop() {
        let first = CaptureGuard::acquire().unwrap();
        assert!(matches!(CaptureGuard::acquire(), Err(e) if e.code == "CAPTURE_BUSY"));
        drop(first);
        assert!(CaptureGuard::acquire().is_ok());
    }
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn capture_file_rejects_links_directories_and_oversized_files() {
        use std::{fs, os::unix::fs::symlink};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        fs::write(&path, png_bytes(1, 1)).unwrap();
        validate_png(&read_capture_file(&path).unwrap()).unwrap();
        let link = dir.path().join("link");
        symlink(&path, &link).unwrap();
        assert!(read_capture_file(&link).is_err());
        assert!(read_capture_file(dir.path()).is_err());
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(crate::files::MAX_ASSET_BYTES + 1)
            .unwrap();
        assert_eq!(read_capture_file(&path).unwrap_err().code, "LIMIT_EXCEEDED");
    }
}
