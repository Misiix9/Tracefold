# Tracefold product contract

Source: approved conversation plan, 9 September 2026. All phases are required; this file does not redefine completion around implemented work.

## Product
Offline Tauri 2 + Svelte 5 + TypeScript + Rust + SQLite desktop companion. Cross-platform Windows 10 22H2/11, macOS 14+, Linux Ubuntu22.04+/Debian12+ with Wayland and X11. x64 and ARM64 where supported. Runtime has no application server, telemetry, account or CDN requirement. Core testing workflows remain offline. User-requested signed update checks and downloads from GitHub Releases are the sole network exception. Normal local storage, automatic backup, safe portable handoffs. Public release platform claims require native validation.

Progressive depth: capture -> organize -> investigate -> report -> handoff -> retest. Quick note without setup; documentation without cases; sessions/charters; findings; case library and datasets; run/step outcomes; requirements and coverage; evidence library; templates; full-text search; export and recovery. No test process execution, HTTP testing client, cloud collaboration or video recording in v1.

Hungarian and English are the supported interface languages. Hungarian is the default for new and migrated settings; Settings changes the language immediately and persists it. User-authored text and domain identifiers must not be rewritten when the interface language changes. Built-in template presentation and exported human-readable report labels follow the selected language.

## Architecture and future services
UI uses a WorkspaceRepository port, never direct SQL or filesystem. Native implementation uses typed Tauri commands. Browser adapter is explicitly a development/test environment, not desktop persistence. Entity IDs independent of storage, project scoping, revisions, tombstones, immutable assets, transactional change events with device/actor provenance. Future auth/session, blob storage, transport and sync providers can extend ports. Do not implement fake accounts or pretend local labels are authenticated users. No CRDT or sync guarantees until real transport/conflict handling exists.

## Workflows
- Documents: rich text headings, lists, tables, code, tasks, links, evidence captions; snippets/structured templates; revisions.
- Sessions: chronology, charter, timebox, pause/resume, environment snapshots, focus coverage, conclusions/exclusions.
- Entries: observation/pass/issue/question/idea; promote to finding or case without losing source.
- Findings: steps, expected/actual, impact, severity, priority, frequency, suspected versus confirmed causes, workaround, linked cases/findings, duplicate references, local owner, lifecycle open/in_progress/ready_for_retest/resolved/deferred, reopen, resolution and retest history. Unverified resolution labeled.
- Cases: prerequisites, folder/tags, ordered expected steps, datasets, requirement links. Runs freeze case/environment/dataset snapshots. Outcomes passed/failed/blocked/skipped/not_run; blocked/skipped require reason. Repeated failures link same finding. Retest never overwrites originals.
- Requirements: acceptance criteria, coverage links and explicit gaps. Counts with denominators, pass rate over pass/fail only, no synthetic quality score.
- Imports: JUnit XML, CSV mapping, versioned JSON; preview identities/results, reject malformed/empty success, handle repeat imports explicitly.
- Templates: walkthrough, bug/retest, exploratory, smoke/regression, UAT, accessibility, API/backend, performance, mobile/game, localization/compatibility, release summary; typed custom fields without scripts.
- Evidence: native screenshot/paste/drop/import, PNG normalization, crop, arrow/rectangle/ellipse/highlight/text/number/opaque redaction, undo/redo, zoom; videos with timestamp references and codec fallback; virtual logs with line refs; where-used links.
- Unique useful workflows: preserve investigation chronology through promotion, explicit hypothesis versus verified cause, failure-to-retest evidence comparison, coverage gaps with report-ready explanations, sanitized evidence chain, draft-to-report without double entry.

## Data safety
SQLite WAL foreign keys synchronous FULL; one writer; expected-revision checks; 250ms autosave inactivity; acknowledge exact buffer revision only. Durable asset publication before references. Revision history, 30-day trash, staged imports/exports. Backups via consistent database snapshot plus asset set derived from the copy; pin assets during backup, atomically publish verified package, preserve old backup on failure. Restore as new project. 30min active backup/first edit each day/before migration; ten interval, seven daily, four weekly snapshots, asset deduplication. Future automatic GC must retain history/trash/backup referenced blobs.

Custom Tauri command permissions and project ownership validation, bounded scoped paths/bytes, inert imported content and previews. No arbitrary SQL/shell commands to frontend. Diagnostic data local and excludes document contents/secrets.

## Exports
One frozen allowlisted sanitized ReportSnapshot feeds PDF/DOCX/HTML/Markdown/CSV/JSON. PDF fixed layout via pdfmake embedded fonts; DOCX editable named styles and permitted font embedding; HTML offline assets; Markdown relative assets; CSV formula protection; versioned JSON. Report presets finding/walkthrough/session/run/coverage/release. Preview title/author/audience/build/date/sections/evidence/page size/privacy. A4 default, Letter option.

.tracefold portable ZIP: versioned JSON and sanitized content-addressed evidence; imports independent project copy with provenance. .tracefold-backup full fidelity with originals/private history clearly separate. Share excludes private notes, original redacted pixels, metadata, paths, history, hidden text; regenerates previews; opaque pixel replacement; block missing/failed sanitized assets. Stage imports, reject traversal/links/case-collisions, bound archive and image resource use, validate hashes/links/schema. No live shared-folder database.

## Quality gates
Full keyboard/screen readers, 200% zoom, reduced motion, both themes, responsive desktop and compact capture. Native capture permissions/cancellation/revocation, Retina/mixedDPI/HDR, Wayland portal backends. Network-disabled install/launch/use/export/handoff/restore. Crash/disk-full/denial/stale/out-of-order saves/migration failure/hostile inputs. Export long tables/code/URLs/Unicode/page sizes and images inspected in multiple consumers; extracted secret checks. Native automation test plugins never in production.

Targets: cold launch p95<=1.5s, warm<=700ms, typing<50ms, navigation<150ms, 50k record search<200ms; process tree idle<=200MiB, CPU<1%; compressed app core<=35MiB excluding OS runtime; first note<=30s. Measure release builds on 4core/8GB/SSD on each platform. Targets are not claims.

## Delivery phases
1 Foundation/capture-export feasibility; 2 design system/core writing; 3 evidence/findings; 4 structured testing; 5 all exports/portability/backup; 6 cross-platform hardening, installers, user guide, format and recovery docs. No known critical defects, all advertised platform packages validated and performance measured before completion. Signing uses supplied credentials; unsigned builds identified.

## Beta distribution and in-app updates
Public GitHub source and releases are authorized. Deliver Windows Setup.exe and a locally installed macOS app with Desktop access. An accent-purple sidebar button immediately above Settings reads “Update to newest version” in English, with a Hungarian translation. Show only for a newer available version. Click saves all pending edits, creates project recovery backups, downloads and verifies a signed artifact, installs and restarts without replacing the application data directory. No manual GitHub download is required. Never embed publishing credentials or private signing material.
