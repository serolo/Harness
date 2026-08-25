# Application updater invariants

This subsystem is the main-process trust boundary around `electron-updater`.

- `UpdateService` is the single observable state machine. Every transition goes through
  `setStatus`, stores a clone-safe snapshot, and synchronously broadcasts a cloned snapshot.
- The real updater is injected only for a packaged build with valid embedded `app-update.yml`
  metadata for the public `serolo/Harness` GitHub repository. Development, unsigned local, missing,
  or corrupt-metadata builds stay network-free and report `unsupported`.
- Stable-channel consent is fixed: `autoDownload = true`, `autoInstallOnAppQuit = false`, and
  `allowPrerelease = false`. Installation remains gated on the `downloaded` state.
- `update:getStatus` is hydration only; `update:check` alone starts network work; `update:install`
  alone may restart and install. No feed URL, path, token, channel, or install flag is accepted from
  the renderer.
- Updater errors are logged technically in main and reduced to a concise renderer-safe message.
  Never expose credentials, signed URLs, filesystem paths, raw updater objects, or release secrets.
- Embedded metadata validation and updater import stay behind the injected `loadReleaseUpdater`
  seam. Invalid/missing metadata must return before the importer is called.
- Resolve `electron-updater` through `autoUpdaterFromModule`: packaged Node runtimes expose the
  CommonJS singleton under `default.autoUpdater`, while bundlers may provide a named export. The
  resolved object must satisfy the narrow updater surface or fail closed.
- Download progress accepts only finite numeric percentages and clamps them to `0..100`.
- Production artifacts must be Developer ID signed, hardened-runtime enabled, notarized, and
  fully verified before a GH-token-scoped step uploads them to a human-reviewed GitHub draft. Build
  and verification steps never receive `GH_TOKEN`; release uploads never clobber existing assets.
  Stable releases are forward-only; never replace published tag assets.
- Every production release publishes one coherent updater set: `latest-mac.yml` plus macOS zip
  assets, `latest.yml` plus the signed Windows NSIS installer, and `latest-linux.yml` plus the Linux
  AppImage. Platform builders verify native-module architecture before the publisher can run.
