# Tracefold plugin catalog

`catalog.json` is the index the Tracefold plugin browser reads. It is public, static and
served over HTTPS, so browsing and installing plugins needs no account, token or server.

Tracefold reads it from:

```
https://raw.githubusercontent.com/Misiix9/Tracefold/main/catalog/catalog.json
```

A team can point Tracefold at its own reviewed catalog without waiting for a new
application version, by setting `TRACEFOLD_PLUGIN_CATALOG` or writing a `catalog-source`
file containing the HTTPS address into Tracefold's plugin storage directory.

That override is deliberately **host configuration, not something the application window
can set**. Checksum verification only proves a package matches the catalog that advertised
it, so whoever chooses the catalog chooses what is trusted — and that decision belongs to
the person at the keyboard, not to a page.

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
node scripts/package-plugin.mjs plugins/<plugin-directory> dist-plugins
node scripts/build-catalog.mjs dist-plugins
```

Then publish the `.tracefold-plugin` file as a release asset under the tag the catalog
entry names, and commit the updated `catalog.json`.

`--check` verifies that the catalog still matches the built packages, and fails if a
checksum has drifted. CI runs it on every change.

Entries that already exist are never rewritten. A published checksum is a promise that a
specific artifact will verify; changing it would break installs that are already in
flight. Ship a new version instead.

If a version has **not** been published yet and its source changed, remove that version
from `catalog.json` and run the generator again. Doing it by hand is deliberate: it should
never be something a build step does on its own.

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
