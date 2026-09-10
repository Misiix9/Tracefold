# Windows capture validation

The adapter is implemented; native Windows release validation is pending. No Windows executable or installer is represented as tested by the checks below.

## Reproducible compile check

The small `scripts/capture-check` crate imports the production `capture.rs` and platform modules directly. Its stubs cover only the surrounding model/error/file-limit types, so the real Windows calls, features and signatures are checked. It avoids needing a Windows C compiler merely to type-check the capture boundary on another OS.

```sh
rustup target add x86_64-pc-windows-gnu
cargo check --manifest-path scripts/capture-check/Cargo.toml --target x86_64-pc-windows-gnu
cargo test --manifest-path src-tauri/Cargo.toml
```

A native Windows job must additionally run `cargo test`, `pnpm check`, `pnpm test`, `pnpm test:ui`, and `pnpm tauri build` with the Windows prerequisites installed. Cross-target checking is not a substitute for linking, native tests or UI validation.

## Required native scenarios

| Scenario | Expected result | Status |
|---|---|---|
| Capability discovery | No prompt, helper window or image; unsupported systems get actionable guidance | Pending |
| Window and display picker | Only user-selected target is captured; helper is excluded where OS supports exclusion | Pending |
| Escape / Cancel / helper close | No evidence record, no temporary artifact, Capture usable again | Pending |
| Picker left open | Three-minute deadline, resources closed, actionable message | Pending |
| Denied access / policy | Permission error, no silent cancellation or empty-success record | Pending |
| Target closed or minimized | No unbounded wait; error/cancel with no partial record | Pending |
| Target resized | Safe ContentSize handling; growth beyond the pool rejected | Pending |
| Repeated captures | No accumulating helper windows, frames, handles or retained capture targets | Pending |
| Autosave during picker | Existing edits save while picker worker runs; no DB mutex held during choice | Pending |
| 100/150/200% DPI and mixed displays | Correct pixel dimensions and annotations after normalization | Pending |
| HDR and SDR display combinations | Correct colors or explicit unsupported handling before release; current SDR conversion is not validated for HDR | Pending |
| 4K / over-limit target | Valid supported image; over 16MP or 8192px rejected before CPU allocation | Pending |
| GPU device loss / locked session | Actionable failure; Capture can be retried after recovery | Pending |
| Hungarian / English | Helper follows app language; system picker uses OS language | Pending |
| Network disabled | Picker, capture, save, sanitization and export work without network | Pending |
| Protected content | OS protection respected; no alternative capture path to bypass it | Pending |

Executable unit tests verify dimension limits, row-pitch overflow and short buffers, exact red/green/blue output and transparent clearing, omission of padding/metadata, and output byte bounds. The generated PNG also passes the production decoder validation.
