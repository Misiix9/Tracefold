# In-app updates and releases

Tracefold looks for a newer compatible release on its own: shortly after opening, every
hour while running, and when its window regains focus (at most once every fifteen minutes).
An unreachable feed backs off instead of retrying continuously. No user action is required
for an update to be found.

When a release exists, Tracefold downloads it **quietly in the background**. Nothing is
interrupted: no progress overlay appears, work continues, and nothing is installed. Once the
artifact is staged, a purple **Restart to update** action appears above the divider
preceding Settings (localized in Hungarian). Clicking it saves pending edits, pauses active
session timers, backs up every project, installs the staged update and restarts into the new
version.

Saving and backing up happen immediately before installation rather than before the
download, so the recovery snapshot covers everything written while the download was running.
A failure to save or back up still prevents installation.

Windows updates are silent: no installer window, no user interaction, no administrator
prompt. Tracefold installs per user, so the update applies and the application relaunches on
its own. macOS and Linux replace the application in place. Users never visit GitHub or
download an installer themselves.

If the background download fails, nothing changes: the update is still offered, and clicking
it downloads again. A failed restart can be retried without downloading or installing again,
after saving any edits made in between.

The workspace has no application server or account. GitHub Releases serves public, static
update files over HTTPS. Offline or unavailable-feed checks are quiet and do not interrupt
testing. The plugin verifies the artifact against the embedded public key before
installation. An interrupted check or invalid download cannot trigger installation.

## Data preservation

The stable application identifier is `local.tracefold.desktop`. Local projects, evidence, history and settings are stored in the OS application-data directory, outside the installed application. Releases must retain that identifier and storage layout; any future schema migration requires compatibility and recovery tests. The update flow flushes edits and settings and creates a recovery backup for every project before installing. Failure to save or back up prevents installation. Active capture, evidence import, annotation save, report export and backup/restore operations block an update until they finish. No updater invokes uninstall/data-removal commands.

## Publishing

1. Update the same version in package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json; refresh lockfiles.
2. Complete the release checks and add `docs/releases/vX.Y.Z.md` with user-facing changes and actual known limitations.
3. Commit, then push the matching `vX.Y.Z` tag. The build workflow tests and builds Windows x64, macOS Intel/Apple Silicon universal and Linux x64 packages natively.
4. The publish job independently verifies every update signature, prepares per-platform URLs and signatures in `latest.json`, adds SHA-256 checksums, uploads everything to a draft release, then publishes the complete release. A failed platform build or signature check prevents publication.
5. Verify public download URLs, the update feed and an actual installed-version upgrade before announcing availability. Never replace an existing version's assets: publish a new version for fixes.

The static endpoint uses GitHub's latest release. A beta distributed through this channel must therefore be a normal GitHub release with **Beta** in its title/notes, not GitHub's prerelease flag. Do not mark a release available before all artifacts are uploaded. Tags publish externally and should only be pushed once the beta is approved for distribution by its acceptance checks.

The private signing key is supplied through the repository's `TAURI_SIGNING_PRIVATE_KEY` Actions secret. Keep an independent secure backup outside Git. The public key is safe to commit. Updater signing is separate from Apple notarization and Windows Authenticode signing; do not represent an updater signature as OS notarization or publisher certification.

## Validation status

Controller tests cover unavailable/offline feeds, backup failure, download/signature failure, ordered download/save/install/restart, background staging, a failed background download falling back to an on-click download, concurrent requests, restart retry, the hourly schedule with failure backoff, and focus-triggered rechecking with throttling. Component tests cover hidden/available/staged states, both languages and progress. Native version-to-version installation, post-update data retention and platform permission behavior are separate acceptance checks; passing unit tests alone is not proof of those checks.

Reference: [Tauri updater documentation](https://v2.tauri.app/plugin/updater/).

On 11 September 2026, the isolated macOS Update QA installation advanced from 0.0.9 to 0.1.0 through the signed local update feed and relaunched. A post-update comparison found project payloads, record payloads, all revisions and evidence SHA-256 hashes identical to the pre-update snapshot. The English preference persisted. This validates the native updater mechanism with an isolated local feed, not the public GitHub distribution path or Windows update installation.

## Installed version

Settings displays the running application version using Tauri `getVersion()`. This remains accurate offline. The GitHub feed describes the available release separately and never replaces the installed version badge. Both labels and error states are localized.
