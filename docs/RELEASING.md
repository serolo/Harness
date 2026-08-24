# Releasing Harness

Production releases contain macOS arm64/x64, Windows x64, and Linux x64 builds published to the
public `serolo/Harness` GitHub repository. The workflow creates a **draft** release; a human promotes
it only after inspecting and smoke-testing the installers. Never distribute an unsigned local
`npm run package` output as a production release.

The manual-only `App Bundle` workflow builds the same platforms without publishing a GitHub
release. macOS remains signed and notarized, while Windows artifacts are explicitly unsigned test
builds until CI-compatible Authenticode signing is configured. Linux has no platform-standard
code-signing requirement. Never distribute the unsigned Windows App Bundle artifacts as a
production release.

## Required production release secrets

The macOS App Bundle also uses its macOS signing/notarization secrets. The unsigned Windows App
Bundle does not use either Windows signing secret.

- `MAC_CSC_LINK`: base64-encoded Developer ID Application `.p12`
- `MAC_CSC_KEY_PASSWORD`: password for that `.p12`
- `APPLE_API_KEY`: base64-encoded App Store Connect `.p8` notarization key
- `APPLE_API_KEY_ID`: App Store Connect key ID
- `APPLE_API_ISSUER`: App Store Connect issuer UUID
- `APPLE_TEAM_ID`: Apple Developer team ID
- `WIN_CSC_LINK`: base64-encoded Authenticode code-signing `.pfx`
- `WIN_CSC_KEY_PASSWORD`: password for that `.pfx`

`GITHUB_TOKEN` is supplied by GitHub Actions and receives `contents: write` only in the final
publishing job. Build and verification jobs have read-only repository access. Credentials must not
appear in source, logs, release notes, packaged resources, renderer payloads, or local `.env` files.
The workflows decode certificates under `RUNNER_TEMP`, use them only for signing, and remove them
in an `always()` step.

Rotate credentials by installing their replacements in GitHub secrets and proving an App Bundle
run before revoking the old credentials. Record the owner and rotation date in the team's secret
manager.

## Prepare a release

1. Choose a stable semver version and update `package.json` and `package-lock.json` together. The
   workflow rejects `0.0.0` and prerelease versions.
2. Run `bash ci/harness-gates.sh` and review all user-facing changes.
3. Commit the version, then create an annotated tag exactly matching `v${package.version}`. Never
   move or reuse a published tag.
4. Push the commit and tag. The tag-triggered workflow verifies the tag/version, runs the repository
   gate, and then builds all four release candidates on native GitHub runners.

Manual dispatch accepts an **existing** `v`-prefixed tag and applies the same validation. It is not
an escape hatch around version, signing, notarization, architecture, or metadata checks.

Each platform job rebuilds `better-sqlite3` and `node-pty` for Electron, verifies the main executable
and native-module architecture, checks updater metadata, hashes its handoff, and uploads a one-day
intermediate artifact. macOS additionally verifies Developer ID signatures, Gatekeeper assessment,
notarization, and stapling. Windows verifies Authenticode on the application and NSIS installer.
The final job has no signing credentials: it verifies all hashes, merges macOS metadata, creates an
empty GitHub draft, and uploads only the verified handoffs.

## Expected draft assets

The draft contains 16 files:

- macOS: arm64 and x64 `.dmg`/`.zip` files, four blockmaps, and one merged `latest-mac.yml` (9)
- Windows x64: signed NSIS `.exe`, its blockmap, and `latest.yml` (3)
- Linux x64: `.AppImage`, AppImage blockmap, `.deb`, and `latest-linux.yml` (4)

The zip, NSIS, and AppImage assets are required by `electron-updater`; do not delete them while
keeping their metadata. The publisher refuses to overwrite assets or append to a non-empty draft.
If an interrupted upload leaves a partial unpublished draft, inspect and delete that draft before
rerunning. Never replace assets on a published release.

## Smoke test and publish

Download each candidate on clean hardware or a clean VM:

- macOS arm64 and Intel: install the DMG, confirm Gatekeeper accepts it, and validate the stapled
  notarization ticket.
- Windows x64: run the NSIS installer, confirm Windows reports a valid publisher signature, and
  launch from the installed shortcut.
- Linux x64: run the AppImage and install the `.deb` on a Debian/Ubuntu test system.
- On every platform, create a project/worktree, start a terminal, run a Claude/Codex turn, exercise
  `better-sqlite3`, and confirm `app-update.yml` points to public `serolo/Harness` releases.

Then publish the draft and test an update from the preceding stable version. Automatic checks should
stay silent until a download is ready; **Later** must keep the current version running, and
**Restart and update** must install, relaunch, and preserve projects, workspaces, and settings.
Exercise offline, no-update, corrupt-metadata, and unsigned-development-build paths too. Record the
OS versions, architectures, application versions, checksums, and results in the release notes.

Stable clients ignore drafts and prereleases. Releases are forward-only: fix a bad release by
reverting the code, incrementing to a higher patch version, and running the complete process again.
