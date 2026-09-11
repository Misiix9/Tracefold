# Native screenshot capture

Capture is an explicit user action. Capability discovery never takes a screenshot or prompts for permission. The native command validates project ownership, releases the database worker, opens the OS chooser, then reacquires the worker to durably import a completed capture. Autosave remains available while the chooser is open. Overlapping chooser requests are rejected.

## macOS

The adapter uses the system-owned `/usr/sbin/screencapture` executable with fixed `-i -x -r -t png` arguments and a private temporary output directory. It never executes a shell or accepts executable paths/arguments from the renderer. Drag a region, press Space to choose a window, and Escape to cancel. This picker currently exposes region/window capture; full-screen selection is not advertised.

CoreGraphics preflight distinguishes an existing grant from an unknown/denied state; it cannot distinguish those latter two without a user action. The permission request is made only after Capture. A denied permission returns an actionable error. Empty success or exit 1 without diagnostics is treated as cancellation; failures with diagnostics are not silently treated as cancellation. The child has a three-minute deadline, an output-file size limit, restrictive file permissions, and is killed/reaped on early return. Temporary files are removed after reading.

Source verification: the installed macOS `screencapture` usage documents the fixed options. The CoreGraphics permission declarations are linked directly from the system framework. Interactive grant/revocation and mixed-display tests remain required; unit tests do not prove those behaviors.

## Linux

The target-specific adapter uses published ashpd 0.13.13, with only Tokio and screenshot features. It connects to the session bus and calls the freedesktop Screenshot portal. Version 2 or newer is required for the interactive hint. Version 3 reports actual available targets; version 2 leaves the target list unknown. The desktop backend owns the chooser and permission decision. The adapter does not fabricate a parent-window token or promise the backend will honor interactive mode.

A private bus connection is closed after the operation or timeout. Returned URIs must be absolute local file URIs without remote hosts, query strings or fragments. The reader rejects symlinks/FIFOs/nonregular files and bounds bytes. Portal-owned files are not deleted because they may be user-owned exports. There is no direct X11 capture fallback yet; X11 desktops with the portal can use the same path.

Sources: [ashpd screenshot module](https://docs.rs/ashpd/0.13.13/ashpd/desktop/screenshot/index.html), and the installed crate source corresponding to Cargo.lock. The native Linux build and tests passed in GitHub Actions on 10 September 2026. Real portal backend interaction remains pending.

## Windows

The Windows adapter uses Windows.Graphics.Capture with the system GraphicsCapturePicker for each screenshot. A temporary native owner window and the picker run on a dedicated STA thread with a bounded message pump. The picker is initialized with that owner HWND; no foreground-window guessing, renderer handles, shell commands, clipboard interception or programmatic target selection is used. The helper's copy follows the application language; the OS picker follows Windows. It exposes window/display selection, not regions. For regions, the UI suggests Win+Shift+S followed by paste.

After selection, a free-threaded one-frame pool supplies a BGRA surface. The adapter validates dimensions before allocations, copies only ContentSize into a CPU-readable staging texture, respects GPU row pitch and encodes an opaque PNG row by row. Transparent RGB and padding are omitted. It retains the OS capture border and cursor defaults. A three-minute chooser deadline and ten-second frame/readback deadline bound polling; guards close the picker operation, frame, session, pool, mapping, helper window and COM apartment on return. Driver API calls themselves are outside application-level hard timeout guarantees.

Capabilities test OS/API support without opening a picker or taking a screenshot. Permission denial and API failure are distinct from cancellation. A cancelled picker creates no evidence. A resizing target that outgrows the allocated frame is rejected. This is an SDR path; HDR color fidelity and mixed-DPI behavior remain release gates, not validated claims.

Validation includes a native Windows x64 build, the native unit tests and successful NSIS installation in GitHub Actions. The installed application launch test is still under investigation; interactive capture has not passed. See WINDOWS_CAPTURE_VALIDATION.md for the remaining native matrix.

Sources: [Microsoft screen capture guide](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture), [desktop picker initialization](https://learn.microsoft.com/en-us/windows/apps/develop/ui/display-ui-objects), [Win32CaptureSample](https://github.com/robmikh/Win32CaptureSample), and the windows 0.61.3 generated bindings pinned in Cargo.lock.

## Pixel and storage boundary

PNG decoding validates format, CRCs and resource bounds before the native import is committed. The UI normalizes the capture through an image canvas before creating an evidence record; the original stays available only in local/full backups. Sharing reconstructs and re-encodes a fresh PNG with metadata removed and invisible transparent RGB cleared. Annotation redactions paint opaque pixels last. Separate export validation rejects missing or stale sanitized derivatives.
