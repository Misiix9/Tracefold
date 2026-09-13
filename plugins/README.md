# Tracefold Plugins

Tracefold uses loopback-web plugins for specialist tools. Plugins are **trusted local
code**, not sandboxed processes. They run with the same OS-user privileges as Tracefold, so
only install packages you trust.

The host validates plugin IDs, package paths, package limits, manifest compatibility,
loopback declarations, health checks, process lifecycle and atomic replacement. Declared
capabilities are metadata for transparency, not OS-level permission enforcement.

## Installing

Two routes, both ending in the same verified installer:

- **Browse** the public catalog from the Plugins page. Tracefold downloads the package over
  HTTPS and verifies it against the SHA-256 recorded in the catalog before installing it.
  The package's own manifest must also declare the same id and version as the catalog entry
  that advertised it.
- **Install from file** picks a `.tracefold-plugin` package you already have. Nothing is
  downloaded, and the same manifest and package validation applies.

The catalog is a public, static JSON file over HTTPS — no account, token or server. See
[`catalog/README.md`](../catalog/README.md) for its format and for pointing Tracefold at a
different catalog.

## Where plugins run

A plugin is a local process bound to `127.0.0.1` on a port the host allocates. Its
interface is displayed **inside the Tracefold window**, and a running plugin gets its own
sidebar button. "Open in a window" puts the same running plugin in a separate OS window.

The host passes the active theme and language to the plugin as `tracefoldTheme`,
`tracefoldLang` and `host=tracefold` query parameters, so a plugin can match the
application's appearance.

A plugin that supports inline display must allow Tracefold to frame it:

```
Content-Security-Policy: ... frame-ancestors 'self' tauri://localhost http://tauri.localhost https://tauri.localhost
```

and must **not** send `X-Frame-Options`, which cannot express an allowed embedder.

## Available plugins

- `tracefold.discovery` — authenticated website/API discovery and multi-user authorization
  testing. See [`tracefold-discovery/`](tracefold-discovery/).

## Building a package

```bash
node scripts/package-plugin.mjs plugins/<directory> dist/plugins
node scripts/build-catalog.mjs dist/plugins
```

`package-plugin.mjs` produces a deterministic archive — sorted entries, fixed timestamps,
normalised permissions — so the same source always yields the same SHA-256. That matters
because the catalog pins each release by checksum.

## Planned plugins

The product roadmap covers API Workbench, BOLA, Browser Automation, API Contracts, GraphQL,
WebSocket, Security Toolkit, Accessibility, Performance, Reporting, CI and the Tracefold
Assistant.

These are roadmap items, not installable entries. A plugin appears in the catalog only when
a real package exists and passes plugin validation.
