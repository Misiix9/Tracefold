# Persistent project requirements

Updated 10 September 2026 from the user's instructions. This file is durable project context for subsequent sessions; it is not a claim of global assistant memory.

- Continue implementing the complete PRODUCT_SPEC.md contract. Do not label unfinished or unverified work complete.
- Deliver a usable Beta 0.1 for coworkers, with a Windows Setup.exe and a macOS application installed locally with Desktop access. The current host is macOS; a Windows EXE cannot be installed as a native macOS application.
- Use Git and GitHub for source history, reproducible builds, and versioned releases. Keep signing keys and workspace data out of Git.
- Hungarian is the initial/default UI language; support English and immediate persistent language switching in Settings.
- Add an updater action immediately above Settings in the sidebar. Its English text is “Update to newest version”; Hungarian text is localized. Use a purple treatment matching the app's restrained palette. Show the action only after discovering a newer compatible release.
- Clicking the action saves pending work, creates recovery backups, verifies the signed artifact, installs the newer version, and restarts while preserving local projects, evidence, history and settings. Failed checks/downloads must leave the installed app and data usable. Never embed release-publishing credentials in clients.
- The testing workspace remains offline; update checks/downloads are the explicitly authorized network exception. No telemetry, accounts or application server are introduced.
- Tell the user when the coworker beta is actually available. Do not claim native Windows capture or installation was tested based solely on cross-compilation.
- User confirmed public source and public release downloads on 10 September 2026. Use the signed-in Misiix9 account.
