# Plan: Signed Remote Application Updates

## Ticket / Feature
Add a secure macOS application-update flow backed by public GitHub Releases, including automatic
launch checks, a user-controlled update modal, a manual “Check for Updates” command, and a signed,
notarized release workflow.

## Product and Release Decisions

- **Provider:** GitHub Releases for the public
  [`serolo/Harness`](https://github.com/serolo/Harness) repository. The repository was verified
  public during planning, so installed clients do not need a GitHub token. `GITHUB_TOKEN` is used
  only inside GitHub Actions to publish assets.
- **Channel:** stable releases only. The workflow creates a **draft** release; a human publishes it
  after artifact verification. Pre-releases and drafts are not offered to stable clients.
- **Platform/architecture:** macOS arm64 for the first official update channel, matching the current
  locally produced artifacts and the app's macOS-only v1 scope. Intel, Windows, multiple channels,
  staged rollouts, and delta-policy tuning are follow-up work.
- **Bootstrap:** the current `0.0.0` builds have no embedded update feed and are unsigned, so they
  cannot discover this channel retroactively. Publish a signed/notarized `v0.1.0` bootstrap and
  distribute it once through the existing manual download path. Prove remote updating with a
  subsequent `v0.1.1` release.
- **User experience:** launch checks are silent unless an update finishes downloading. A downloaded
  update opens a modal with **Restart and update** and **Later**. “Later” closes the modal and does
  not install automatically on quit; the user can reopen it through “Check for Updates” in the
  command palette. Manual checks show checking, downloading, up-to-date, unsupported, and error
  states in the same modal.
- **Rollback:** never replace assets on an existing tag or publish a lower version as a rollback.
  Revert the bad code and publish a higher patch version because updater selection is semver-forward.
- **Security:** production updates must be code-signed and notarized. Signing/notarization secrets
  exist only in GitHub Actions secrets and must never enter the renderer, packaged resources,
  release metadata, or logs.

These decisions follow the official
[electron-builder auto-update](https://www.electron.build/docs/features/auto-update/),
[GitHub Actions publishing](https://www.electron.build/docs/features/github-actions/),
[macOS configuration](https://www.electron.build/mac/), and
[Electron code-signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) guidance.
The macOS `zip` target remains required because it produces the metadata used by Squirrel.Mac.

## Affected Files

### Read before implementing

- `.claude/rules/security.md` — packaging/updates and IPC/preload are heightened-scrutiny paths;
  secrets, renderer isolation, and mandatory review requirements.
- `.claude/rules/architecture.md` — typed main↔renderer boundary and one-way dependency rules.
- `.claude/rules/conventions.md` — test, naming, logging, and module conventions.
- `src/main/ipc/CLAUDE.md:1-27` — typed command/event boundary and append-only shared-contract rules.
- `src/main/update/index.ts:20-175` — existing injectable `UpdateService`, unsupported path, lifecycle
  listeners, and install gate to extend rather than replace.
- `src/main/update/index.test.ts:10-120` — fake updater and supported/unsupported lifecycle tests.
- `src/shared/ipc.ts:383-408` — existing `update:check` / `update:install` commands.
- `src/shared/ipc.ts:570-624` — append point for a new updater broadcast event.
- `src/shared/ipc.ts:832-850` — current `UpdateStatus` state union.
- `src/main/index.ts:266-320` — `createAppContext` and the existing typed `emit` closure.
- `src/main/index.ts:612-624` — deliberately descoped updater construction to replace with a real,
  packaged-build adapter.
- `src/main/index.ts:881-905` — app-context creation, IPC registration, window creation, and launch
  update check ordering.
- `src/main/index.ts:923-950` — shutdown and updater-listener teardown.
- `src/main/context.ts:73-84` — existing updater field in `AppContext`.
- `src/main/ipc/register.ts:2408-2429` — adjacent deep-link/onboarding handlers and current updater
  handlers behind the IPC error boundary.
- `src/preload/index.ts:74-106` — generic typed `invoke` / `on` bridge; confirm the appended command
  and event flow through it without exposing a new renderer primitive.
- `src/renderer/ipc/index.ts:45-69` — generic typed renderer command/event funnel.
- `src/renderer/components/ui/Dialog.tsx:1-56` — modal chrome to reuse.
- `src/renderer/app/AppLayout.tsx:250-410` — global overlay state, shared command actions, and
  once-mounted event subscriptions.
- `src/renderer/app/AppLayout.tsx:676-699` — global overlay render point.
- `src/renderer/app/AppLayout.nav.test.tsx:25-80` — API/event-listener test harness for global events.
- `src/renderer/features/palette/useCommands.ts:35-101` — fixed command registry and injected actions.
- `src/renderer/features/palette/CommandPalette.test.tsx:39-50,90-141` — action mock and command
  execution tests.
- `package.json:1-29` — current `0.0.0` version, packaging scripts, and installed
  `electron-updater`.
- `electron-builder.yml:1-42` — unsigned local/CI packaging base, macOS `dmg` + `zip` targets, and
  native-module policy.
- `.github/workflows/app-bundle.yml:1-53` — existing unsigned main-branch artifact build; preserve it
  as a non-release workflow.

### Modify

- `src/shared/ipc.ts` — append `update:getStatus`, append `update:status`, and add optional
  `currentVersion` / `percent` fields to `UpdateStatus` without changing existing members.
- `src/main/update/index.ts` — centralize status transitions, emit every transition, track progress,
  disable install-on-quit, and keep the unsupported path safe.
- `src/main/update/index.test.ts` — cover event emission, progress normalization, launch checks,
  manual deferral semantics, disposal, and sanitized failures.
- `src/main/index.ts` — detect embedded release metadata, lazily supply the real updater only in a
  supported packaged build, pass the app version + broadcast callback, and keep startup non-blocking.
- `src/main/ipc/register.ts` — add the read-only status-snapshot handler and retain typed install/check
  behavior.
- `src/renderer/app/AppLayout.tsx` — mount the updater controller/modal globally and expose the manual
  check action to the shared command registry.
- `src/renderer/app/AppLayout.nav.test.tsx` — return an updater snapshot from the API stub and verify
  a downloaded broadcast opens only one modal.
- `src/renderer/features/palette/useCommands.ts` — add the fixed “Check for Updates” command.
- `src/renderer/features/palette/CommandPalette.test.tsx` — add the action mock and command test.
- `package.json` — add a deterministic signed macOS release script; do not silently invent release
  versions in the workflow.
- `src/main/ipc/CLAUDE.md` — document updater command/event ownership and the no-client-token rule.

### Create

- `src/renderer/features/update/useAppUpdate.ts` — hydrate status before subscribing, coordinate
  manual/automatic modal visibility, and call typed update commands.
- `src/renderer/features/update/UpdateModal.tsx` — accessible status/progress/restart/later UI using
  the shared `Dialog`.
- `src/renderer/features/update/UpdateModal.test.tsx` — renderer state-machine and interaction tests.
- `electron-builder.release.yml` — release-only signed/notarized/published builder configuration that
  extends the existing unsigned local packaging config.
- `build/entitlements.mac.plist` — minimal Electron 43 hardened-runtime entitlements.
- `.github/workflows/release.yml` — tag-gated signed/notarized macOS arm64 draft-release workflow.
- `docs/RELEASING.md` — bootstrap, secrets, version/tag steps, promotion, smoke test, and rollback
  runbook.
- `src/main/update/AGENTS.md` — updater invariants, trust boundary, state machine, and release-feed
  constraints.

## Ordered Tasks

### Task 1 — Extend the append-only updater contract

- **What:** Append `update:getStatus: { req: void; res: UpdateStatus }` at the end of `Commands` and
  `update:status: UpdateStatus` at the end of `Events`. Add optional `currentVersion?: string` and
  `percent?: number` fields to `UpdateStatus`; keep every existing command, event, state, and field in
  place. `update:getStatus` is hydration only and must never start network work.
- **Pattern:** `src/shared/ipc.ts:395-398` for current updater commands and `:616-623` for the current
  event append point.
- **Gotcha:** `src/shared/**` is frozen and append-only. The payload must remain structured-clone-safe
  and import-safe from main and renderer. No feed URL, GitHub token, signing detail, filesystem path,
  or raw updater object may cross the boundary.
- **Validate:** `bash ci/harness-gates.sh typecheck`

### Task 2 — Turn `UpdateService` into the single observable state machine

- **What:** Add `currentVersion` and `onStatusChange` dependencies. Route constructor state,
  `checkForUpdates`, and every updater listener through one private `setStatus` method that stores a
  snapshot and synchronously publishes a cloned snapshot. Expand `AutoUpdaterLike` with
  `autoInstallOnAppQuit`; set `autoDownload = true`, `autoInstallOnAppQuit = false`, and
  `allowPrerelease = false` for a stable, consent-driven channel. Read `download-progress.percent`,
  reject non-finite input, and clamp valid progress to `0..100`. Preserve the known target version
  while downloading. Keep unsupported builds network-free and installation gated on `downloaded`.
  Log technical errors in main, but publish a concise user-facing error that cannot leak credentials
  or signed URLs.
- **Pattern:** `src/main/update/index.ts:59-165` — evolve the existing injected adapter and listener
  lifecycle; do not import Electron or `electron-updater` into this service.
- **Gotcha:** packaging/updates are heightened scrutiny. A check may emit events before its promise
  settles, and a renderer may mount after launch events; `getStatus()` remains authoritative.
  Automatic checks must never throw through startup. “Later” is meaningful only if
  `autoInstallOnAppQuit` is false.
- **Validate:** `node scripts/vitest-electron.mjs run src/main/update/index.test.ts`

### Task 3 — Activate the real updater only for release packages

- **What:** In main, detect the embedded `app-update.yml` beneath `process.resourcesPath` instead of
  using `AGENTAPP_UPDATE_FEED`. When `app.isPackaged` and that metadata exists, lazily import
  `electron-updater`, inject `autoUpdater`, pass `app.getVersion()`, and broadcast each service
  transition with the existing typed `emit('update:status', status)`. Otherwise construct the
  unsupported service without loading the updater module. Preserve the current order: register IPC,
  create the window, then fire-and-forget `checkOnLaunch`; retain `dispose()` during quit.
- **Pattern:** `src/main/index.ts:304-314` for broadcast; `:612-624` for construction; `:881-905` for
  startup; `:946-950` for teardown.
- **Gotcha:** this changes the `createAppContext` construction seam and a heightened-scrutiny path.
  Re-read the file before editing because it currently contains unrelated user changes. Do not make
  the renderer aware of `process.resourcesPath`, load `electron-updater` during dev/test, or treat a
  generic packaged local build as update-capable. Missing/corrupt metadata must degrade to
  `unsupported`, not crash app startup.
- **Validate:** `node scripts/vitest-electron.mjs run src/main/update/index.test.ts` and
  `bash ci/harness-gates.sh typecheck`

### Task 4 — Add status hydration through the typed IPC boundary

- **What:** Register `update:getStatus` as a no-input handler returning
  `ctx.updater.getStatus()`. Retain `update:check` as the only network-triggering command and
  `update:install` as the only restart/install command. Add focused IPC coverage proving status reads
  do not trigger checks, install failures cross as typed `AppError`s, and malformed/unexpected calls
  cannot bypass the existing boundary.
- **Pattern:** `src/main/ipc/register.ts:2417-2429`; use the same `handle(...)` wrapper, never raw
  `ipcMain.handle`.
- **Gotcha:** IPC/preload is heightened scrutiny. `req` is `void`; do not accept a renderer-supplied
  feed URL, version, path, channel, or installation flags. The generic preload and renderer funnels
  already carry newly appended typed commands/events, so verify them but do not add a parallel bridge.
- **Validate:** `node scripts/vitest-electron.mjs run src/main/ipc/register.test.ts` (or the nearest
  focused updater registration test created alongside the implementation) and
  `bash ci/harness-gates.sh typecheck`

### Task 5 — Build the global update controller and modal

- **What:** `useAppUpdate` must subscribe to `update:status`, then immediately hydrate with
  `update:getStatus` so it cannot miss a launch event. It owns `{status, open, manualCheck}`:
  automatic `checking`, `not-available`, and `error` remain silent; `downloaded` auto-opens once per
  app run; a manual check opens immediately and renders every state. `UpdateModal` reuses `Dialog`,
  displays current/target versions when known, shows bounded download progress, provides
  **Restart and update** only when downloaded, provides **Later/Close**, disables duplicate actions,
  and keeps errors recoverable via **Try again**. Wire it once in `AppLayout`, and add a
  `checkForUpdates` action plus fixed “Check for Updates” command in the shared palette registry.
- **Pattern:** `src/renderer/app/AppLayout.tsx:250-410,676-699` for global state/event/overlay
  ownership; `src/renderer/components/ui/Dialog.tsx:19-55` for modal chrome;
  `src/renderer/features/palette/useCommands.ts:35-101` for action injection.
- **Gotcha:** renderer hardening remains intact: use only `invoke` / `onEvent`; no Node, Electron,
  filesystem, shell, or direct network access. Subscribe before hydrating to close the event/snapshot
  race, and clean up the listener on unmount. Guard against StrictMode/remount duplication so one
  downloaded status produces one modal, not stacked dialogs or repeated install calls. Closing a
  manually displayed `not-available`, `unsupported`, or error status must not affect future checks.
- **Validate:** `node scripts/vitest-electron.mjs run src/renderer/features/update/UpdateModal.test.tsx`
  and
  `node scripts/vitest-electron.mjs run src/renderer/features/palette/CommandPalette.test.tsx src/renderer/app/AppLayout.nav.test.tsx`

### Task 6 — Add release-only signing, notarization, and GitHub publish configuration

- **What:** Keep `electron-builder.yml` as the unsigned local/main-branch artifact config. Create
  `electron-builder.release.yml` extending it with:
  `forceCodeSigning: true`; GitHub `publish` provider for `serolo/Harness`; stable/draft release
  behavior; macOS hardened runtime; notarization; and minimal entitlements. Preserve both `dmg` and
  `zip`, because the updater requires the zip metadata. Add a `release:mac` script that explicitly
  selects the release config and arm64. Confirm a release build embeds `app-update.yml` and emits at
  least the `.dmg`, `.zip`, `.blockmap`, and `latest-mac.yml` assets.
- **Pattern:** `electron-builder.yml:9-42` for product identity, targets, protocol, and native-module
  policy; the release config adds security/distribution settings without breaking local unsigned
  packaging.
- **Gotcha:** packaging/updates are heightened scrutiny. Use the minimum Electron 43 entitlements;
  do not add `com.apple.security.cs.allow-unsigned-executable-memory` unless an evidenced runtime
  failure and security review require it. Validate both `better-sqlite3` and `node-pty` in the signed
  artifact. A local `npm run package` must remain usable without production secrets, while
  `npm run release:mac` must fail closed when signing is unavailable.
- **Validate:** `npm run package` for the unsigned developer path, then in a secret-equipped
  environment `npm run release:mac` followed by
  `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Harness.app`,
  `spctl --assess --type execute --verbose=4 dist/mac-arm64/Harness.app`, and
  `xcrun stapler validate dist/*.dmg`

### Task 7 — Create the tag-gated GitHub release workflow and runbook

- **What:** Add `.github/workflows/release.yml` triggered by `v*` tags (plus a manual dispatch that
  still requires an existing matching tag). Give only the release job `contents: write`. Check out,
  install Node 22 dependencies, rebuild native modules for Electron, run the full repository gate,
  fail if `package.json` is `0.0.0`, and require the tag to equal `v${package.version}`. Materialize
  the signing/notarization credentials from GitHub Actions secrets without printing them, run the
  release script with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, verify signature/notarization and the
  expected update metadata, then create/update a **draft** GitHub Release. Concurrency must prevent
  two publishers for the same tag. Document required secret names, certificate/API-key rotation,
  `v0.1.0` bootstrap distribution, draft inspection/promotion, `v0.1.1` update smoke test, and
  forward-only rollback in `docs/RELEASING.md`.
- **Pattern:** `.github/workflows/app-bundle.yml:15-53` for macOS setup/rebuild/gate sequencing; keep
  that workflow read-only and separate from production release authority.
- **Gotcha:** never expose `GH_TOKEN`, the Developer ID certificate/password, or Apple notarization
  key material to renderer code, artifacts, shell tracing, logs, pull requests, or forks. A tag alone
  is not enough: the workflow must fail closed unless version, signing, notarization, and metadata
  checks pass. Publishing the GitHub draft is the deliberate human promotion gate.
- **Validate:** validate workflow YAML locally, push a non-production test branch without a tag to
  prove no release runs, then create the documented `v0.1.0` tag and confirm the draft contains
  signed/notarized arm64 artifacts plus `latest-mac.yml` and blockmaps.

### Task 8 — Prove the two-version update path and document invariants

- **What:** Add updater-specific invariants to `src/main/update/AGENTS.md` and the IPC event ownership
  to `src/main/ipc/CLAUDE.md`. Install the manually distributed signed `v0.1.0` bootstrap on a clean
  Apple-silicon Mac, publish `v0.1.1`, and verify: launch check stays silent while downloading; exactly
  one modal appears when ready; **Later** leaves `v0.1.0` running and does not install on quit;
  manual “Check for Updates” reopens the ready state; **Restart and update** exits, installs, relaunches
  `v0.1.1`, and preserves user data/workspaces. Also exercise offline, no-update, corrupt metadata,
  unsigned local build, and GitHub outage paths.
- **Pattern:** `src/main/update/index.test.ts:35-120` for unit lifecycle coverage and
  `src/renderer/app/AppLayout.nav.test.tsx:31-79` for a single global subscription.
- **Gotcha:** never test update installation against a development checkout or user-data directory
  containing the only copy of important data. Use a clean test profile. Do not mutate/replace the
  `v0.1.0` release assets after publication; publish a higher version for every correction.
- **Validate:** record the two-version smoke evidence, then run the full Validation Gate and the
  mandatory packaging/update security review.

## Execution Strategy

*How `/harness-implement` should build this. `/harness-implement` reads this verbatim.*

- **Task shape:** Cross-cutting, sequential desktop feature spanning the frozen shared contract,
  main-process updater, heightened-scrutiny IPC boundary, global renderer UI, and
  heightened-scrutiny signed release infrastructure.
- **Pattern:** prompt-chaining + evaluator-optimizer.
- **Agents:** `coder` (Tasks 1–7 in dependency order) → `test-author` (independent updater/renderer
  regression coverage) → `code-review` + `verifier` (mandatory for IPC/preload and
  packaging/update security).
- **Orchestration:** sequential. Do not parallelize production changes that share
  `src/shared/ipc.ts`, `src/main/index.ts`, or `src/renderer/app/AppLayout.tsx`; those files already
  contain unrelated working-tree edits that must be preserved.
- **Parallel decomposition + file-ownership:** after Task 1 lands, the test-author may own only new
  `*.test.ts(x)` files while the coder owns implementation/configuration files. Release config/workflow
  work (Tasks 6–7) may run alongside renderer tests only if ownership is disjoint. Task 8 and the
  independent verifier remain last.
- **Rationale:** the state/event ordering and release trust chain are coupled and security-sensitive;
  a disciplined dependency chain plus independent tests/review is safer than broad fan-out.

## Validation Gate

Run after all tasks from the repository root:

```sh
node scripts/vitest-electron.mjs run src/main/update/index.test.ts
node scripts/vitest-electron.mjs run src/renderer/features/update/UpdateModal.test.tsx
node scripts/vitest-electron.mjs run src/renderer/features/palette/CommandPalette.test.tsx src/renderer/app/AppLayout.nav.test.tsx
bash ci/harness-gates.sh format lint typecheck
bash ci/harness-gates.sh
```

Release-candidate-only checks, on the signed CI artifact:

```sh
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Harness.app
spctl --assess --type execute --verbose=4 dist/mac-arm64/Harness.app
xcrun stapler validate dist/*.dmg
```

Then run the documented clean-profile `v0.1.0` → `v0.1.1` end-to-end update smoke test. Use
`/verify` for completion evidence and require named human review of packaging/updates and IPC/preload.

## Acceptance Criteria

- [ ] A signed/notarized macOS arm64 `v0.1.0` bootstrap can be manually installed and contains an
  embedded GitHub update feed for public `serolo/Harness` releases.
- [ ] A tag whose value does not exactly match a non-`0.0.0` `package.json` version cannot publish.
- [ ] The release workflow fails closed without signing/notarization credentials and produces a draft
  containing `.dmg`, `.zip`, `.blockmap`, and `latest-mac.yml` assets when credentials are valid.
- [ ] No GitHub, signing, or notarization secret is shipped to or requested by the installed app.
- [ ] Supported packaged builds check automatically after launch without blocking startup; dev,
  unsigned local, or no-feed builds remain network-free and report `unsupported` on a manual check.
- [ ] The renderer hydrates the latest updater snapshot and receives later transitions over one typed,
  append-only event without missing or duplicating the downloaded notification.
- [ ] Automatic checks do not interrupt the user while checking/downloading/no-update/offline; one
  update modal opens when a download is ready.
- [ ] Manual “Check for Updates” is available in the command palette and shows checking, progress,
  up-to-date, downloaded, unsupported, retryable error, and install-in-progress behavior.
- [ ] **Later** does not restart or install on quit; **Restart and update** is idempotent and available
  only after a verified download.
- [ ] A clean-profile `v0.1.0` → published `v0.1.1` smoke test installs, relaunches the new version,
  and preserves existing app data/workspaces.
- [ ] Rollback is documented and tested as a higher patch release; published tags/assets are immutable.
- [ ] macOS signing, Gatekeeper assessment, notarization/stapling, native-module startup, all updater
  tests, and the full repository gate pass.
- [ ] `src/shared/**` changes are append-only, renderer hardening remains intact, no DB migration is
  introduced, and mandatory packaging/update + IPC/preload review is recorded.
