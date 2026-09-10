# Full-fidelity backup format, version 1

Tracefold's `.tracefold-backup` file is an offline recovery container. It includes the SQLite snapshot, private content, deleted records, revision history and original evidence. It is not a sanitized report, is not encrypted, and must be stored as carefully as the workspace itself. Use a reviewed `.tracefold` handoff or report to share selected public material.

## User workflow

In Settings → Backup & recovery, **Save backup file…** flushes pending edits, creates a consistent snapshot, then opens a native save dialog. Cancelling the dialog leaves the local snapshot available. A row's **Save file…** exports that particular snapshot. **Restore from file…** verifies the container, hashes, schema, database integrity and evidence before opening an independent project. The original project is not replaced. These controls are native desktop features; the browser preview has separate development storage.

Copy a backup file to another device and restore it there. The receiving Tracefold version must support the stored container and SQLite schema versions. Existing backups without an origin marker are treated as manual snapshots. Language and appearance are workspace settings and do not travel with a project backup. The restored records retain their original text.

## Container layout

All integer fields are unsigned little-endian. The format has no compression, executable entries, paths, links, or archive extraction rules.

| Offset | Field |
|---|---|
| 0 | Eight magic bytes: `54 46 42 4b 0d 0a 1a 0a` |
| 8 | Container version, u32, currently 1 |
| 12 | JSON header byte length, u32, at most 16 MiB |
| 16 | UTF-8 JSON header |
| Following header | Exactly `databaseSize` SQLite bytes |
| Following database | Each asset's original bytes, in manifest order, exactly its declared size |
| End | EOF; trailing bytes are rejected |

The header is `{kind: "tracefold-backup", version: 1, databaseSize, manifest}`. The manifest contains `version`, `info`, `databaseHash`, `assets` and `origin` (`manual` or `automatic`; absent means manual). `info` contains the backup and source project IDs, project name, UTC creation timestamp, total payload size and a descriptive validity field. That validity field is never trusted on import. Each asset contains its lowercase SHA-256 ID/hash, plain filename, MIME type, size and optional image dimensions. Unknown fields are rejected by the native deserializer.

The database is bounded to 512 MiB, each asset to 64 MiB, the header to 16 MiB, the asset count to 100,000 and total payload to 8 GiB. Header sizes must sum exactly to file size. Duplicate asset IDs, non-digest IDs, filenames containing paths, invalid MIME types, mismatched hashes, missing assets, extra database schema objects and unsupported versions are rejected.

Export and import use 64 KiB copy buffers with SHA-256 verification. Export stages a file beside the chosen destination, flushes it, then atomically replaces the destination. A failed verification preserves an existing destination. Import stages inside the workspace, verifies the database in read-only mode against the expected schema, and publishes a new project directory only after all checks pass. Restoring rewrites typed project IDs, records provenance and retains project-scoped record IDs and histories. It does not search and replace user text.

Hashes detect damage; they do not authenticate the sender. Never treat a backup as evidence of authorship.

## Local automatic snapshots

Before an edit, automatic backup is due when there is no previous backup, or when the change sequence differs and 30 minutes have elapsed or the UTC date changed. Pending edits are flushed explicitly for manual exports. The backup captures the database state before the triggering edit; normal saves remain durable in SQLite independently.

Automatic retention keeps the union of the ten newest interval snapshots, the newest snapshot on each of seven recent UTC dates, and the newest snapshot in each of four recent ISO weeks. A single snapshot can satisfy several tiers. Manual and legacy snapshots are not expired. Unknown or damaged snapshot metadata is not automatically deleted. Expired automatic snapshot directories are retired before their two known files are removed. Shared backup blobs are retained conservatively; this version does not garbage-collect them because histories and other snapshots may still refer to them.

## Recovery and limitations

If a restore fails, keep the original file. The operation does not replace the current project. A newer container/schema requires a compatible application; no speculative migration is attempted. Snapshot creation can fail if storage is full or evidence is missing. Such failures are surfaced rather than claiming that the backup succeeded.

Local backups use the same disk as the workspace. Export a backup to another physical device for protection from disk loss. Backups retain original pixels even if the current evidence view has redactions. Use sanitized reports for disclosure.

Automated native checks cover restoration into another workspace and reopening, private/history/trash preservation, byte-exact evidence, truncation, corruption, trailing bytes, unknown versions, oversized headers, unsafe/duplicate metadata, injected schema, retention tiers and preserving an existing destination after failed export. Native dialog and platform release validation are tracked separately in IMPLEMENTATION_STATUS.md.
