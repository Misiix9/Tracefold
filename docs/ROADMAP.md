# Tracefold Roadmap: Beta to 1.0

This is the product roadmap for the full Tracefold platform. It covers the desktop core, the plugin platform, the Discovery plugin, specialist plugins, quality gates, and the path to the first stable 1.0 release.

The roadmap favors a small trusted core and powerful isolated plugins.

## Current baseline: v0.1.0

Released as the first public beta.

### Core

- Offline-first Tauri 2 desktop app.
- Svelte 5 and TypeScript UI.
- Rust native layer.
- SQLite project storage.
- Revisions, trash, backups, portable projects, and evidence.
- Notes, sessions, findings, cases, runs, coverage, reports, templates, and search.
- Windows, macOS, and Linux release work.
- Signed app update flow.
- English and Hungarian UI.

### Quality bar

The core remains local and does not need an account, cloud backend, telemetry service, or hosted application server.

---

# v0.2.0 Beta: Plugin Foundation

Goal: turn Tracefold from one testing workspace into a safe testing platform.

### Core features

- Plugin browser in Tracefold.
- Install plugin packages from local files.
- Enable, disable, open, stop, and remove plugins.
- Plugin process isolation through a local loopback runtime.
- Plugin-specific working directory.
- Manifest validation and path traversal protection.
- Plugin runtime shutdown when Tracefold exits.
- Plugin API version field.
- Plugin capability declarations.
- Plugin data survives Tracefold updates.

### Discovery plugin

- Authenticated browser crawl.
- Playwright session capture.
- Cookie and browser storage reuse.
- Bearer token support.
- JavaScript endpoint discovery.
- Live network request mapping.
- OpenAPI and Swagger discovery.
- Request payload inference.
- Exact `called from` page mapping.
- Multi-user BOLA test cases.
- CSV and styled Excel reports.
- Dynamic ID route deduplication.
- Configurable route-shape budgets.
- Custom ID regex rules.
- Persistent local `.tracefold-discovery` data.

### Important crawler behavior

A route such as `/cmdb/entity-types/DAM000000558/index` is treated as `/cmdb/entity-types/{id}/index` for crawl budgeting. A second page such as `/cmdb/entity-types/DAM000000999/index` is normally skipped after one representative has been scanned.

The exact URLs still remain visible when observed. This avoids the common failure where thousands of object IDs consume the entire crawl budget.

### Exit criteria

- No mock accounts or mock endpoint data.
- Discovery can be installed as a local plugin package.
- Plugin install rejects unsafe archive paths.
- Discovery settings survive app replacement.

---

# v0.2.1 Beta: Plugin Browser and Background Updates

Shipped. A point release on the 0.2 plugin foundation, adding distribution and in-app
hosting without expanding the core's scope.

### Plugin distribution

- Public plugin catalog served as static HTTPS JSON, with no account or server.
- Plugin browser with search, categories and publisher details.
- Capabilities shown before install.
- SHA-256 verification of every downloaded package.
- Package manifest must match the catalog entry that advertised it.
- Update badges for installed plugins.
- Configurable catalog source.
- Local file install retained.
- Deterministic package builder and catalog generator.
- Reproducibility and catalog-drift checks in CI.

### Plugin hosting

- Plugins displayed inside the Tracefold window.
- Running plugins reachable from the sidebar.
- Host passes theme and language to the plugin.
- Separate plugin window retained as an option.
- Manifest fallback runtime commands.
- Native package extraction through the existing staged installer.

### Discovery as a plugin

- Runs inside Tracefold; no external browser tab for its interface.
- Chromium only for interactive login and background Playwright work.
- Follows the Tracefold theme in light and dark.
- Data, runtime and Chromium in the persistent plugin directory.
- Reports written to disk and revealable, since a hosted frame cannot download.
- First-launch environment preparation with progress shown in the app.

### Updates

- Automatic checks after launch, hourly, and on window focus, with backoff.
- Background download that interrupts nothing.
- Restart-to-update applies a staged release immediately.
- Silent Windows installation with no installer window and no elevation.
- Save and backup immediately before installation.

### Fixed

- Installing a plugin from a file was unreachable in packaged 0.2.0 builds because the
  capability allowlist named a command that had been replaced.

---

# v0.3.0 Beta: API Workbench

Goal: make Tracefold useful for manual API investigation without leaving the app.

### Features

- HTTP request editor.
- Collections and folders.
- Environments and variables.
- Per-request authentication.
- Cookie jar viewer.
- Headers, query parameters, form data, raw JSON, multipart, and binary bodies.
- Request history.
- Response headers and body viewer.
- Pretty JSON, XML, HTML, and text views.
- Response search.
- Save response examples.
- Request duplication.
- Compare two responses.
- Timing breakdown.
- Redirect history.
- TLS and certificate summary.
- Safe request mode.
- Explicit mutation confirmation.

### Use cases

- Reproduce a frontend API call.
- Check a suspected endpoint manually.
- Compare users against the same request.
- Verify an API change before running a regression suite.

---

# v0.4.0 Beta: Authorization and BOLA Suite

Goal: make object-level authorization testing a first-class workflow.

### Features

- User matrix testing.
- Role matrix testing.
- Object matrix testing.
- Expected status per user.
- Expected body rules.
- JSONPath assertions.
- List filtering checks.
- Direct-ID checks.
- Query-filter bypass checks.
- Path-ID substitution checks.
- Create/update/delete ownership checks.
- Cross-region checks.
- Cross-partner checks.
- Portal versus internal user checks.
- Admin bypass checks.
- ACL versus object-access result comparison.
- BOLA finding generation.
- Re-test comparison.

### BOLA workflow

For each protected object, Tracefold should be able to compare:

- User A sees the object in a list.
- User B does not see it in a list.
- User B requests the known ID.
- User B receives 403 or the configured safe result.
- User A receives the expected success response.
- A 500 response is automatically flagged as a server error.

---

# v0.5.0 Beta: Browser and Flow Automation

Goal: connect API tests with real browser actions.

### Features

- Playwright recorder.
- Browser session profiles.
- Login flow capture.
- SSO and MFA checkpoints.
- Browser-to-API trace correlation.
- Click-to-request mapping.
- Request initiator mapping.
- Route coverage map.
- Browser screenshots linked to steps.
- Browser console capture.
- Network waterfall capture.
- HAR import and export.
- Test flow replay.
- Parameterized browser flows.

### Use cases

- Find exactly which UI action calls `/api/tickets/{id}`.
- Reproduce a bug from login through API failure.
- Test a portal user and an internal user through the same workflow.

---

# v0.6.0 Beta: API Contracts and Change Detection

Goal: catch backend changes before they break frontend behavior.

### Features

- OpenAPI import.
- OpenAPI diff.
- Endpoint inventory.
- Method inventory.
- Request schema diff.
- Response schema diff.
- Required-field change detection.
- Enum change detection.
- Status-code change detection.
- Deprecated endpoint tracking.
- Frontend call versus OpenAPI contract comparison.
- Missing documentation findings.
- Contract coverage report.

---

# v0.7.0 Beta: Security Toolkit

Goal: provide safe, focused web and API security checks without turning the core into a giant scanner.

### Plugin-first security tools

- JWT Inspector.
- Cookie Security Inspector.
- CORS Tester.
- Security Header Inspector.
- GraphQL Security Tester.
- WebSocket Inspector.
- IDOR/BOLA Assistant.
- Rate Limit Tester.
- CSRF Check.
- OAuth/OIDC Flow Inspector.
- SSO Session Inspector.
- API Fuzzing Lab.
- SSRF-safe validation helpers.
- Input validation test generator.

### Safety

Destructive or high-volume tests stay disabled by default. Every active test shows its scope, target, request count, and mutation risk before execution.

---

# v0.8.0 Beta: Plugin Ecosystem

Goal: make plugin distribution safe and easy.

Delivered in v0.2.1: public plugin catalog, categories, search and filters, permissions
shown before install, SHA-256 artifact verification, minimum Tracefold version checks and
plugin API compatibility checks.

### Remaining features

- Publisher pages.
- Version history in the browser.
- Plugin ratings and issue links.
- Signed plugin packages.
- Automatic plugin update checks.
- Rollback to previous plugin version.
- Failed-update recovery.
- Plugin health status.
- Plugin crash logs without collecting user data.

### Developer experience

- Official plugin template.
- Plugin CLI.
- Manifest validator.
- Local development mode.
- Package builder.
- Permission linter.
- Release helper.
- Catalog submission checker.
- Example plugins.

---

# v0.9.0 Beta: Release Candidate

Goal: stop adding large core features and make the platform dependable.

### Hardening

- Full Windows validation.
- Full macOS validation.
- Full Linux validation.
- x64 and ARM64 validation where supported.
- Offline install test.
- Offline launch test.
- Offline workspace test.
- Offline export test.
- Plugin install failure recovery.
- Plugin crash recovery.
- Plugin update rollback.
- Disk-full behavior.
- Permission denial behavior.
- Interrupted save behavior.
- Stale revision behavior.
- Corrupt plugin package behavior.
- Hostile archive path tests.
- Large plugin package tests.
- Large report tests.
- Unicode and long URL tests.

### Performance gates

- Cold launch target measured.
- Warm launch target measured.
- Search target measured at 50k records.
- Memory target measured.
- Idle CPU target measured.
- Large evidence project measured.
- Large API inventory measured.
- Large plugin catalog measured.

No target becomes a release claim until it has been measured on real release builds.

---

# v1.0.0 Official Release

Goal: stable core, stable plugin API, stable Discovery workflow, and safe plugin distribution.

## Core must be stable

- Workspace data format.
- Backup format.
- Portable project format.
- Report snapshot format.
- Plugin manifest format.
- Plugin lifecycle API.
- Permission model.
- Update and rollback behavior.

## Discovery must be production-ready

- Authenticated multi-user crawling.
- Dynamic route deduplication.
- API endpoint inventory.
- Exact URL preservation.
- Called-from mapping.
- Payload and schema inference.
- OpenAPI discovery.
- BOLA regression runner.
- Full-site authenticated checks.
- Search across all results.
- Flawless CSV export.
- Styled Excel export.
- JSON machine-readable export.
- Stable report schema.

## Plugin ecosystem must be stable

- Signed packages.
- Reviewed catalog.
- Automatic updates.
- Rollback.
- Permission review.
- Compatibility checks.
- Developer SDK.
- Submission workflow.
- Versioned plugin API.
- Security policy.

## 1.0 acceptance rule

A feature is not considered stable just because its UI works. It must survive native tests, upgrade tests, failure tests, data-preservation tests, and security checks on supported platforms.

---

# Post-1.0 ideas

These stay outside the 1.0 commitment until the stable platform proves useful in real testing work.

## Tracefold Assistant plugin

A chatbot that understands Tracefold's local test data and can execute safe investigation actions.

Example commands:

- "Find `/api/tickets` and show every page that calls it."
- "Where is `/api/tickets/{id}` called, and which UI action triggers it?"
- "Compare this endpoint for users A and B."
- "Show every endpoint that returned 403 for portal user C."
- "Find endpoints discovered in JavaScript but never seen at runtime."
- "Build BOLA cases from these two accounts and these three IDs."
- "Explain why these two requests are different."

The assistant should use structured tools, not guess from text. Destructive actions always require confirmation.

## Other plugin ideas

### API and backend

- GraphQL Explorer.
- WebSocket Inspector.
- gRPC Inspector.
- SOAP/XML Tester.
- MQTT Inspector.
- Server-Sent Events Inspector.
- OpenAPI Contract Lab.
- API Version Diff.
- API Mock Server.
- Schema Faker.

### Security

- JWT Inspector.
- OAuth/OIDC Inspector.
- Cookie Inspector.
- CORS Lab.
- CSP Inspector.
- Security Headers.
- BOLA/IDOR Lab.
- RBAC Matrix.
- Rate Limit Lab.
- CSRF Lab.
- Fuzzing Lab.
- Secret Leak Scanner.
- Dependency Advisory Scanner.
- TLS Inspector.

### Browser and frontend

- Playwright Recorder.
- Browser Network Timeline.
- Accessibility Auditor.
- Lighthouse-style Performance Lab.
- DOM Snapshot Diff.
- Visual Regression.
- Console and Runtime Error Collector.
- Source Map Explorer.

### Data and infrastructure

- Database Explorer.
- Redis Inspector.
- Log Viewer.
- Docker Test Environment.
- Kubernetes API Inspector.
- DNS and TLS Inspector.
- Environment Variable Inspector.
- S3-Compatible Storage Tester.

### Testing and reporting

- JUnit importer.
- Allure importer.
- Postman importer.
- Insomnia importer.
- Playwright test importer.
- Cypress importer.
- Report builder.
- Jira integration.
- GitHub integration.
- Linear integration.
- Slack/Teams notification.
- CI result publisher.

### Research and investigation

- HAR Analyzer.
- Traffic Graph.
- Endpoint Relationship Graph.
- User Access Graph.
- Object Ownership Graph.
- Timeline Diff.
- Request Replay Queue.
- Evidence OCR.
- Screenshot Comparison.
- PDF Evidence Extractor.

---

# Product principles

1. Core stays small.
2. Plugins own specialist features.
3. User data stays local by default.
4. Secrets never enter normal reports.
5. Exact URLs are preserved.
6. Dynamic IDs are recognized instead of blindly crawled.
7. Destructive requests require explicit approval.
8. A failed plugin must not corrupt Tracefold data.
9. Automatic updates preserve user data.
10. No mock test accounts or fake endpoint results ship with Discovery.
11. The tool should show what it knows, what it observed, and what it inferred.
12. Inference must never be presented as runtime fact.
