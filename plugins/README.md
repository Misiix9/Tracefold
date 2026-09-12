# Tracefold Plugins

Tracefold uses loopback-web plugins for specialist tools. In the 0.2 beta, plugins are **trusted local code**, not sandboxed processes. They run with the same OS-user privileges as Tracefold, so only install packages you trust.

The host still validates plugin IDs, package paths, package limits, manifest compatibility, loopback declarations, health checks, process lifecycle, and atomic replacement behavior. Declared capabilities are currently metadata for transparency, not OS-level permission enforcement.

## First plugin

- `tracefold.discovery`: authenticated website/API discovery and multi-user authorization testing.

The Discovery package is distributed as a reviewed `.tracefold-plugin` artifact. Tracefold does not silently download and execute plugin code from an unknown source.

## Planned plugins

The product roadmap covers API Workbench, BOLA, Browser Automation, API Contracts, GraphQL, WebSocket, Security Toolkit, Accessibility, Performance, Reporting, CI, and the Tracefold Assistant.

These are roadmap items, not fake installed plugins. They become installable only when a real package exists and passes the plugin validation suite.
