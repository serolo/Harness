# Plan: Phase 6 — Config, Settings UI & Polish

## Ticket / Feature
Turn the read-only settings skeleton into the full layered-TOML system (write path, zod validation
surfacing, hot-reload, provenance) with a write-to-layer Settings UI, plus app polish: slash
commands, shortcuts + ⌘K command palette, live deep links, notification-preference UI, auto-update,
and onboarding. Source: `docs/implementation-plan/phase-6-config-polish.md`.

## Scope reality check (read first)
This "phase" is **8 loosely-coupled tracks / ~1–2 weeks**, not one feature. `/harness-implement` should
build it as **tracks in dependency order**, not one mega-change. The plan is organized so the
**Settings core (Track A) is the blocking spine**; Tracks B–H depend on it or on each other only
where noted. Do **not** attempt all tracks in a single agent pass.

**Big scope reducers discovered in the code (do not re-build these):**
- **MCP passthrough (§3.3) is ~done.** `settings.mcp` already flows into `StartTurnOpts.mcpConfig`
  (`src/main/ipc/register.ts:264–273`) and `ClaudeCodeHarness` already writes `.mcp.json`
  (`src/main/harness/claude-code.ts:226–273`). Track F = verify + one test, nothing more.
- **Notification prefs backend (§3.7) is done.** The `[notifications]` zod section and
  `NotificationService` toggle-honoring already exist (`src/main/settings/schema.ts:156–174`,
  `src/main/harness/notifications.ts`). Track G = UI toggles that write via Track A, no backend.
- **Deep-link backend (§3.6) is 80% wired.** Single-instance lock, `setAsDefaultProtocolClient`,
  `open-url`, `second-instance` all exist in `src/main/index.ts:468–515`; `handleDeepLink` is
  log-only. Track E = parse + navigate + focus, reusing that scaffolding.
- **`settings:changed` event already exists** in the frozen `Events` map
  (`src/shared/ipc.ts:268–269`) as `Record<string, never>` — emit it; do not re-declare it.
- **preload + renderer funnel are generic** over `Commands`/`Events` (`src/preload/index.ts:207`,
  `src/renderer/ipc/index.ts`). A new Command needs **only** a `@shared/ipc` entry + a `register.ts`
  handler — **no** preload edit, **no** renderer-client edit. This removes an entire mirrored layer
  the phase doc's "IPC surface" bullet implies.

## Affected Files

### Read before implementing
- `src/main/settings/index.ts` (whole) — the read-only service + `deepMerge`/`readTomlLayer`; extend
  here. Note the explicit `// Phase 6:` markers at L117, L129–131.
- `src/main/settings/schema.ts` (whole) — `EffectiveSettingsSchema`; reuse verbatim for validation.
  The write path serialises **per layer**, not the merged blob.
- `src/main/settings/index.test.ts` (whole) — the temp-file/tmpdir test harness + `LoadOptions`
  seam to mirror for write/hot-reload/provenance tests. **Repo-root git is broken here; tests must
  use tmpdir repos** (see memory `broken-git-link`).
- `src/shared/ipc.ts:104–237` (`Commands`), `:251–272` (`Events`) — append-only maps. Mirror the
  Phase-5 block's comment/format.
- `src/main/ipc/register.ts:99–115` (`handle` boundary), `:549–1068` (handler bodies to mirror —
  esp. input validation shape), `:475–477` deep-link handler is in `index.ts`, not here.
- `src/main/index.ts` (whole) — the convergence point: `createAppContext():196–396`, deep-link
  scaffolding `:468–515`, `whenReady`/window `:517–536`, `before-quit` teardown `:550–579`. All new
  main-process wiring (chokidar watcher, globalShortcut/Menu, updater, nav-emit) lands here.
- `src/main/paths.ts` (whole) — the only module that hardcodes on-disk locations + the test seam.
  User settings file = `settingsPath()`; project files under `<projectDir>/.harness/`.
- `src/main/context.ts` (whole) — `AppContext` is append-only; add fields (e.g. `updater`) at the end.
- `src/renderer/app/AppLayout.tsx` (whole) — the 3-pane shell; command palette + settings surface
  mount here. `CenterTab` union at L29.
- `src/renderer/stores/workspaces.ts` (whole) — Zustand store pattern to mirror for a nav/settings
  store; `selectWorkspace` is the nav target deep links drive.
- `src/renderer/ipc/index.ts` (whole) — `invoke`/`onEvent`/`subscribeStream`; renderer calls go
  straight through these (generic).
- `src/renderer/features/sidebar/hooks.ts` + `src/renderer/features/chat/Composer.tsx` — mirror for
  the settings-changed subscriber and the slash-command composer autocomplete respectively.
- `src/main/harness/notifications.ts` (whole) — confirm the toggle names the Settings UI must write.
- `src/main/ipc/CLAUDE.md` — the append-only IPC rules; obey verbatim.

### Modify
- `src/shared/ipc.ts` — **append** to `Commands`: `settings:getEffective`, `settings:getProvenance`,
  `settings:set`, `settings:schema`, `slash:list`, `deepLink:resolve`, `update:check`,
  `update:install`, `onboarding:state`. Add shared DTOs (`SettingsProvenance`, `SettingLayer`,
  `SlashCommand`, `DeepLinkTarget`, `UpdateStatus`, `OnboardingState`) in the DTO region. `Events`
  already has `settings:changed` — reuse.
- `src/main/settings/index.ts` — add `set(layer,key,value)`, `effectiveWithProvenance()`,
  `watch(onChange)`/`stopWatching()`, and validation that returns file+key-path errors instead of
  throwing raw.
- `src/main/ipc/register.ts` — add the 9 new command handlers (each validates/narrows input).
- `src/main/index.ts` — start the settings watcher (emit `settings:changed`), build the app Menu +
  `globalShortcut` accelerators, wire updater check-on-launch, make `handleDeepLink` navigate
  (emit a nav event to the focused renderer), stop the watcher/updater in `before-quit`.
- `src/main/context.ts` — append any new service handles (updater, onboarding detector) at the end.
- `src/renderer/app/AppLayout.tsx` — mount `<CommandPalette>`, add a Settings surface entry point,
  subscribe to `settings:changed`.
- `package.json` — add `electron-updater` (dep); optionally `zod-to-json-schema` (dev).

### Create
- `src/main/settings/write.ts` (+ `.test.ts`) — TOML write-to-layer: read the **raw single-layer**
  file, set the key path, validate the re-merged effective result, `stringify` back. Never serialise
  the merged blob.
- `src/main/settings/provenance.ts` (+ `.test.ts`) — a merge variant that records source layer per
  leaf key. Build provenance **into** the merge (phase doc §8 risk), not as a post-pass.
- `src/main/settings/watch.ts` (+ `.test.ts`) — chokidar watcher over the (up to 3) layer files;
  debounced re-merge; skip invalid layers; callback on valid change.
- `src/main/settings/CLAUDE.md` — subsystem notes (layer order, write-per-layer invariant, hot-reload
  race rule, provenance). Currently absent (DoD requires it for non-obvious behaviour).
- `src/main/update/index.ts` (+ `.test.ts`) — `UpdateService` wrapping electron-updater (`checkForUpdates`,
  `quitAndInstall`, status events). Guarded so a dev/unsigned run degrades to a typed AppError.
- `src/main/onboarding.ts` (+ `.test.ts`) — compose `onboarding:state` from `harness:detect` results
  + GitHub account presence + project count.
- `src/main/shortcuts.ts` (+ `.test.ts`) — pure keymap: default accelerator table + settings override
  merge (unit-testable without Electron).
- `src/shared/slash.ts` — `SlashCommand` DTO + a pure `parseSlash(input)` helper (shared, testable).
- `src/renderer/features/settings/*` — `SettingsPanel.tsx`, `SettingRow.tsx` (value + provenance
  badge + write-to-layer control), `RunScriptEditor.tsx`, `useSettings.ts`, `SettingsPanel.test.tsx`.
- `src/renderer/features/palette/*` — `CommandPalette.tsx`, `useCommands.ts` (action registry +
  hand-rolled fuzzy match — no new dep), `CommandPalette.test.tsx`.
- `src/renderer/features/onboarding/*` — `OnboardingWizard.tsx` (+ test) incl. the **unsandboxed-exec
  security disclosure** (spec §7).
- `src/renderer/stores/nav.ts` — nav store the deep-link event drives (target workspace/pane).
- `src/renderer/features/palette/keymap.ts` — renderer-side keymap consumer (reads `slash:list`-style
  config; registers `keydown` handlers).

## Ordered Tasks

> Tracks are labelled A–H. Within a track, tasks are in dependency order. **Track A must land first.**

### Track A — Settings core (heightened-scrutiny: git/fs on user paths + IPC boundary)

#### Task A1 — Provenance-aware merge
- What: add `effectiveWithProvenance()` returning `{ value, provenance }` where provenance maps each
  leaf key path → the layer (`default|user|project-shared|project-local`) that supplied it. Refactor
  `deepMerge` (index.ts:170) to thread a layer tag, or add a parallel merge in `provenance.ts`.
- Pattern: `src/main/settings/index.ts:83–119` (`load`) — same layer order/precedence, same
  array-atomic rule; defaults are the base layer.
- Gotcha: build provenance *during* the merge (phase doc §8). Arrays are atomic → provenance is the
  whole-array's source layer, not per-element.
- Validate: `node scripts/vitest-electron.mjs run src/main/settings/provenance.test.ts`

#### Task A2 — Validation surfacing (no crash on bad TOML/zod)
- What: parse each layer defensively; on a zod/TOML failure return a structured
  `{ file, keyPath, message }[]` and **skip** the bad layer instead of throwing (phase doc §3.1). Keep
  `load()`'s throw-on-parse behaviour only where a test asserts it, but add a non-throwing
  `loadResult()` the UI path uses.
- Pattern: existing `readTomlLayer` ENOENT-skip (index.ts:139–151); extend to catch parse errors.
- Gotcha: `index.test.ts:232–238` asserts malformed TOML *throws* today — keep that path or update
  the test deliberately (append a new test rather than rewrite the frozen intent).
- Validate: `node scripts/vitest-electron.mjs run src/main/settings/index.test.ts`

#### Task A3 — Write-to-layer path
- What: `set(layer, keyPath, value)` in `write.ts` — resolve the layer's file (`settingsPath()` for
  user; `<projectDir>/.harness/settings{,.local}.toml` for project), read+parse just that file (or
  `{}`), set the key path, **validate the re-merged effective result** through
  `EffectiveSettingsSchema`, then `stringify` (smol-toml) and write **only that layer's** object back.
- Pattern: layer paths from `index.ts:29–34,94–106`; validation reuse `schema.ts`.
- Gotcha (heightened-scrutiny): never write the merged blob (flattens provenance + leaks higher
  layers down). Confine the target path to the intended file — reject `..`/absolute-escape in
  `keyPath` and in any project dir. `smol-toml.stringify` is available (verified).
- Validate: `node scripts/vitest-electron.mjs run src/main/settings/write.test.ts`

#### Task A4 — Hot-reload watcher
- What: `watch.ts` — chokidar-watch the (≤3) layer files; on change, debounce, re-merge, skip invalid
  layers, and invoke the callback with the new snapshot. `SettingsService.watch(cb)`/`stopWatching()`.
- Pattern: `chokidar` is already a dep (used by `DiffService`; grep `src/main/diff` for the
  add/close idiom). Teardown mirrors `diff.stopAll()` in `index.ts:556`.
- Gotcha: re-read at consumption time already works (handlers call `ctx.settings.get()` fresh) — the
  watcher just refreshes the snapshot + emits. Don't mutate an in-flight turn (turn:start snapshots
  settings at start — leave that as-is).
- Validate: `node scripts/vitest-electron.mjs run src/main/settings/watch.test.ts`

#### Task A5 — IPC: settings commands
- What: append `settings:getEffective` (→ `EffectiveSettings`), `settings:getProvenance`
  (→ `SettingsProvenance`), `settings:set` (`{layer,keyPath,value}` → `EffectiveSettings`),
  `settings:schema` (→ JSON schema or the effective defaults) to `Commands`; add handlers.
- Pattern: `Commands` Phase-5 block `src/shared/ipc.ts:199–236`; handler validation shape
  `register.ts:960–975`. `settings:set` is heightened-scrutiny → validate `layer` enum + `keyPath`
  (reject traversal) before calling `write.ts`.
- Gotcha: append-only — never reorder `Commands`. No preload/renderer-client edits (generic funnel).
- Validate: `bash ci/harness-gates.sh typecheck` then `node scripts/vitest-electron.mjs run src/main/settings/index.test.ts`

#### Task A6 — Wire watcher → `settings:changed` in main
- What: in `createAppContext`/`whenReady`, call `settings.watch(() => emit('settings:changed', {}))`;
  stop it in `before-quit`.
- Pattern: `emit` closure `index.ts:212–221`; teardown `index.ts:550–579`.
- Validate: `bash ci/harness-gates.sh typecheck lint`

#### Task A7 — settings CLAUDE.md
- What: document layer order, the write-per-layer invariant, the hot-reload/turn-snapshot race rule,
  and provenance semantics.
- Validate: n/a (doc) — include in the Track A review.

### Track B — Settings UI (depends on A)
#### Task B1 — `useSettings.ts` + `SettingsPanel`/`SettingRow`
- What: fetch `settings:getEffective` + `settings:getProvenance`; render sectioned editor
  (`[scripts] [env] [agent] [git] [mcp] [notifications]`); each row shows effective value +
  provenance badge + a write-to-layer control calling `settings:set`; subscribe to `settings:changed`
  to live-refresh.
- Pattern: store/hook idiom `stores/workspaces.ts`; event subscribe `features/sidebar/hooks.ts`;
  panel layout `features/checks/ChecksPanel.tsx`.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/settings/SettingsPanel.test.tsx`
#### Task B2 — `RunScriptEditor` (feeds Phase-3 run buttons)
- What: add/edit/remove `[scripts].run` entries (name/command/label/icon/`run_mode`) via `settings:set`.
- Validate: same test file (extend).

### Track C — IPC surface for polish commands (depends on A5 pattern; unblocks D/E/H)
#### Task C1 — Append `slash:list`, `deepLink:resolve`, `update:check`, `update:install`,
  `onboarding:state` to `Commands` + DTOs; stub handlers that Tracks D/E/H fill in.
- Pattern: `src/shared/ipc.ts:199–236`; DTO region `:330–405`.
- Validate: `bash ci/harness-gates.sh typecheck`

### Track D — Slash commands (depends on A, C)
#### Task D1 — `shared/slash.ts` `parseSlash` + `slash:list` handler reading `agent.prompts`.
- Validate: `node scripts/vitest-electron.mjs run src/shared/slash.test.ts`
#### Task D2 — Composer autocomplete
- What: parse `/name` in the composer, show a fuzzy menu from `slash:list`, expand the template.
- Pattern: `src/renderer/features/chat/Composer.tsx`.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/chat/ChatPanel.test.tsx`

### Track E — Deep links live (depends on C; backend mostly exists)
#### Task E1 — `deepLink:resolve(url)` parser → `DeepLinkTarget` (`{workspaceId, pane?: 'diff'|'pr'}`).
- Pattern: reuse `findDeepLinkInArgv`/scheme const `index.ts:479–482`.
- Validate: `node scripts/vitest-electron.mjs run src/main/settings/... ` → actually a new
  `src/main/deeplink.test.ts` (valid/invalid URLs → routes).
#### Task E2 — Navigate: `handleDeepLink` emits a nav event to the focused renderer; `nav.ts` store +
  `AppLayout` select workspace/pane + focus.
- Pattern: `handleDeepLink` `index.ts:475–477`; nav via `selectWorkspace` (`stores/workspaces.ts:85`).
- Gotcha: `settings:changed`-style broadcast — reuse `emit`; the payload is the resolved target.
- Validate: `bash ci/harness-gates.sh typecheck lint` + a renderer nav test.

### Track F — MCP passthrough (verify only; ~done)
#### Task F1 — Add a test proving `[mcp]` in settings reaches `StartTurnOpts.mcpConfig` and the adapter
  writes `.mcp.json`. No production code unless the test finds a gap.
- Pattern: `src/main/harness/supervisor.test.ts:152`, `claude-code.ts:226–273`.
- Validate: `node scripts/vitest-electron.mjs run src/main/harness/claude-code.test.ts`

### Track G — Notification preferences UI (depends on B; backend done)
#### Task G1 — Toggle rows in `SettingsPanel` writing `[notifications]` via `settings:set`
  (`enabled`/`onTurnComplete`/`onError`/`onNeedsAttention`; `needs_attention` stays effectively on).
- Pattern: `notifications.ts` toggle names; Track B row component.
- Validate: extend `SettingsPanel.test.tsx`.

### Track H — Shortcuts + palette, onboarding, auto-update (each depends on C)
#### Task H1 — `shortcuts.ts` pure keymap + `Menu`/`globalShortcut` registration in main.
- What: default accelerator table (⌘⇧N/⌘⇧D/⌘⇧P/⌘T/⌘1..9/⌘K/big-terminal), merged with settings
  overrides; register app `Menu` accelerators (global) + forward context actions to the renderer.
- Pattern: none yet in main — add `Menu.buildFromTemplate` in `whenReady` (`index.ts:517`).
- Gotcha: `globalShortcut.unregisterAll()` in `before-quit`.
- Validate: `node scripts/vitest-electron.mjs run src/main/shortcuts.test.ts`
#### Task H2 — `CommandPalette` (⌘K): action registry + hand-rolled fuzzy; drives the same
  commands as buttons (workspace switch, settings, actions). Mount in `AppLayout`.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/palette/CommandPalette.test.tsx`
#### Task H3 — Onboarding: `onboarding.ts` state + `OnboardingWizard` (harness detect / GitHub connect /
  add project) **with the unsandboxed-exec disclosure** (spec §7).
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/onboarding/OnboardingWizard.test.tsx`
#### Task H4 — Auto-update: `UpdateService` (electron-updater) + `update:check`/`update:install`
  handlers + a manual "Check for updates" UI. **Guard for unsigned/dev** → typed AppError, never crash.
- Gotcha (**flagged risk**): signing/notarization + an update feed is release infra that may not exist
  in this environment. If absent, **descope to a stubbed feed + manual-check-only** and leave a note;
  do not block the whole phase on it. New dep `electron-updater` needs justification (it's the
  README-mandated updater, §6.5 table).
- Validate: `node scripts/vitest-electron.mjs run src/main/update/index.test.ts`

## Execution Strategy
*How `/harness-implement` should build this. Read verbatim.*
- **Task shape:** cross-cutting, multiple **loosely-independent** modules, ~1–2 weeks, with one
  heightened-scrutiny spine (Track A: settings write/watch + IPC boundary) that everything depends on.
- **Pattern:** **prompt-chaining within each track** + **parallelization across tracks**, gated by a
  mandatory `verifier` on the heightened-scrutiny spine (evaluator-optimizer on Track A).
- **Agents:** per track — `coder` (implements) → `test-author` (independent tests) →
  `code-review` + `verifier`. Track A additionally gets a **named security review** (settings write =
  fs writes on user paths + IPC input validation) and a **mandatory `verifier`**.
- **Orchestration:** prefer a **team** if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled (one
  teammate owns each track via the shared task list; file ownership below prevents conflicts); else
  **sequential subagents** — build Track A fully, then fan Tracks B–H out as parallel subagents.
- **Parallel decomposition + file-ownership:**
  - **Track A first, alone** — it modifies `src/main/settings/*`, `src/shared/ipc.ts` (Commands),
    `src/main/index.ts` (watcher), `src/main/context.ts`. Everything else waits on A5's IPC pattern.
  - After A: **C** appends the remaining Commands (single owner of `src/shared/ipc.ts` at a time —
    serialize all `Commands` appends through one agent to avoid append-conflicts).
  - Then parallel, **disjoint file trees**: **B+G** own `src/renderer/features/settings/*`; **D** owns
    `src/shared/slash.ts` + `chat/Composer.tsx`; **E** owns `src/main/deeplink*` + `stores/nav.ts`;
    **F** owns only a harness test; **H1** owns `src/main/shortcuts.ts`+Menu wiring in `index.ts`,
    **H2** owns `features/palette/*`, **H3** owns `features/onboarding/*` + `src/main/onboarding.ts`,
    **H4** owns `src/main/update/*` + `package.json`.
  - **Serialize** edits to the three shared hot files — `src/shared/ipc.ts`, `src/main/index.ts`,
    `src/renderer/app/AppLayout.tsx` — through a single agent each (they're append/mount points many
    tracks touch).
- **Rationale:** the spine is heightened-scrutiny and blocking, so it's built and verified first;
  the remaining tracks touch disjoint file trees and can run concurrently once the IPC pattern and
  the shared maps are in place.

## Validation Gate
Run after each track (from repo root):
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: +vitest +build)
```
Note (memory `broken-git-link`): repo-root git is broken in this checkout — git-dependent hooks
fail-open; rely on the gate + tmpdir-repo tests, not `git diff`.

## Acceptance Criteria
- [ ] All 5 layers merge with correct precedence; provenance shown per key; `settings:set` persists to
      the right file (user vs `.harness/settings.toml` vs `.harness/settings.local.toml`) writing
      only that layer's object.
- [ ] Invalid TOML/zod violations are reported (file+key) without crashing; hot-reload emits
      `settings:changed` and subsystems pick up valid changes (e.g. a new run button appears).
- [ ] MCP servers from `[mcp]` reach the agent (Track F test green).
- [ ] Slash commands expand templates in the composer.
- [ ] Listed shortcuts work and are remappable; ⌘K palette drives navigation + actions.
- [ ] Deep links open the correct workspace/pane; notification click-through uses them.
- [ ] Notification preferences honored from the UI. electron-updater checks/installs (or documented
      descope if release infra is unavailable); onboarding covers harness/GitHub/project + shows the
      unsandboxed-execution disclosure.
- [ ] `src/shared/**` changes are append-only; renderer hardening intact; `src/main/settings/CLAUDE.md`
      added.
- [ ] All Validation Gate blocking gates pass (run /verify).
```
```
