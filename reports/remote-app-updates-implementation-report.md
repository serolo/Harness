# Implementation Report: Signed Remote Application Updates

## Plan

`plans/remote-app-updates-plan.md`

## Orchestration

**Mechanism:** sequential subagents. The experimental team flag was enabled, but no team-creation
tool was available, so `/harness-implement` used the documented subagent fallback.

| Agent / role | Task(s) | Outcome |
|---|---|---|
| coder | Production/config/docs Tasks 1–7 | DONE |
| test-author | Independent updater, IPC, controller/modal, palette, and AppLayout coverage | DONE — 75 focused tests |
| code-review | Heightened-scrutiny IPC and packaging/update review | PASS after three remediation rounds |
| verifier | Acceptance criteria and Definition-of-Done audit | PARTIAL — local implementation PASS; external release evidence pending |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Extend append-only updater contract | DONE | Added read-only status hydration, status broadcasts, current version, and progress. |
| 2 | Observable `UpdateService` state machine | DONE | Stable-channel flags, bounded progress, cloned snapshots, consent-driven install, safe/idempotent failure handling. |
| 3 | Activate updater only for trusted release packages | DONE | Packaged-only lazy import behind a closed-schema `app-update.yml` trust gate. |
| 4 | Typed updater IPC hydration/install boundary | DONE | Read-only hydration plus defense-in-depth redaction for unexpected install errors. |
| 5 | Global update controller/modal and manual command | DONE | Subscribe-before-hydrate race protection, silent automatic checks, one ready modal, retry/restart/later UI. |
| 6 | Release-only signing/notarization configuration | DONE | Local unsigned packaging remains separate; release config fails closed without signing. |
| 7 | Tag-gated draft release workflow and runbook | DONE | Build/sign/notarize → verify/hash → token-scoped no-clobber draft upload. |
| 8 | Two-version proof and final review | PARTIAL | Automated security review PASS and local behavior proven; signed artifact, `v0.1.0 → v0.1.1`, rollback, and human review remain external. |

## Files Changed

### Created

- `src/main/ipc/register.update.test.ts` — updater IPC hydration and redaction coverage.
- `src/main/update/AGENTS.md` — updater trust/state/release invariants.
- `src/renderer/features/update/useAppUpdate.ts` — global updater controller.
- `src/renderer/features/update/UpdateModal.tsx` — consent-driven updater dialog.
- `src/renderer/features/update/UpdateModal.test.tsx` — controller/modal state, race, and interaction coverage.
- `electron-builder.release.yml` — signed/notarized public GitHub release configuration.
- `build/entitlements.mac.plist` — minimal hardened-runtime JIT entitlement.
- `.github/workflows/release.yml` — tag-gated verified draft publishing workflow.
- `docs/RELEASING.md` — secrets, bootstrap, promotion, update smoke, and rollback runbook.
- `plans/remote-app-updates-plan.md` — durable implementation plan.
- `reports/remote-app-updates-implementation-report.md` — this report.

### Modified

- `src/shared/ipc.ts:553-556,626-627,854-857` — append-only updater command/event/status additions.
- `src/main/update/index.ts:26-358` — metadata trust gate, lazy loader, observable service, sanitization, and install consent.
- `src/main/update/index.test.ts:1-471` — 45 service/metadata security tests.
- `src/main/index.ts` — packaged metadata reader, lazy updater import, version and typed event wiring.
- `src/main/ipc/register.ts:2422-2443` — status hydration and hardened install handlers.
- `src/main/ipc/CLAUDE.md` — updater IPC ownership and CI-only-secret invariant.
- `src/renderer/app/AppLayout.tsx:251-253,320-341,704-711` — one global controller/modal and palette action.
- `src/renderer/app/AppLayout.nav.test.tsx` — global subscription and single-modal regression.
- `src/renderer/features/palette/useCommands.ts:48-60,109-115` — manual “Check for Updates” command.
- `src/renderer/features/palette/CommandPalette.test.tsx` — updater command coverage.
- `package.json` — release-candidate build script with publishing disabled.

The checkout already contained substantial unrelated user changes before implementation. Those
changes were preserved and are not claimed as part of this report.

## Validation Gate Results

| Gate | Result |
|---|---|
| Updater-focused tests | PASS — 5 files, 75 tests |
| lint | PASS |
| typecheck | PASS |
| build | PASS |
| dispatch isolation | PASS |
| updater-targeted format | PASS |
| `git diff --check` | PASS |
| unsigned developer package | PASS |
| release config without signing identity | PASS — failed closed before producing a production release |
| full repository format | FAIL — 33 pre-existing unrelated files |
| full repository tests outside sandbox | FAIL — 890 passed, 5 unrelated dirty-tree failures, 1 unrelated sidebar error |
| signed/notarized release checks | NOT RUN — no Apple signing/notarization credentials or release candidate |

The tests that directly exercise the new behavior are:

- `src/main/update/index.test.ts`
- `src/main/ipc/register.update.test.ts`
- `src/renderer/features/update/UpdateModal.test.tsx`
- `src/renderer/features/palette/CommandPalette.test.tsx`
- `src/renderer/app/AppLayout.nav.test.tsx`

Notable security regressions permanently covered:

- secret-bearing updater failures cannot reach IPC errors or logs;
- delayed hydration cannot overwrite a newer updater event;
- duplicate install requests are idempotent;
- metadata overrides (`host`, `protocol`, `token`, `private`, `channel`, request headers, unknown
  keys) fail closed without importing `electron-updater`;
- unsafe cache paths and traversal fail closed;
- publishing cannot occur until signed artifacts have been independently verified and hashed.

## Acceptance Criteria

- [ ] A signed/notarized macOS arm64 `v0.1.0` bootstrap exists with the embedded public feed.
- [x] A nonmatching or `0.0.0` tag/version cannot publish.
- [ ] The workflow has produced and verified a real signed draft with all expected assets.
- [ ] A production bundle has been inspected to prove no credentials were shipped.
- [x] Supported release packages load only the trusted feed; dev/unsigned/missing/corrupt/overridden metadata stays network-free.
- [x] Typed snapshot hydration and event broadcasts handle the launch race without duplicate modals.
- [x] Automatic checking/no-update/error states stay non-disruptive; a downloaded update opens once.
- [x] Manual “Check for Updates” covers checking, progress, current, unsupported, retry, and install states.
- [x] **Later** does not install on quit; **Restart and update** is gated and idempotent.
- [ ] A clean-profile published `v0.1.0 → v0.1.1` update preserves data and relaunches successfully.
- [ ] Forward-only higher-patch rollback has been exercised.
- [ ] `codesign`, Gatekeeper, stapling, and packaged native-module runtime checks have passed on a real release candidate.
- [ ] The full repository gate is green.
- [ ] Required human IPC/preload and packaging/update security review is recorded.
- [x] Shared-contract changes are append-only, renderer hardening is intact, and no updater DB migration was introduced.

## Issues / Deviations

- The plan deliberately leaves `package.json` at `0.0.0`; the release workflow rejects it. A release
  owner must choose and commit `0.1.0` with the matching lockfile before the bootstrap tag.
- The full repository gate is not green because the incoming dirty working tree has 33 unrelated
  formatting failures and unrelated workspace/composer/sidebar test failures. Updater-owned files and
  all 75 focused updater tests are green.
- Signed/notarized artifact validation cannot run without Apple credentials and a real release
  candidate. No tag, release, credential, or external publication was created during implementation.
- The planned real `v0.1.0 → v0.1.1` update and rollback smoke tests require release publication and a
  clean Apple-silicon test profile.
- Renderer test suites continue to emit existing React `act(...)` warnings, but the updater
  assertions pass.

## Heightened-scrutiny Paths Touched

- **IPC/preload boundary:** append-only typed command/event additions and hardened install error
  boundary. The generic preload/renderer funnels were reused; no raw Electron capability was added.
- **Packaging and updates:** release config, entitlements, updater activation, signing/notarization,
  and GitHub Actions publishing.
- **Secrets/tokens:** GitHub and Apple credentials remain CI-only, step-scoped, materialized under
  `RUNNER_TEMP`, removed before publishing, and never cross IPC or enter packaged metadata/logs.

Automated code review is **PASS with no remaining findings**. A named human review is still mandatory
for these heightened-scrutiny paths.

## Ready for Review

The local implementation is ready for human security review and a signed `v0.1.0` release candidate.
The overall feature is **not release-complete** until the unchecked external acceptance criteria and
the full repository gate are satisfied.

**Handoff:** run `/verify`, then `/harness-review` after the external release-candidate evidence is
available and the unrelated repository gate failures are resolved.
