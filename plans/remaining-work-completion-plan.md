# Plan: Remaining-Work Completion — Finish Phase 6, Repair the Harness, Stage Phase 7

## Ticket / Feature
Review of all `docs/implementation-plan/*`, `plans/*`, and `reports/*` to produce one plan for what
is still missing across the build and a repair for the degraded local harness. Three parts:
**(1) finish Phase 6** (the ~20% of tracks that never landed), **(2) repair the broken git link** so
the enforcement hooks re-arm, **(3) stage Phase 7** (its own `/harness-plan` pass — not built here).

## Status ledger (verified against the tree on 2026-07-07, not just the docs)

| Phase | State | Evidence |
|---|---|---|
| 0 Foundation | ✅ complete | `reports/phase-0-…report.md` |
| 1 Workspace engine | ✅ complete | report + `src/main/{git,workspace}` |
| 2 Harness + chat | ✅ complete | report + `src/main/harness` |
| 3 Terminal & run | ✅ complete | report + `src/main/{pty,process}` |
| 4 Diff/review/checkpoints | ✅ complete (no report file) | `src/main/{diff,checkpoint}` present, migration `0005_diff_review` applies |
| 5 GitHub/checks/PR | ✅ complete | `reports/phase-5-…report.md`, gate green @ 352 tests |
| 6 Config/settings/polish | 🟡 ~80% | Tracks A,B1,C,D,E,F,G,H1 landed (399 tests); **B2/H2/H3/H4 + settings:getIssues + 3 menu actions missing** |
| 7 v1.1 (Codex/Cursor/Linear/scale) | ⛔ unbuilt | no plan, no `codex.ts`/`cursor.ts`/`integrations/linear` |

**Phase 6 remaining, confirmed on disk:**
- **B2** — `RunScriptEditor` for `[scripts].run` + env/mcp array editors. `src/renderer/features/settings/`
  has `SettingsPanel/SettingRow/useSettings/fields`, **no** `RunScriptEditor.tsx`.
- **H2** — ⌘K `CommandPalette`. `src/main/shortcuts.ts:50` emits `menu:action` `actionId:'commandPalette'`;
  `src/renderer/features/palette/` **does not exist**; `AppLayout` does not handle it.
- **H3** — Onboarding. `onboarding:state` DTO declared (`src/shared/ipc.ts:272`) but the handler is
  **not registered** in `register.ts`, and `src/main/onboarding.ts` + `features/onboarding/` are absent.
  Must include the **unsandboxed-exec security disclosure** (spec §7 — heightened scrutiny).
- **H4** — Auto-update. `update:check`/`update:install` DTOs declared (`ipc.ts:268,270`) but handlers
  **not registered**; `src/main/update/` absent. **Flagged descope risk** (signing/feed infra).
- **settings:getIssues** — backend already produces issues (`SettingsService.issuesSnapshot` +
  `loadResult()`, `src/main/settings/index.ts:75,94–95`); **no** `settings:getIssues` command and **no**
  UI surfaces them.
- **Unhandled renderer menu actions** — `AppLayout.tsx:74–78` handles `openSettings/showDiff/
  showTerminal/selectWorkspace:N`; the menu also emits `newWorkspace`, `openPr`, `commandPalette`
  (`shortcuts.ts:38,44,50`) with **no** renderer handler.

**Harness degradation, confirmed:** `.git` is a gitfile → `/Users/sebastian.romero/src/WT/Conductor/
.git/worktrees/Harness`, a parent repo not present on this machine (`macmini`). Every repo-root git
command returns `fatal: not a git repository`, so `.claude/hooks/{block-on-main,stop-validate}.sh`
fail **open** (memories `broken-git-link`, `harness-enforcement-degraded`). Tests already avoid this by
using tmpdir repos, so only the enforcement hooks — not the product — are affected.

## Affected Files

### Read before implementing
- `plans/phase-6-config-polish-plan.md` (Tracks B2, H2, H3, H4 sections, and Execution Strategy) — the
  authoritative per-task spec; this plan only fills the gaps it left open.
- `src/main/ipc/register.ts:1106–1130` (`slash:list`/`deepLink:resolve` handlers) — the exact shape to
  mirror for the three new handlers (validate/narrow input, delegate to a service on `AppContext`).
- `src/main/settings/index.ts:69–130` — `loadResult()`, `issuesSnapshot`, `SettingsIssue` — the seam
  `settings:getIssues` exposes (no new backend logic).
- `src/main/shortcuts.ts:34–55` — the `actionId` table the menu emits (`newWorkspace`/`openPr`/
  `commandPalette` need renderer handlers).
- `src/renderer/app/AppLayout.tsx:68–85` — the `menu:action` dispatcher to extend; `CenterTab` union;
  where `<CommandPalette>` and `<OnboardingWizard>` mount.
- `src/renderer/features/settings/{SettingsPanel,SettingRow,useSettings}.tsx` + `fields.ts` — the
  landed Settings UI to mirror for `RunScriptEditor` and the validation-issues banner.
- `src/renderer/features/checks/ChecksPanel.tsx` — panel layout + `subscribeStream`/`onEvent` cleanup
  idiom to mirror for new renderer features.
- `src/main/index.ts` — `createAppContext`, `whenReady`, `before-quit` teardown — the convergence point
  for an `UpdateService` handle + updater check-on-launch + teardown.
- `src/main/context.ts` — `AppContext` is append-only; add `updater`/`onboarding` at the end.
- `src/main/settings/schema.ts` — the `[scripts].run` zod shape `RunScriptEditor` writes; `agent.mode`
  enum onboarding may read.
- `docs/implementation-plan/phase-7-v1.1-harnesses-linear.md` (whole) — for Part 3 staging only.

### Modify
- `src/shared/ipc.ts` — **append** one Command: `settings:getIssues` (`req: void; res: SettingsIssue[]`).
  Re-export/confirm `SettingsIssue` is importable by the renderer (it lives in `@shared/settings`).
  **Append-only** — never reorder existing `Commands`.
- `src/main/ipc/register.ts` — register handlers: `settings:getIssues`, `onboarding:state`,
  `update:check`, `update:install` (the last two guarded — see H4).
- `src/main/index.ts` — construct `UpdateService` + `OnboardingService`, run an updater check-on-launch
  (guarded), tear down in `before-quit`.
- `src/main/context.ts` — append `updater` and `onboarding` service handles.
- `src/renderer/app/AppLayout.tsx` — handle `commandPalette`/`newWorkspace`/`openPr` menu actions;
  mount `<CommandPalette>` and `<OnboardingWizard>`; wire the settings validation-issues banner.
- `src/renderer/features/settings/SettingsPanel.tsx` — mount `RunScriptEditor` + issues banner.
- `package.json` — add `electron-updater` (H4 dep; justify — it is the README §6.5-mandated updater).

### Create
- `src/renderer/features/settings/RunScriptEditor.tsx` (+ extend `SettingsPanel.test.tsx`).
- `src/renderer/features/palette/{CommandPalette.tsx,useCommands.ts,CommandPalette.test.tsx}`.
- `src/main/onboarding.ts` (+ `.test.ts`); `src/renderer/features/onboarding/{OnboardingWizard.tsx,
  OnboardingWizard.test.tsx}`.
- `src/main/update/index.ts` (+ `.test.ts`).
- `src/renderer/stores/palette.ts` (if the palette needs cross-component open/close state; else local).

## Ordered Tasks

> Track A of Phase 6 (the settings spine) already landed, so every task here builds on stable IPC and
> the generic preload/renderer funnel — **new Commands need only a `@shared/ipc` entry + a `register.ts`
> handler**, no preload/renderer-client edits.

### Task 1 — `settings:getIssues` command + validation banner  *(lowest-risk; unblocks nothing else)*
- What: append `settings:getIssues` to `Commands`; register a handler returning
  `ctx.settings.getIssues()` (add a trivial getter over `issuesSnapshot` if one isn't public). In
  `SettingsPanel`, fetch it and render a dismissible banner listing `{file, keyPath, message}` per issue;
  re-fetch on the existing `settings:changed` subscription.
- Pattern: handler `register.ts:1108` (`slash:list`); banner mirrors a `SettingRow` block; subscribe
  idiom from `useSettings.ts`.
- Gotcha: append-only `Commands`; `SettingsIssue` must be imported from `@shared/settings`, not redefined.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/settings/SettingsPanel.test.tsx`

### Task 2 — B2: `RunScriptEditor`
- What: an editor for `[scripts].run` entries (name/command/label/icon/`run_mode`) that writes via the
  landed `settings:set`; add env/mcp array-editor rows in the same panel. Round-trips a settings change
  into a new Phase-3 run button.
- Pattern: `SettingRow.tsx` write-to-layer control + `settings:set`; array-atomic write rule from
  `src/main/settings/CLAUDE.md`.
- Gotcha: arrays are atomic in the layered merge — write the whole `run` array, not per-element; keep
  provenance-badge behavior consistent with scalar rows.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/settings/SettingsPanel.test.tsx`

### Task 3 — H2: ⌘K `CommandPalette` + unhandled menu actions
- What: `CommandPalette.tsx` with an action registry (`useCommands.ts`) and a hand-rolled fuzzy match
  (no new dep); it drives the same actions as buttons/menu (switch workspace, open settings, show
  diff/terminal, new workspace, open PR). In `AppLayout`, handle the `commandPalette` menu action to
  toggle it and route `newWorkspace`/`openPr` to their existing renderer handlers.
- Pattern: `AppLayout.tsx:74–78` dispatcher; overlay/mount like the settings overlay; fuzzy match akin
  to the composer slash menu (Track D).
- Gotcha: the palette and menu must share **one** action registry so a shortcut and a palette entry
  can't diverge; clean up the `keydown` listener on unmount.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/palette/CommandPalette.test.tsx`

### Task 4 — H3: Onboarding (heightened-scrutiny: security disclosure)
- What: `src/main/onboarding.ts` composes `OnboardingState` from `harness:detect` results + GitHub
  account presence + project count; register the `onboarding:state` handler (currently unregistered).
  `OnboardingWizard.tsx` walks harness-detect → GitHub-connect → add-project and **must render the
  unsandboxed-execution disclosure** (agent/run commands execute with user privileges in the worktree,
  spec §7 / README §7.6) with an explicit acknowledgement before first run.
- Pattern: handler `register.ts:1108`; detect via existing `harness:detect`; wizard layout mirrors
  `ChecksPanel`/settings overlay.
- Gotcha: this is a **named-security-review** path — the disclosure copy and the "no sandbox in v1"
  framing must be reviewed, not just the code. State must degrade gracefully when no harness is
  installed (empty detect) rather than block the app.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/onboarding/OnboardingWizard.test.tsx`

### Task 5 — H4: Auto-update (guarded; **descope-eligible**)
- What: `src/main/update/index.ts` — `UpdateService` over `electron-updater` (`checkForUpdates`,
  `quitAndInstall`, status → `UpdateStatus`); register `update:check`/`update:install`; check-on-launch
  in `whenReady`; teardown in `before-quit`; a manual "Check for updates" entry in the palette/menu.
- Gotcha (**flagged risk, decide before building**): signing + notarization + a release feed is
  infrastructure that is **not present in this checkout**. If absent, **descope to a stubbed feed +
  manual-check-only that degrades to a typed `AppError` on an unsigned/dev run** and leave a note — do
  not block the phase on release infra. New dep `electron-updater` is the README §6.5-mandated updater
  (justified).
- Validate: `node scripts/vitest-electron.mjs run src/main/update/index.test.ts`

### Task 6 — Harness repair: re-establish the git link  *(independent of Tasks 1–5)*
- What: fix the dangling worktree gitfile so repo-root git works and `block-on-main`/`stop-validate`
  re-arm. The parent repo (`sebastian.romero/…/Conductor`) is not on this machine, so the pragmatic
  fix is to **re-initialize a standalone repo in place**: back up the current `.git` gitfile, run
  `git init`, set the default branch to `main`, and make an initial commit of the existing tree (or add
  a remote if the canonical repo is reachable). Then confirm the hooks no longer fail-open.
- Gotcha (**heightened-scrutiny — destructive/irreversible on the repo pointer, confirm with the user
  first**): do **not** delete worktree metadata blindly; preserve the old `.git` gitfile contents in the
  plan/PR in case the parent repo is meant to be re-attached. This changes VCS identity — get explicit
  user sign-off before running `git init`. After the fix, update/close memories `broken-git-link` and
  `harness-enforcement-degraded`.
- Validate: `git -C /Users/macmini/src/Harness status` returns cleanly; `bash .claude/hooks/block-on-main.sh`
  behaves (no fail-open); `bash ci/harness-gates.sh` still green.

### Task 7 — Stage Phase 7 (plan only, not built here)
- What: run `/harness-plan` against `docs/implementation-plan/phase-7-v1.1-harnesses-linear.md` to
  produce `plans/phase-7-…-plan.md`. Phase 7 is ~2–3 weeks (Codex + Cursor adapters, raw-terminal
  fallback, capability-driven UI degradation, Linear OAuth/GraphQL, sparse-checkout + diff pagination)
  and is **out of scope for this implementation pass** — it earns its own plan/implement cycle.
- Validate: n/a (produces a plan artifact).

## Execution Strategy
*How `/harness-implement` should build this. Read verbatim.*
- **Task shape:** a small set of **loosely-independent** finish-up modules (each a landed-pattern
  clone) + one heightened-scrutiny item (H3 onboarding disclosure) + one irreversible infra fix
  (git-link repair) that must be user-confirmed. Not a mega-change.
- **Pattern:** **prompt-chaining per task** (`coder` → `test-author` → `code-review`), with
  **parallelization** across the independent renderer tasks; **evaluator-optimizer + mandatory
  `verifier`** on Task 4 (H3, security disclosure) and Task 6 (git repair).
- **Agents:** `coder` (per task) → `test-author` (independent tests) → `code-review`; add a **named
  security review + `verifier`** on Task 4; Task 6 is **lead-run with explicit user confirmation**, not
  delegated blind.
- **Orchestration:** prefer a **team** if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled (one
  teammate per task via the shared list; file ownership below); else **sequential/parallel subagents** —
  Tasks 1–5 fan out after the single shared-file edits are serialized.
- **Parallel decomposition + file-ownership:**
  - **Serialize** edits to the three shared hot files through one agent each: `src/shared/ipc.ts`
    (only Task 1 appends), `src/main/ipc/register.ts` (Tasks 1/4/5 append handlers — one at a time),
    `src/renderer/app/AppLayout.tsx` and `src/main/index.ts` (mount/wiring points).
  - **Disjoint trees, parallel-safe:** Task 2 owns `features/settings/RunScriptEditor.tsx`; Task 3 owns
    `features/palette/*`; Task 4 owns `src/main/onboarding.ts` + `features/onboarding/*`; Task 5 owns
    `src/main/update/*` + `package.json`.
  - **Task 6 (git repair) runs alone**, before or after the code tasks, and must not overlap a wave that
    depends on git state.
- **Rationale:** most gaps are clones of already-landed Phase-6 patterns (low risk, parallelizable);
  the two genuine risks — the onboarding security disclosure and the irreversible VCS-pointer change —
  are isolated behind a mandatory verifier and a user-confirmation gate.

## Validation Gate
Run after each task (from repo root):
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: +vitest +build)
```
Note (memory `broken-git-link`): until **Task 6** lands, repo-root git and the git-dependent hooks are
degraded — rely on the gate + tmpdir-repo tests, not `git diff`. After Task 6, re-verify the hooks.

## Acceptance Criteria
- [ ] `settings:getIssues` returns layer validation issues; the Settings UI surfaces them without a crash.
- [ ] `RunScriptEditor` adds/edits/removes `[scripts].run` entries via `settings:set`; a new run button
      appears after a hot-reload.
- [ ] ⌘K command palette opens (from the `commandPalette` menu action) and drives navigation + actions;
      `newWorkspace`/`openPr` menu actions are handled in the renderer.
- [ ] Onboarding composes state from harness-detect + GitHub + project count and shows the
      **unsandboxed-execution disclosure** with an acknowledgement; `onboarding:state` handler registered.
- [ ] `electron-updater` check/install works, **or** a documented descope (stub feed + guarded
      manual-check) with a typed `AppError` on unsigned/dev runs — no crash either way.
- [ ] Git link repaired (user-confirmed): repo-root git works, `block-on-main`/`stop-validate` no longer
      fail-open, memories `broken-git-link`/`harness-enforcement-degraded` updated/closed.
- [ ] `plans/phase-7-…-plan.md` produced (Task 7) — Phase 7 staged, not built.
- [ ] `src/shared/**` changes append-only; renderer hardening intact; all blocking gates pass (run /verify).
```
