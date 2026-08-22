# Releasing Harness for macOS

Production releases are signed and notarized macOS arm64 and x64 builds published to the public
`serolo/Harness` GitHub repository. The workflow uploads assets to a **draft** release; a human
promotes the draft only after inspecting and smoke-testing it. Never use the unsigned
`npm run package` output as a production release.

The `App Bundle` workflow also uses the release signing configuration and fails closed when Apple
credentials are unavailable. Its downloadable artifact is explicitly named
`Harness-signed-notarized-macOS-<arch>-<sha>`. Do not distribute artifacts from older workflow runs named
`Harness-macOS-<sha>`; those DMGs were unsigned development packages and Gatekeeper may report them
as damaged.

## Required GitHub Actions secrets

- `MAC_CSC_LINK`: base64-encoded Developer ID Application `.p12`
- `MAC_CSC_KEY_PASSWORD`: password for that `.p12`
- `APPLE_API_KEY`: base64-encoded App Store Connect `.p8` notarization key
- `APPLE_API_KEY_ID`: App Store Connect key ID
- `APPLE_API_ISSUER`: App Store Connect issuer UUID
- `APPLE_TEAM_ID`: Apple Developer team ID

`GITHUB_TOKEN` is supplied by GitHub Actions and is scoped to `contents: write` only for the final
release publishing job. The architecture build jobs retain read-only repository access. None of
these values belongs in source, logs, release notes, packaged resources, renderer
payloads, or local `.env` files.

Rotate a certificate or API key by creating its replacement first, updating the corresponding
GitHub secrets, proving a release candidate, and only then revoking the old credential. Record the
rotation date and owner in the team's secret-management system. Never commit the decoded `.p12` or
`.p8`; the workflow materializes them in `RUNNER_TEMP` with mode `0600` and removes them before the
GitHub draft/upload step.

## Prepare a release

1. Choose an explicit semver version. Update `package.json` and `package-lock.json` together; the
   release workflow rejects `0.0.0`.
2. Run `bash ci/harness-gates.sh` and review all user-facing changes.
3. Commit the version change, then create an annotated tag whose value exactly matches
   `v${package.version}`. Never move or reuse a published tag.
4. Push the commit and tag. The tag-gated `Release` workflow verifies the tag points at the checked
   out commit, rebuilds native modules, and runs the full gate. It then builds, signs, and notarizes
   arm64 and x64 candidates on matching native runners with publishing disabled. Each build verifies
   signatures, Gatekeeper assessment, stapling, update metadata, native-module architecture, and
   artifact hashes. A final token-scoped job verifies both handoffs, combines their updater metadata,
   creates the draft, and uploads those exact verified files.

The workflow may also be started manually with an **existing** `v`-prefixed tag. Manual dispatch is
not an escape hatch: the same tag/version, signing, notarization, metadata, and draft checks apply.

## Inspect and promote the draft

Before publishing, confirm the draft contains both architecture-specific `.dmg` and `.zip` files,
their four `.blockmap` files, and one combined `latest-mac.yml` (nine assets total). The zip files
are required for Squirrel.Mac update metadata. Download the arm64 candidate to a clean Apple-silicon
Mac and the x64 candidate to a clean Intel Mac, then confirm on each:

- Gatekeeper accepts the app and the notarization ticket is stapled.
- Harness launches and both `better-sqlite3` and `node-pty` paths work.
- `Contents/Resources/app-update.yml` identifies the public `serolo/Harness` GitHub provider.
- No signing, notarization, or GitHub credential appears in the bundle, metadata, or logs.

Only after those checks should a human edit the draft release notes and choose **Publish release**.
Stable clients ignore drafts and prereleases.

The upload step never replaces an existing asset. A retry may reuse an empty draft, but it fails if
the tag's draft already contains assets. If an interrupted upload leaves a partial draft, inspect it,
delete that unpublished draft in GitHub, and rerun the workflow; never delete, replace, or overwrite
assets on a published release.

## Bootstrap and update smoke test

Existing `0.0.0` builds are unsigned and contain no update metadata, so they cannot discover the
new channel. Build, inspect, and publish signed/notarized `v0.1.0`, then distribute its DMG once
through the existing manual download path.

To prove remote updates, use a clean test profile with no irreplaceable data:

1. Install and launch the published `v0.1.0`.
2. Prepare, draft-check, and publish `v0.1.1`.
3. Launch `v0.1.0`. The automatic check must stay silent while checking/downloading and open exactly
   one modal when the download is ready.
4. Choose **Later**. Confirm `v0.1.0` keeps running and quitting does not install the update.
5. Use the command palette's **Check for Updates** command. Confirm it reopens the downloaded state.
6. Choose **Restart and update**. Confirm Harness exits, installs, relaunches as `v0.1.1`, and
   preserves the clean profile's projects, workspaces, and settings.
7. Exercise offline, no-update, GitHub outage, corrupt metadata, and unsigned local-build paths.
   Automatic failures stay silent; a manual check remains recoverable.

Record the tested versions, macOS/hardware version, artifact checksums, and results in the release.

## Rollback

GitHub release versions are forward-only. Never replace assets on a published tag, move the tag, or
publish a lower version. Revert the faulty code, increment to a higher patch version, run the entire
release process again, and publish that corrective release. If impact warrants it, leave the bad
release documented and clearly direct users to the higher fixed version.
