# Tracefold plugin catalog

`catalog.json` is the index the Tracefold plugin browser reads. It is public, static and
served over HTTPS, so browsing and installing plugins needs no account, token or server.

Tracefold reads it from:

```
https://raw.githubusercontent.com/Misiix9/Tracefold/main/catalog/catalog.json
```

The URL is not hardcoded into a release: a team can point Tracefold at its own reviewed
catalog without waiting for a new application version.

## What Tracefold verifies

The catalog is data, not a trusted instruction. Before anything is installed the host:

1. rejects the catalog unless it is served over HTTPS and matches `tracefold.catalog.v1`;
2. rejects any package URL that is not absolute HTTPS, and refuses to follow a redirect
   that leaves HTTPS;
3. downloads the package under the 256 MiB package limit;
4. verifies the download against the `sha256` recorded here, and discards it on mismatch;
5. requires the manifest inside the package to declare the same id and version as the
   catalog entry that advertised it;
6. validates the manifest, package paths and size limits exactly as for a local install.

The plugin browser never sends a URL to the host. It asks for an id and a version, and the
host resolves both against the catalog it fetched itself.

## Adding a version

```bash
node scripts/package-plugin.mjs plugins/<plugin-directory> dist/plugins
node scripts/build-catalog.mjs dist/plugins
```

Then publish the `.tracefold-plugin` file as a release asset under the tag the catalog
entry names, and commit the updated `catalog.json`.

Entries that already exist are never rewritten. A published checksum is a promise that a
specific artifact will verify; changing it would break installs that are already in
flight. Ship a new version instead.

## Entry format

```json
{
  "schema": "tracefold.catalog.v1",
  "updated": "2026-09-13T00:00:00.000Z",
  "plugins": [
    {
      "id": "example.plugin",
      "name": "Example Plugin",
      "publisher": "Your name",
      "description": "What it does.",
      "category": "Discovery",
      "homepage": "https://example.com/plugin",
      "versions": [
        {
          "version": "1.0.0",
          "apiVersion": 1,
          "minTracefoldVersion": "0.2.1",
          "url": "https://example.com/example-plugin-v1.0.0.tracefold-plugin",
          "sha256": "<64 hex characters>",
          "size": 12345,
          "capabilities": ["network.targeted-http"],
          "published": "2026-09-13T00:00:00.000Z",
          "notes": "User-facing changes."
        }
      ]
    }
  ]
}
```

A version whose `apiVersion` or `minTracefoldVersion` this build cannot run is shown with
the reason rather than hidden, so it is clear why a plugin is unavailable.
