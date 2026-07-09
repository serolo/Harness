# Phase 6 — Config, Settings UI & Polish (Electron)

> **Read [`README.md`](./README.md) (esp. §6.5 Settings access) first.**

**Spec refs:** §2.3 (repo settings files), §5.2 (open-in-IDE/big terminal), §5.7 (settings system), §5.8 (shortcuts/deep links/notifications), §8 (M6), §9 (open questions).
**Estimated size:** ~1–2 weeks. **Depends on:** Phase 0 (settings skeleton); touches all phases. **Parallelizable with:** Phase 5.

---

## 1. Goal

Turn the read-only settings skeleton into the full **layered TOML system** (zod validation, hot-reload,
provenance, write-to-correct-layer Settings UI), pass MCP config through to harnesses, add slash
commands, and land the app-wide polish: shortcuts + command palette, deep links, notification
preferences, auto-update (electron-updater), and onboarding. Makes the product feel finished and
configurable.

---

## 2. Scope

**In scope**
- Settings: full 5-layer merge (managed reserved, project-local, project-shared, user, defaults), **zod**
  validation, hot-reload on file change, effective-value view with **provenance**, write-to-layer. Repo
  files `.harness/settings.toml` (committed) + `.harness/settings.local.toml` (gitignored).
- Settings UI: sections `[scripts]` (setup/run/archive, `run_mode`), `[env]`, `[agent]` (default
  harness, mode, permission policy, prompts), `[git]` (branch prefix, merge strategy), `[mcp]`.
- MCP passthrough into harness `startTurn` (generated `.mcp.json` / flags).
- Slash commands in the composer (from settings/prompt library).
- Shortcuts (⌘⇧N/⌘⇧D/⌘⇧P/⌘K/⌘1..9/⌘T, configurable) + **command palette** (⌘K), via Electron
  `globalShortcut`/menu accelerators + in-renderer keymap.
- Deep links `harness://workspace/<id>` (+ `/diff`, `/pr`) fully wired (`open-url` +
  `second-instance`).
- Notification preferences (needs_attention / turn completion / failing checks toggles).
- Auto-update (**electron-updater**) + onboarding flow (detect harness install/auth, connect GitHub, add
  first project, security disclosure that agent/run commands are unsandboxed).

**Out of scope**
- Managed layer distribution (reserved, v2). Linear/Codex/Cursor (Phase 7).

---

## 3. Task breakdown

### 3.1 Settings system (`src/main/settings/`)
- Implement full layered merge (README §6.5 order; highest wins): managed → project-local →
  project-shared → user → defaults. Parse with `smol-toml`; load from `paths` + repo `.harness/` files.
- **Validation:** the **zod** schema validates each merged result; surface errors with file + key path.
  Reject/skip invalid layers gracefully (never crash on bad TOML). Optionally emit a JSON Schema via
  `zod-to-json-schema` for external editors.
- **Hot-reload:** chokidar-watch each layer file; on change, re-merge and emit `settings:changed`;
  subsystems re-read via `SettingsService.get()`.
- **Provenance:** `effectiveWithProvenance()` returns each value + which layer supplied it (for the UI).
- Write path: `set(layer, key, value)` writes to the correct file (serialize back to TOML), re-validates,
  persists.

### 3.2 Settings UI (`src/renderer/features/settings/`)
- Sectioned editor for all keys; shows effective value + provenance badge (which layer) + per-key
  override affordance (write to user vs project-shared vs project-local). Live-updates on
  `settings:changed`. Run-script editor (name/command/icon/label/`run_mode`) feeds Phase 3 buttons.

### 3.3 MCP passthrough
- Read `[mcp]` servers → build `McpServerConfig[]` → pass into `StartTurnOpts.mcpConfig` (Phase 2 already
  threads this) → adapter writes `.mcp.json` / flags. Verify with a test MCP server.

### 3.4 Slash commands
- Composer parses `/name` → expands a prompt template from settings (a prompt library section).
  Autocomplete menu. Reuse for the canned review prompt (Phase 4) and PR-fix prompts (Phase 5).

### 3.5 Shortcuts & command palette
- Central keymap (configurable via settings) → register in-app shortcuts + menu accelerators: ⌘⇧N new
  workspace, ⌘⇧D diff, ⌘⇧P PR, ⌘T terminal, ⌘1..9 switch workspace, ⌘K palette, big-terminal toggle.
  Use Electron `Menu` accelerators for global items; renderer keymap for context actions.
- Command palette (⌘K): fuzzy list of actions + workspace switch + settings; drives the same commands
  as buttons.

### 3.6 Deep links
- Full handler for `harness://workspace/<id>[/diff|/pr]` (macOS `open-url` + `second-instance` for a
  running app) → navigate + focus the right pane. Used by notification click-through (Phases 2/5) and
  external tooling.

### 3.7 Notification preferences
- Settings toggles for each notification class; `needs_attention` always on. Wire to the emit points in
  Phases 2/5.

### 3.8 Auto-update & onboarding
- **electron-updater**: configure the update feed + signed releases; check on launch + manual "Check for
  updates"; download/install with a restart prompt. Onboarding wizard: check `harness:detect` for each
  CLI (install/auth guidance), GitHub connect (Phase 5), add first project, **security disclosure**
  (spec §7: run scripts + agent commands run unsandboxed with user privileges — distinct from the
  hardened renderer).

---

## 4. Data model owned by this phase
- None (settings are files, not DB). UI state (palette recents / window layout) kept client-side — no
  migration.

## 5. IPC surface added
- Commands: `settings:getEffective`, `settings:getProvenance`, `settings:set(layer, key, value)`,
  `settings:schema`, `slash:list`, `deepLink:resolve(url)`, `update:check`, `update:install`,
  `onboarding:state`.
- Events: `settings:changed`.

## 6. Definition of Done
- [ ] All 5 layers merge with correct precedence; provenance shown per key; write-to-layer persists to
      the right file (user vs `.harness/settings.toml` vs `.harness/settings.local.toml`).
- [ ] Invalid TOML/zod violations are reported (file+key) without crashing; hot-reload applies valid
      changes live (`settings:changed`), and subsystems pick them up (e.g. new run button appears).
- [ ] MCP servers from `[mcp]` reach the agent and function.
- [ ] Slash commands expand templates in the composer.
- [ ] All listed shortcuts work and are remappable; ⌘K command palette drives navigation + actions.
- [ ] Deep links open the correct workspace/pane; notification click-through uses them.
- [ ] Notification preferences honored. electron-updater checks/installs; onboarding covers harness/
      GitHub/project + shows the unsandboxed-execution disclosure.
- [ ] `npm run check` green.

## 7. Tests
- Settings: table-driven layered-merge precedence; zod validation (valid/invalid); provenance
  correctness; write-to-layer round-trip (parse→merge→serialize); hot-reload emits `settings:changed`.
- Shortcuts/palette: command dispatch; remap persistence.
- Deep link parser: valid/invalid URLs → routes.
- Renderer: settings editor writes to chosen layer; palette fuzzy match; onboarding steps.

## 8. Risks / notes
- **Provenance across layers** is the fiddly part — build the merge to retain the source layer per key
  from the start, not as an afterthought.
- **Hot-reload races** with in-flight turns — re-read settings at turn start; don't mutate a running
  turn's config.
- **electron-updater signing/notarization** requires release infra (certs, update endpoint, notarized
  builds) — set up early; macOS blocks unsigned auto-updates.
- **Single-instance lock** (`app.requestSingleInstanceLock`) is required for deep-link
  `second-instance` handling — wire it in Phase 0 or here.
- Resolve open questions (spec §9): team-shared settings = the project-shared layer for v1; multi-account
  GitHub UI decision surfaces here.
