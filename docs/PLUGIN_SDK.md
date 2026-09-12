# Tracefold Plugin SDK v1

Tracefold plugins are isolated tools that extend the desktop app without putting specialist code inside the core workspace.

## Runtime model

The first runtime is `loopback-web`.

A plugin is an ordinary package containing a root `manifest.json` and an entrypoint. Tracefold installs it under its private application data directory, starts it on `127.0.0.1`, and opens it in a separate Tauri window.

The plugin never receives direct access to the Tracefold SQLite database.

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
    "command": "python",
    "args": ["run.py", "--port", "{port}"],
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

## Reserved runtime variables

Tracefold expands these values in runtime arguments:

- `{port}`: an unused local loopback port.
- `{pluginDir}`: the installed plugin directory.
- `{dataDir}`: the plugin's persistent data directory.

The host also provides:

- `TRACEFOLD_PLUGIN_ID`
- `TRACEFOLD_PLUGIN_DATA_DIR`
- `TRACEFOLD_PLUGIN_PORT`

## Security rules

Plugins must:

1. Bind only to `127.0.0.1` unless a future capability explicitly permits another interface.
2. Declare every capability in the manifest.
3. Never collect secrets without explaining why the capability is required.
4. Never modify Tracefold project files directly.
5. Keep plugin data under the supplied data directory.
6. Treat all imported target data as untrusted.
7. Require confirmation before destructive testing.
8. Keep reports free of passwords, cookies, bearer tokens, and private keys.

Tracefold rejects absolute paths, parent traversal, backslashes, oversized packages, invalid IDs, and unsupported manifest schemas during installation.

## Local development

The simplest development workflow is:

1. Build the plugin in its own repository.
2. Start its loopback server on a local port.
3. Install the plugin package into a development Tracefold workspace.
4. Verify the manifest and capabilities.
5. Test enable, disable, start, stop, update, and removal.

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
- test harnesses for plugin permissions.
