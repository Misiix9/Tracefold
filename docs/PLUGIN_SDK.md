# Tracefold Plugin SDK v1

Tracefold plugins extend the desktop app without putting specialist code inside the core workspace.

**Important beta security model:** plugins are trusted local code. They run as the same OS user as Tracefold and are **not sandboxed by Tracefold**. Do not install a plugin package unless you trust its publisher and source. The capability list is currently declarative metadata for transparency, not an OS-level permission boundary.

## Runtime model

The first runtime is `loopback-web`.

A plugin is an ordinary package containing a root `manifest.json` and an entrypoint. Tracefold installs it under its private application data directory, starts it on `127.0.0.1`, and displays it inside the main Tracefold window. A running plugin also gets its own sidebar button, and can be opened in a separate window on request.

### Being displayed inside Tracefold

The host loads the plugin's root URL in a frame and appends:

- `tracefoldTheme=light|dark` — the appearance the user is running;
- `tracefoldLang=hu|en` — the active UI language;
- `host=tracefold` — the plugin is hosted rather than standalone.

A plugin that supports inline display must allow exactly that embedder and no other:

```
Content-Security-Policy: ... frame-ancestors 'self' tauri://localhost http://tauri.localhost https://tauri.localhost
```

It must **not** send `X-Frame-Options`: the header cannot name an allowed embedder, so any
value blocks the host.

When the user changes theme or language while the plugin is open, the host **posts a
message** rather than reloading the frame, so nothing in progress is lost:

```js
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (event.data?.type !== 'tracefold:appearance') return;
  // event.data.theme is 'light' or 'dark'; event.data.language is 'hu' or 'en'
});
```

Check `event.source` before acting: only the window that embedded the page may change its
appearance.

Browser-style downloads do not work in a hosted frame. A plugin that produces files should
write them into its own data directory and report the path, rather than relying on
`Content-Disposition`.

The host keeps the plugin URL and allocated port in host-owned runtime state rather than trusting files inside the plugin directory.

Plugin persistent data is stored outside the installed code directory, so replacing a plugin package does not erase its persistent data.

## Manifest

```json
{
  "schema": "tracefold.plugin.v1",
  "id": "example.plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "publisher": "Your name",
  "description": "A useful Tracefold extension.",
  "apiVersion": 1,
  "minTracefoldVersion": "0.2.0",
  "runtime": {
    "type": "loopback-web",
    "entry": "run.py",
    "command": "python3",
    "commandCandidates": ["python", "py"],
    "args": ["run.py", "--port", "{port}", "--data-dir", "{dataDir}"],
    "health": "/api/health",
    "bind": "127.0.0.1"
  },
  "capabilities": ["network.targeted-http"],
  "dataPolicy": {
    "persistentDirectory": ".tracefold",
    "telemetry": false,
    "accountRequired": false
  }
}
```

`commandCandidates` is optional. When `command` is not found, each candidate is tried in
order, so one package works where an interpreter is named `python3` on one machine and `py`
on another.

## Reserved runtime variables

Tracefold expands these values in runtime arguments:

- `{port}`: an unused local loopback port.
- `{pluginDir}`: the installed plugin directory.
- `{dataDir}`: the plugin's persistent data directory.

The host also provides:

- `TRACEFOLD_PLUGIN_ID`
- `TRACEFOLD_PLUGIN_VERSION`
- `TRACEFOLD_PLUGIN_API_VERSION`
- `TRACEFOLD_PLUGIN_BIND`
- `TRACEFOLD_PLUGIN_PORT`
- `TRACEFOLD_PLUGIN_DATA_DIR`

## Security and package rules

Plugins are trusted local code. The beta host does **not** provide an OS sandbox, filesystem sandbox, network sandbox, or secret-store permission boundary.

The host does enforce package/runtime hygiene:

1. Plugin IDs must be safe single path components and cannot be `.` or `..`.
2. Package paths cannot be absolute, use backslashes, or contain parent/current-directory components.
3. Packages are staged before installation and existing versions are preserved until the replacement succeeds.
4. Failed replacement restores the previous plugin when possible.
5. Installed plugin code and persistent plugin data live in separate directories.
6. `loopback-web` manifests must declare `127.0.0.1` and a local health path.
7. Runtime readiness requires an actual HTTP 2xx response from the declared health endpoint.
8. Plugin processes are reaped when they exit, and stop/shutdown terminates the process tree.
9. Package and unpacked-file limits are enforced while files are streamed into host-owned staging storage.
10. Destructive plugin actions in the UI require explicit confirmation where appropriate.

Plugin authors must:

- declare every capability in the manifest;
- never collect secrets without explaining why the capability is required;
- never modify Tracefold project files directly unless a future, explicit host API permits it;
- keep plugin data under the supplied data directory;
- treat all imported target data as untrusted;
- require confirmation before destructive testing;
- keep reports free of passwords, cookies, bearer tokens, and private keys.

## Distribution

Two install routes share one verified installer.

A package installed **from the catalog** is downloaded over HTTPS and verified against the
SHA-256 the catalog records, before any byte reaches plugin storage. Its manifest must also
declare the same id and version as the catalog entry that advertised it, so a catalog entry
cannot quietly ship a different plugin. The plugin browser never supplies a URL: it asks for
an id and version, and the host resolves both against the catalog it fetched itself.

A package installed **from a file** skips only the download and checksum steps; manifest
validation, package limits and atomic replacement are identical.

Build a package with:

```bash
node scripts/package-plugin.mjs plugins/<directory> dist/plugins
```

The archive is deterministic, so rebuilding the same source reproduces the same checksum.

## Local development

The simplest development workflow is:

1. Build the plugin in its own repository.
2. Start its loopback server on a local port.
3. Install the plugin package into a development Tracefold workspace.
4. Verify the manifest and capabilities.
5. Test enable, disable, start, stop, update, rollback, and removal.

## Discovery plugin

`tracefold.discovery` is the first real plugin package. It provides authenticated browser discovery, API mapping, route-shape deduplication, multi-user endpoint testing, and detailed exports.

Its settings and accounts live outside the plugin code directory. Updating the plugin therefore does not erase user data.

## Future SDK work

The SDK will grow toward:

- typed Tracefold API access through narrow capabilities;
- project-scoped evidence creation;
- findings and test-run integration;
- plugin settings UI;
- signed publisher identity;
- catalog submission metadata;
- compatibility negotiation;
- background update checks;
- rollback hooks;
- test harnesses for plugin permissions;
- OS-level sandboxing and capability enforcement.
