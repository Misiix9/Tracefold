//! One-shot Windows Graphics Capture, authorized only by the system picker.
//! No shell, clipboard, filesystem, renderer HWND, or programmatic target lookup.
use crate::error::{AppError, Result};
use std::io::Write;

#[cfg(target_os = "windows")]
pub(super) use native::{capabilities, capture};

fn limit_error() -> AppError {
    AppError::new("LIMIT_EXCEEDED", "The screenshot exceeds 16 megapixels, 8192 pixels per side, or 64 MiB. Choose a smaller window, or import a cropped screenshot.")
}
fn invalid_frame() -> AppError {
    AppError::new("CAPTURE_INVALID", "Windows returned an invalid screenshot frame. Retry Capture, or import a saved screenshot.")
}
fn dimensions(width: i32, height: i32) -> Result<(u32, u32)> {
    if width <= 0 || height <= 0 {
        return Err(invalid_frame());
    }
    if width > 8192 || height > 8192 || i64::from(width) * i64::from(height) > 16_000_000 {
        return Err(limit_error());
    }
    Ok((width as u32, height as u32))
}

// Exclude final-row padding from the slice, and reject overflow before any raw
// pointer access. Width/height must be bounded even when testing this separately.
fn mapped_length(width: u32, height: u32, pitch: usize) -> Result<usize> {
    dimensions(
        i32::try_from(width).map_err(|_| limit_error())?,
        i32::try_from(height).map_err(|_| limit_error())?,
    )?;
    let row = width as usize * 4;
    if pitch < row {
        return Err(invalid_frame());
    }
    pitch
        .checked_mul(height as usize - 1)
        .and_then(|n| n.checked_add(row))
        .filter(|&n| n <= isize::MAX as usize)
        .ok_or_else(invalid_frame)
}

struct BoundedPng {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}
impl Write for BoundedPng {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(std::io::Error::other("capture PNG byte limit"));
        }
        self.bytes
            .try_reserve_exact(bytes.len())
            .map_err(|_| std::io::Error::other("capture PNG allocation"))?;
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_bgra(width: u32, height: u32, pitch: usize, pixels: &[u8]) -> Result<Vec<u8>> {
    let length = mapped_length(width, height, pitch)?;
    if pixels.len() < length {
        return Err(invalid_frame());
    }
    let mut output = BoundedPng {
        bytes: Vec::new(),
        limit: crate::files::MAX_ASSET_BYTES as usize,
        exceeded: false,
    };
    let encoded = (|| -> std::result::Result<(), png::EncodingError> {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        // Capture BGRA is premultiplied. Flatten against black to produce opaque
        // RGB; never retain invisible RGB, source metadata, or row padding.
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        {
            let mut stream = writer.stream_writer()?;
            let mut row = vec![0; width as usize * 3];
            for y in 0..height as usize {
                let start = y * pitch;
                for (bgra, rgb) in pixels[start..start + width as usize * 4]
                    .chunks_exact(4)
                    .zip(row.chunks_exact_mut(3))
                {
                    rgb.copy_from_slice(&if bgra[3] == 0 {
                        [0, 0, 0]
                    } else {
                        [bgra[2], bgra[1], bgra[0]]
                    });
                }
                stream.write_all(&row)?;
            }
            stream.finish()?;
        }
        writer.finish()
    })();
    encoded.map_err(|_| {
        if output.exceeded {
            limit_error()
        } else {
            invalid_frame()
        }
    })?;
    Ok(output.bytes)
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use crate::model::CaptureCapabilities;
    use std::time::{Duration, Instant};
    use windows::{
        core::{w, Interface, HSTRING},
        Foundation::Metadata::ApiInformation,
        Graphics::{
            Capture::{
                Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
                GraphicsCapturePicker, GraphicsCaptureSession,
            },
            DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        },
        Win32::{
            Foundation::{E_ACCESSDENIED, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, WPARAM},
            Graphics::{
                Direct3D::D3D_DRIVER_TYPE_HARDWARE,
                Direct3D11::*,
                Dxgi::{
                    Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
                    IDXGIDevice, DXGI_ERROR_WAS_STILL_DRAWING,
                },
            },
            System::{
                LibraryLoader::GetModuleHandleW,
                WinRT::{
                    Direct3D11::{
                        CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
                    },
                    RoInitialize, RoUninitialize, RO_INIT_SINGLETHREADED,
                },
            },
            UI::{Shell::IInitializeWithWindow, WindowsAndMessaging::*},
        },
    };
    use windows_future::{AsyncStatus, IAsyncOperation};

    const HELP: &str = "Windows Graphics Capture is unavailable. Use an unlocked Windows 10 version 1809 or newer desktop with a working graphics driver and capture allowed by policy. Use Win+Shift+S, then paste or import if needed.";
    const FRAME_TIMEOUT: Duration = Duration::from_secs(10);
    fn api_error(error: windows::core::Error) -> AppError {
        if error.code() == E_ACCESSDENIED {
            AppError::new("CAPTURE_PERMISSION_DENIED", "Windows denied screenshot access. Check Windows privacy settings and your administrator's screen capture policy, then retry or import a saved screenshot.")
        } else {
            AppError::new("CAPTURE_FAILED", "Windows could not finish the screenshot. The selected window may have closed, be minimized or protected, or the graphics device may be unavailable. Restore the window and retry, or import a screenshot.")
        }
    }
    struct Apartment;
    impl Apartment {
        fn new() -> Result<Self> {
            // SAFETY: called only on a new dedicated thread, never Tauri's pool.
            unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.map_err(api_error)?;
            Ok(Self)
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            // SAFETY: balanced successful initialization on this same thread;
            // all COM/WinRT locals have been dropped before this guard.
            unsafe { RoUninitialize() };
        }
    }
    fn run<T: Send + 'static>(task: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
        std::thread::Builder::new()
            .name("tracefold-capture".into())
            .spawn(move || {
                let _apartment = Apartment::new()?;
                task()
            })
            .map_err(|_| {
                AppError::new(
                    "CAPTURE_FAILED",
                    "Could not start the screenshot worker. Retry Capture.",
                )
            })?
            .join()
            .map_err(|_| {
                AppError::new(
                    "CAPTURE_FAILED",
                    "The screenshot worker stopped unexpectedly. Retry Capture.",
                )
            })?
    }
    fn supported() -> bool {
        ApiInformation::IsMethodPresent(
            &HSTRING::from("Windows.Graphics.Capture.Direct3D11CaptureFramePool"),
            &HSTRING::from("CreateFreeThreaded"),
        )
        .unwrap_or(false)
            && GraphicsCaptureSession::IsSupported().unwrap_or(false)
    }
    pub(crate) fn capabilities() -> CaptureCapabilities {
        // No picker, permission request, window, or D3D device during discovery.
        if !run(|| Ok(supported())).unwrap_or(false) {
            return super::super::unavailable(HELP);
        }
        CaptureCapabilities {
            supported: true, targets: vec!["window".into(), "screen".into()], permission: "prompt".into(),
            reason: "Windows asks you to choose a window or display for each screenshot. Cancel or Escape returns without saving. Region selection is not offered; use Win+Shift+S and paste for a region. Capture is limited to SDR PNG, 16 megapixels and 8192 pixels per side.".into(),
        }
    }

    // A real native owner on the same STA/UI thread as the picker. The existing
    // capture command has no Tauri Window argument; do not guess foreground HWNDs
    // or accept handles from JavaScript. This owner lives only during the action.
    struct PickerWindow {
        hwnd: HWND,
        instance: HINSTANCE,
    }
    unsafe extern "system" fn owner_window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // SAFETY: Windows supplies the window-message arguments; no pointers or
        // Rust state are retained by this forwarding callback.
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }
    impl PickerWindow {
        fn new(hungarian: bool) -> Result<Self> {
            // SAFETY: constant class/title, valid module and no external pointers.
            unsafe {
                let instance: HINSTANCE = GetModuleHandleW(None).map_err(api_error)?.into();
                let class = WNDCLASSW {
                    lpfnWndProc: Some(owner_window_proc),
                    hInstance: instance,
                    lpszClassName: w!("TracefoldCapturePickerOwner"),
                    ..Default::default()
                };
                if RegisterClassW(&class) == 0 {
                    return Err(api_error(windows::core::Error::from_win32()));
                }
                let mut owner = Self {
                    hwnd: HWND::default(),
                    instance,
                };
                let title = HSTRING::from(if hungarian { "Tracefold – Képernyőkép kiválasztása" } else { "Tracefold – Choose a screenshot" });
                let instruction = HSTRING::from(if hungarian { "Válassz ablakot vagy kijelzőt a Windows választóablakában.\nA Mégse gomb vagy az Escape mentés nélkül visszalép." } else { "Choose a window or display in the Windows picker.\nCancel or Escape returns without saving." });
                owner.hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    class.lpszClassName,
                    &title,
                    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                    CW_USEDEFAULT,
                    CW_USEDEFAULT,
                    440,
                    140,
                    None,
                    None,
                    Some(instance),
                    None,
                )
                .map_err(api_error)?;
                CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"),
                    &instruction,
                    WS_CHILD | WS_VISIBLE, 16, 16, 400, 60, Some(owner.hwnd), None, Some(instance), None).map_err(api_error)?;
                // Exclude our helper from capture where supported; this does not
                // change selection or protection on any other window.
                let _ = SetWindowDisplayAffinity(owner.hwnd, WDA_EXCLUDEFROMCAPTURE);
                let _ = ShowWindow(owner.hwnd, SW_SHOW);
                Ok(owner)
            }
        }
        fn pump(&self) -> bool {
            // SAFETY: pump only this worker's queue. Cap each batch so a stream
            // of messages cannot starve timeout/cancellation checks.
            unsafe {
                let mut message = MSG::default();
                for _ in 0..64 {
                    if !PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        break;
                    }
                    if message.message == WM_QUIT {
                        return false;
                    }
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                IsWindow(Some(self.hwnd)).as_bool()
            }
        }
        fn hide(&self) {
            // SAFETY: this thread owns the window and keeps it alive for cleanup.
            unsafe {
                let _ = ShowWindow(self.hwnd, SW_HIDE);
            }
        }
    }
    impl Drop for PickerWindow {
        fn drop(&mut self) {
            // SAFETY: created on this thread; destruction also removes children.
            unsafe {
                if IsWindow(Some(self.hwnd)).as_bool() {
                    let _ = DestroyWindow(self.hwnd);
                }
                let _ = UnregisterClassW(w!("TracefoldCapturePickerOwner"), Some(self.instance));
            }
        }
    }
    struct PickerOperation(IAsyncOperation<GraphicsCaptureItem>);
    impl Drop for PickerOperation {
        fn drop(&mut self) {
            if self.0.Status().ok() == Some(AsyncStatus::Started) {
                let _ = self.0.Cancel();
            }
            let _ = self.0.Close();
        }
    }
    fn pick(owner: &PickerWindow) -> Result<Option<GraphicsCaptureItem>> {
        let picker = GraphicsCapturePicker::new().map_err(api_error)?;
        let initialize: IInitializeWithWindow = picker.cast().map_err(api_error)?;
        // SAFETY: valid owner created on the current STA thread, before picking.
        unsafe { initialize.Initialize(owner.hwnd) }.map_err(api_error)?;
        let operation = PickerOperation(picker.PickSingleItemAsync().map_err(api_error)?);
        let deadline = Instant::now() + super::super::CAPTURE_TIMEOUT;
        loop {
            if !owner.pump() {
                return Ok(None);
            }
            if Instant::now() >= deadline {
                return Err(super::super::timeout_error());
            }
            match operation.0.Status().map_err(api_error)? {
                AsyncStatus::Started => std::thread::sleep(Duration::from_millis(10)),
                AsyncStatus::Canceled => return Ok(None),
                AsyncStatus::Completed => {
                    // SAFETY: exact generated ABI, zero-initialized out pointer.
                    // S_OK + null is user cancellation, not E_POINTER: calling
                    // the projected GetResults loses this distinction.
                    unsafe {
                        let mut raw = std::ptr::null_mut();
                        (Interface::vtable(&operation.0).GetResults)(
                            Interface::as_raw(&operation.0),
                            &mut raw,
                        )
                        .ok()
                        .map_err(api_error)?;
                        return Ok(if raw.is_null() {
                            None
                        } else {
                            Some(GraphicsCaptureItem::from_raw(raw))
                        });
                    }
                }
                _ => {
                    return Err(api_error(windows::core::Error::from_hresult(
                        operation.0.ErrorCode().map_err(api_error)?,
                    )))
                }
            }
        }
    }
    struct CaptureResources {
        session: Option<GraphicsCaptureSession>,
        pool: Direct3D11CaptureFramePool,
    }
    impl Drop for CaptureResources {
        fn drop(&mut self) {
            if let Some(session) = &self.session {
                let _ = session.Close();
            }
            let _ = self.pool.Close();
        }
    }
    struct Frame(Direct3D11CaptureFrame);
    impl Drop for Frame {
        fn drop(&mut self) {
            let _ = self.0.Close();
        }
    }
    struct Mapping<'a> {
        context: &'a ID3D11DeviceContext,
        texture: &'a ID3D11Texture2D,
    }
    impl Drop for Mapping<'_> {
        fn drop(&mut self) {
            // SAFETY: guard exists only after successful Map of subresource 0.
            unsafe {
                self.context.Unmap(self.texture, 0);
            }
        }
    }
    fn frame_timeout() -> AppError {
        AppError::new("CAPTURE_TIMEOUT", "Windows did not provide a readable screenshot within ten seconds. Restore the selected window, check the graphics driver, and retry Capture.")
    }
    fn next_frame(pool: &Direct3D11CaptureFramePool) -> Result<Option<Frame>> {
        // SAFETY: exact generated ABI; null on successful TryGetNextFrame means
        // no frame yet. A real failed HRESULT is never classified as 'no frame'.
        unsafe {
            let mut raw = std::ptr::null_mut();
            (Interface::vtable(pool).TryGetNextFrame)(Interface::as_raw(pool), &mut raw)
                .ok()
                .map_err(api_error)?;
            Ok(if raw.is_null() {
                None
            } else {
                Some(Frame(Direct3D11CaptureFrame::from_raw(raw)))
            })
        }
    }
    fn snapshot(item: &GraphicsCaptureItem, owner: &PickerWindow) -> Result<Option<Vec<u8>>> {
        let size = item.Size().map_err(api_error)?;
        dimensions(size.Width, size.Height)?; // before any capture GPU allocation
        let mut device = None;
        let mut context = None;
        // SAFETY: OS default hardware adapter, valid output slots, BGRA support;
        // immediate context stays entirely on this thread.
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(api_error)?;
        let device = device.ok_or_else(invalid_frame)?;
        let context = context.ok_or_else(invalid_frame)?;
        let dxgi: IDXGIDevice = device.cast().map_err(api_error)?;
        // SAFETY: DXGI interface obtained from our own live D3D11 device.
        let runtime_device: IDirect3DDevice =
            unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
                .map_err(api_error)?
                .cast()
                .map_err(api_error)?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &runtime_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            size,
        )
        .map_err(api_error)?;
        let mut resources = CaptureResources {
            session: None,
            pool,
        };
        let session = resources
            .pool
            .CreateCaptureSession(item)
            .map_err(api_error)?;
        resources.session = Some(session.clone());
        // Keep OS defaults: visible capture border and cursor. No borderless or
        // programmatic access request, and no target retained across captures.
        session.StartCapture().map_err(api_error)?;
        let deadline = Instant::now() + FRAME_TIMEOUT;
        let frame = loop {
            if !owner.pump() {
                return Ok(None);
            }
            if Instant::now() >= deadline {
                return Err(frame_timeout());
            }
            if let Some(frame) = next_frame(&resources.pool)? {
                break frame;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let content = frame.0.ContentSize().map_err(api_error)?;
        let (width, height) = dimensions(content.Width, content.Height)?;
        let surface = frame.0.Surface().map_err(api_error)?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(api_error)?;
        // SAFETY: live frame surface; keep frame alive through copy and mapping.
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(api_error)?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            texture.GetDesc(&mut desc);
        }
        if width > desc.Width || height > desc.Height {
            return Err(AppError::new(
                "CAPTURE_RESIZED",
                "The selected window grew during capture. Stop resizing it and retry Capture.",
            ));
        }
        if desc.Width > size.Width as u32
            || desc.Height > size.Height as u32
            || desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
            || desc.SampleDesc.Count != 1
        {
            return Err(invalid_frame());
        }
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            ..Default::default()
        };
        let mut staging = None;
        // SAFETY: bounded dimensions and an initialized descriptor/output slot.
        unsafe { device.CreateTexture2D(&staging_desc, None, Some(&mut staging)) }
            .map_err(api_error)?;
        let staging = staging.ok_or_else(invalid_frame)?;
        let region = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: width,
            bottom: height,
            back: 1,
        };
        // SAFETY: identical formats, single-sample textures, bounded source box.
        // Copy ContentSize only: shrinkage must never expose undefined pixels.
        unsafe {
            context.CopySubresourceRegion(&staging, 0, 0, 0, 0, &texture, 0, Some(&region));
            context.Flush();
        }
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        loop {
            if !owner.pump() {
                return Ok(None);
            }
            if Instant::now() >= deadline {
                return Err(frame_timeout());
            }
            // SAFETY: CPU-readable staging resource; DO_NOT_WAIT keeps GPU waits
            // inside our deadline rather than blocking indefinitely in Map.
            match unsafe {
                context.Map(
                    &staging,
                    0,
                    D3D11_MAP_READ,
                    D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                    Some(&mut mapped),
                )
            } {
                Ok(()) => break,
                Err(error) if error.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) => return Err(api_error(error)),
            }
        }
        let mapping = Mapping {
            context: &context,
            texture: &staging,
        };
        let length = mapped_length(width, height, mapped.RowPitch as usize)?;
        if mapped.pData.is_null() {
            return Err(invalid_frame());
        }
        // SAFETY: Map succeeded for a texture of exactly width x height; row
        // pitch/length checked above, frame + resource + mapping remain alive.
        let pixels = unsafe { std::slice::from_raw_parts(mapped.pData.cast::<u8>(), length) };
        let png = encode_bgra(width, height, mapped.RowPitch as usize, pixels)?;
        drop(mapping);
        // Remaining guards unconditionally close frame, session and pool before
        // the STA thread exits, including every error/cancel path above.
        Ok(Some(png))
    }
    pub(crate) fn capture(language: &str) -> Result<Option<Vec<u8>>> {
        let hungarian = language == "hu";
        run(move || {
            if !supported() {
                return Err(AppError::new("UNSUPPORTED", HELP));
            }
            let owner = PickerWindow::new(hungarian)?;
            let Some(item) = pick(&owner)? else {
                return Ok(None);
            };
            owner.hide();
            snapshot(&item, &owner)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dimensions_are_bounded_before_allocation() {
        for (w, h) in [
            (0, 1),
            (1, 0),
            (-1, 5),
            (8193, 1),
            (4001, 4000),
            (i32::MAX, i32::MAX),
        ] {
            assert!(dimensions(w, h).is_err());
        }
        assert_eq!(dimensions(4000, 4000).unwrap(), (4000, 4000));
        assert_eq!(dimensions(8192, 1).unwrap(), (8192, 1));
    }
    #[test]
    fn row_layout_rejects_short_overflow_and_missing_pixels() {
        assert!(mapped_length(2, 2, 7).is_err());
        assert!(mapped_length(2, 2, usize::MAX).is_err());
        assert!(mapped_length(u32::MAX, 1, usize::MAX).is_err());
        assert_eq!(mapped_length(2, 2, 16).unwrap(), 24);
        assert!(encode_bgra(2, 2, 16, &[0; 23]).is_err());
    }
    #[test]
    fn png_preserves_colors_skips_padding_and_clears_invisible_rgb() {
        let pixels = [
            0, 0, 255, 255, 255, 0, 0, 255, 111, 112, 113, 114, 0, 255, 0, 255, 91, 92, 93, 0,
        ];
        let png = encode_bgra(2, 2, 12, &pixels).unwrap();
        super::super::validate_png(&png).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(&png))
            .read_info()
            .unwrap();
        let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut decoded).unwrap();
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(decoded, [255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0]);
        assert!(reader.info().uncompressed_latin1_text.is_empty());
    }
    #[test]
    fn png_writer_enforces_limit_before_extending_output() {
        let mut output = BoundedPng {
            bytes: vec![],
            limit: 4,
            exceeded: false,
        };
        output.write_all(&[1, 2, 3, 4]).unwrap();
        assert!(output.write_all(&[5]).is_err());
        assert!(output.exceeded);
        assert_eq!(output.bytes, [1, 2, 3, 4]);
    }
}
