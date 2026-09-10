# Tracefold · Beta 0.1 in development

An offline desktop companion for testers. Document observations, investigate findings, organize test cases and runs, attach evidence, and prepare reviewed reports without an application server.

**Release status:** development builds exist, but the complete platform and feature acceptance matrix is still being verified. A successful build is not a claim that every capture backend, installer or updater path has been exercised on real hardware. See [implementation status](docs/IMPLEMENTATION_STATUS.md).

The interface defaults to Hungarian and also supports English. Fonts are bundled locally: Lexend, Newsreader, and iA Writer Mono. Windows, macOS and Linux use the same Svelte UI with a Tauri/Rust and SQLite backend.

## Development

Install Node.js 24+, pnpm 11.19.0, current stable Rust, and [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:ui
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm desktop:dev
```

`pnpm dev` alone opens a browser preview backed by separate IndexedDB development storage. It does not use native project files. `pnpm desktop:dev` runs the actual desktop repository.

## Packaging

GitHub Actions builds native Windows x64, macOS ARM64 and Linux x64 packages. Installers and update payloads are artifacts until the release checklist is complete. Windows uses NSIS `Setup.exe` and bundles the WebView2 offline installer; this increases download size but allows installation without fetching a runtime. Runtime testing remains offline except for optional update checks/downloads.

A release signer must supply `TAURI_SIGNING_PRIVATE_KEY` (and its password if set). The private signing key is never committed or included in applications. The embedded public key verifies downloaded updates. The OS code-signing/notarization process is separate from updater signing; unsigned beta builds are identified as such.

## Data and updates

Projects, original evidence, settings and history live in the OS application data directory, separate from the application installation. Updating saves pending edits and creates independent project backups before replacing executable files. The interface shows **Update to newest version** above Settings only when a newer version is available. Clicking it downloads, verifies, installs and restarts internally; users do not need to browse GitHub.

Project data is never uploaded for updates. The only network exception to local operation is the public GitHub release feed and signed artifact download. Back up valuable work to a separate device; see [backup format and recovery](docs/BACKUP_FORMAT.md).

## Project documents

- [Product contract](docs/PRODUCT_SPEC.md)
- [Persistent release requirements](docs/PROJECT_MEMORY.md)
- [Capture architecture](docs/CAPTURE.md)
- [Windows capture validation](docs/WINDOWS_CAPTURE_VALIDATION.md)
- [Implementation ledger](docs/IMPLEMENTATION_STATUS.md)

No accounts, telemetry, cloud synchronization, shared-database workflow or hosted application backend are included.
