# In-app updates and releases

## Finding a release

Tracefold polls the release feed on its own: shortly after launch, on the configured
interval (every minute by default), and whenever its window regains focus.

A poll is deliberately cheap. Rather than running a full update check, Tracefold sends a
**conditional request** for the feed, carrying the `ETag`/`Last-Modified` it saw last time.
An unchanged feed is answered with `304 Not Modified` and no body — a few hundred bytes,
no parsing, no download prepared. Only when the feed actually changes does the real check
run. That is what lets the interval be short without the traffic frequent full checks
would cost.

The probe fails open: a network error, a proxy, or a server that ignores conditional
requests all result in the full check running anyway, so a probe that cannot do its job is
never a reason to miss a release. An unreachable feed backs off instead of retrying
continuously.

There is no push channel, because that would require a server and this workspace has none.
Detection is therefore as fast as the poll interval, not literally instantaneous.

The interval is configurable in Settings, from every minute to once a day.

## Installing

**With automatic updates on** (the default), a found release is downloaded quietly in the
background and then applied:

- **At launch**, within the first minute, it installs and restarts by itself. Nothing is in
  progress at that point, so it is the least disruptive moment there will be.
- **Mid-session**, Tracefold asks. A dialog offers **Restart now** or **Later**; choosing
  Later keeps the staged update, which is applied at the next restart. Restarting out from
  under someone who is typing is not something the application does unprompted.

**With automatic updates off**, the release is still staged in the background and a purple
**Restart to update** action appears above the divider preceding Settings.

While an update is applying, a dialog shows each step — downloading, saving and backing up,
installing, restarting — with download progress and a reminder that local data stays on the
device.

Saving and backing up happen immediately before installation rather than before the
download, so the recovery snapshot covers everything written while the download was
running. A failure to save or back up still prevents installation.

Windows updates are silent: no installer window, no user interaction, no administrator
prompt. Tracefold installs per user, so the update applies and the application relaunches on
its own. macOS and Linux replace the application in place. Users never visit GitHub or
download an installer themselves.

If the background download fails, nothing changes: the update is still offered, and clicking
it downloads again. A failed restart can be retried without downloading or installing again,
after saving any edits made in between.

The workspace has no application server or account. GitHub Releases serves public, static
update files over HTTPS. Offline checks are quiet and do not interrupt testing. The plugin
verifies the artifact against the embedded public key before installation. An interrupted
check or invalid download cannot trigger installation.

## Plugin updates

Installed plugins are reconciled against the catalog on their own interval (every fifteen
minutes by default). Each installed plugin shows its available version on the Plugins page
with a one-click **Update**.

With **Keep plugins up to date automatically** on, updates are applied in the background —
but never to a plugin that is running or open, because replacing its code would stop it
mid-task. Those wait until the plugin is idle, and the Plugins page shows the update in the
meantime.

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

Controller tests cover unavailable/offline feeds, backup failure, download/signature failure, ordered download/save/install/restart, background staging, a failed background download falling back to an on-click download, concurrent requests, restart retry, the polling schedule with failure backoff, focus-triggered rechecking with throttling, the conditional probe skipping full checks and failing open, unattended installation at launch, prompting instead of restarting mid-session, and never installing unattended when the setting is off. Plugin tests cover per-plugin update detection, automatic application only when enabled, and never replacing a running or open plugin. Component tests cover hidden/available/staged states, both languages and progress. Native version-to-version installation, post-update data retention and platform permission behavior are separate acceptance checks; passing unit tests alone is not proof of those checks.

Reference: [Tauri updater documentation](https://v2.tauri.app/plugin/updater/).

On 11 September 2026, the isolated macOS Update QA installation advanced from 0.0.9 to 0.1.0 through the signed local update feed and relaunched. A post-update comparison found project payloads, record payloads, all revisions and evidence SHA-256 hashes identical to the pre-update snapshot. The English preference persisted. This validates the native updater mechanism with an isolated local feed, not the public GitHub distribution path or Windows update installation.

## Installed version

Settings displays the running application version using Tauri `getVersion()`. This remains accurate offline. The GitHub feed describes the available release separately and never replaces the installed version badge. Both labels and error states are localized.
