# Implementation ledger

Updated 10 September 2026. This remains an implementation build, not a completed release. The approved contract in PRODUCT_SPEC.md defines completion; the rows below do not reduce that scope.

| Requirement | Current evidence | Remaining work |
|---|---|---|
| Project/domain contracts and future providers | Typed entities, scoped repository interface, native/browser adapters; UUIDs, revisions, tombstones and native change journal | Provider architecture guide and review of every view boundary |
| Native SQLite persistence | WAL/FULL, scoped commands, immutable blobs, optimistic revisions, history and one workspace writer; native reopen/conflict/import/backup tests pass | Crash/power loss, disk-full, migration and large-workspace gates |
| Design system | Parchment/Evening tokens, locally bundled Lexend/Newsreader/iA Writer Mono, shared dialogs/fields/editor; native and browser visual checks started | Complete screen-by-screen accessibility, density, zoom and responsive review |
| Documents and sessions | Rich editor, chronology, promotion, charter, focus areas, timer/timebox, persisted draft and close flushing | Edit existing entries; robust promotion provenance/privacy; validate drafts/timers in native UI |
| Findings and retests | Expected/actual, causes, environment, severity, resolution/retest history | Duplicate/related finding editing, evidence comparison and workflow QA |
| Cases, datasets, runs and requirements | Frozen executions, step outcomes/reasons, coverage helpers and tested imported-result parsers | Broader UI scenario validation, run evidence attachment and bulk workflows |
| Evidence | Import/paste/drop, image normalization, annotation/crop/redaction/undo, video playback/timestamps, virtual log viewer | Thumbnails, log references, native drag/drop parity and broad media-export policy |
| Native capture | macOS utility, Linux portal and Windows GraphicsCapturePicker adapters implemented; actual platform modules and test code cross-check for Windows/Linux; pixel/cancellation tests pass | Interactive capture/permission/mixed-display checks and full native builds |
| Templates | 17 built-ins, custom sections/typed fields, use-template workflow | Editable instantiated fields and complete UI validation |
| Search | Repository-backed global search, kind filters, debounce and stale-response tests | Paging/virtualization of large workspaces and 50k benchmark |
| Reports | Six formats plus portable ZIP; actual PDF/DOCX/HTML/Markdown/CSV/JSON generation tests; PDF glyph fallback tested with Latin/Greek/Cyrillic/CJK | Purpose-specific composition, previews with evidence, final long-report visual/consumer inspection and broader script/style coverage |
| Safe portable import | Bounded ZIP parser, strict graph/assets, review screen, independent IDs, atomic native staging; corrupt/traversal/rollback tests | UI round trip including image assets and additional hostile-case matrix |
| PNG sharing boundary | Metadata removal, full scanline reconstruction/re-encoding, transparent RGB clearing and deterministic canonical bytes tested | Pixel-level annotation and every export extraction checks |
| Backup, trash, history | Streaming full-fidelity backup files, verified independent restoration, interval/daily/weekly retention; native file-dialog round trip preserved private note and 3 revisions | Orphan recovery, trash expiry and additional failure injection |
| Native app verification | macOS debug .app builds; actual note save/reopen and immediate-close flush verified | Updated capture/evidence/report/import/history flows in packaged app; signed release build |
| Automated checks | 195 domain/report/updater tests, 2 real editor component tests and 30 native tests pass; Svelte check has zero errors/warnings | Native platform CI and remaining scenario coverage |
| Performance | Binary evidence/export IPC replaces JSON byte arrays; report fonts load on demand | Measure all launch, memory, typing, navigation and search targets on each supported platform |
| Platform delivery | macOS ARM64 debug bundle generated locally | macOS Intel, Windows and Linux packages, installers, native runtime checks and signing where credentials are supplied |
| Documentation | Product/design contracts and this ledger | Architecture, user guide, recovery/format docs and release verification matrix |

No server, account, cloud sync, telemetry, remote asset dependency or shared-project service is implemented in this offline release. Future services are an extension requirement, not an advertised v1 feature.

## Beta and updater work

Public source/releases authorized. Signed updater implemented with background checks, availability-only purple sidebar action, pending-save flush, project backups, verified download and install/restart. GitHub native build matrix added. Signing private material stays outside the repository and is supplied through an Actions secret. End-to-end update installation and workspace preservation across a real version upgrade remain a release gate. The newest local QA bundle verifies rich-editor navigation, native backup-file restoration, revision recovery, and persistent Hungarian/English menus. Newer report/updater source changes require a refreshed package.
