# Tracefold Discovery

Authenticated website and API discovery with multi-user authorization testing, packaged as
a Tracefold plugin.

Discovery crawls a site as a saved user, captures live `fetch`/XHR traffic, scans
JavaScript bundles, finds OpenAPI documents, and maps every endpoint back to the pages
that call it. It then runs saved requests as several users and compares what each one is
allowed to see.

## Running inside Tracefold

Discovery is displayed **inside the Tracefold window**, reachable from the Plugins page or
from its own sidebar button while it is running. It follows Tracefold's theme and language.
It never opens an external browser tab for its own interface.

Chromium opens only where a browser is genuinely required:

- headed, for an interactive login you complete yourself;
- headless, in the background, for authenticated Playwright crawling.

## First launch

Discovery needs FastAPI, Playwright and a private Chromium build, which are far larger than
a plugin package may contain. The first launch therefore prepares a private environment and
shows its progress inside the Tracefold window.

It creates, under the plugin's persistent data directory:

- `runtime/` — a private virtual environment with Discovery's Python dependencies;
- `browsers/` — Discovery's own Chromium build.

This happens once. Updating the plugin keeps both, and keeps every account, session, test
case, scan and report.

Requirements: Python 3.11 or newer on `PATH`, as `python3`, `python` or `py`. On Debian and
Ubuntu, `python3-venv` must also be installed.

If Chromium cannot be downloaded, Discovery still starts and reports it: bearer-token
discovery and test runs keep working, and browser login does not.

## Where data lives

Everything Discovery stores — settings, accounts, encrypted sessions, test cases, scans,
test-run results and saved reports — lives in the persistent plugin data directory that
Tracefold supplies, never inside the installed plugin code. Data from an earlier standalone
installation is carried over once, and never overwrites anything already present.

## Reports

A hosted plugin has nowhere to download to, so Discovery writes reports itself and tells
you where they went. Saved reports land in `exports/` inside the plugin data directory, and
the confirmation offers to show the file in your file manager. Only files Discovery wrote
there can be revealed.

Running Discovery standalone in a browser keeps the ordinary download behaviour.

Every completed run exports Excel-ready CSV (UTF-8 with BOM, semicolon delimited), a styled
`.xlsx` workbook, and complete JSON.

## Security

- Only scan systems you own or have clear permission to test.
- The server listens only on `127.0.0.1`, and the page can only be displayed inside
  Tracefold's own window.
- Account secrets and Playwright sessions are encrypted at rest; the OS keychain stores the
  vault key where one is available.
- Credentials are sent only to the account's base origin and its explicitly allowed API
  origins.
- Tokens, passwords, cookies and common secret fields are redacted from reports.
- Mutating test cases require the exact confirmation `I AM AUTHORIZED`.

Plugins are trusted local code. They run as your OS user and are not sandboxed by
Tracefold.

## Building the package

```bash
node scripts/package-plugin.mjs plugins/tracefold-discovery dist/plugins
```

This produces a deterministic `.tracefold-plugin` archive and a metadata file recording its
SHA-256, which `scripts/build-catalog.mjs` turns into a catalog entry.

## Tests

```bash
cd plugins/tracefold-discovery
python -m venv .venv && . .venv/bin/activate
python -m pip install -r requirements.txt pytest pytest-asyncio
python -m pytest
```
