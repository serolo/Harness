# Phase 7 — v1.1: Codex/Cursor Harnesses, Linear, Monorepo Scale (Electron)

> **Read [`README.md`](./README.md) (esp. §6.3 Harness interface) first.**

**Spec refs:** §4.3 (Codex/Cursor adapters), §6 (Linear), §5.3 (per-commit diff extras), §8 (v1.1), §9 (monorepo scale, open questions).
**Estimated size:** ~2–3 weeks. **Depends on:** Phase 2 (harness pattern), Phase 5 (integration pattern). **Post-v1.**

---

## 1. Goal

Prove the harness abstraction and integration abstraction were built right by adding a second and third
agent CLI (Codex, Cursor) and a second issue tracker (Linear) **without touching the core UI**, plus the
monorepo-scale improvements (sparse checkout, diff pagination) and the deferred diff/command polish.

---

## 2. Scope

**In scope**
- `codex.ts` and `cursor.ts` `Harness` implementations mapping to each CLI's headless/JSON mode.
- **Capability flags** (`supportsResume`, `supportsMcp`, `supportsPlanMode`, plus `rawTerminalFallback`
  for CLIs without a JSON stream) so the UI degrades gracefully per harness.
- Raw-terminal chat fallback (resolve spec §9 open question) for harnesses lacking JSON streams.
- **Linear** integration: OAuth, GraphQL; issue picker for workspace creation; write-back (link
  branch/PR to issue, optional status transition on PR open/merge).
- Monorepo scale: **sparse checkout** support, diff pagination, `git status`/diff caching tuning.
- Per-commit diff filtering extras + command-palette depth (deferred polish from Phase 4/6).

**Out of scope**
- Cloud/remote execution, Windows/Linux, multi-repo workspaces (all v1 non-goals, spec §1.3).

---

## 3. Task breakdown

### 3.1 Codex adapter (`src/main/harness/codex.ts`)
- `detect()` (version + auth), `startTurn()` mapping to Codex's headless/JSON mode via `child_process`
  → normalize to `AgentEvent`. Contract tests against recorded Codex fixtures. Set capability flags.
  Auth inherited from the user's Codex login (no credential handling), per spec §1.2.

### 3.2 Cursor adapter (`src/main/harness/cursor.ts`)
- Same shape for Cursor's CLI. If Cursor lacks a structured JSON stream, use the **raw-terminal
  fallback** (§3.4) and set `rawTerminalFallback = true`. Contract tests against fixtures.

### 3.3 Capability-driven UI degradation
- UI reads `capabilities()` per selected harness: hide plan-mode selector when unsupported, disable MCP
  config, disable resume-dependent affordances (fall back to summary-seeded new sessions like the
  checkpoint-revert path). Centralize in the harness store so no feature-code branches on harness id.

### 3.4 Raw-terminal chat fallback
- For harnesses without a JSON event stream: render the agent's raw PTY output as the transcript (reuse
  Phase 3 PTY rendering), detect turn boundaries heuristically, still persist as `events`
  (`kind='text'`) so chat reconstruction works. Resolves the spec §9 open question.

### 3.5 Linear integration (`src/main/integrations/linear/`)
- OAuth + GraphQL client (`graphql-request`), mirroring the GitHub `IntegrationService` shape; token via
  `safeStorage`; `integrations(kind='linear')` row. Issue picker in the New Workspace dialog (prefill
  composer with issue title+body, like GitHub issues). Write-back: attach branch/PR to the Linear issue;
  optional status transition on PR open/merge (settings-gated).

### 3.6 Monorepo scale (`src/main/git/`, `src/main/diff/`)
- **Sparse checkout** on worktree add (`git sparse-checkout set <paths>`) to bound working-tree size.
  Diff **pagination** for very large change sets (lazy file/hunk loading, virtualized tree — extend
  Phase 4). Tune diff/status caching for large repos (spec §9).

### 3.7 Deferred polish
- Per-commit diff filtering extras (multi-commit ranges, per-commit view). Command-palette depth (more
  actions, recent items, provider-aware entries).

---

## 4. Data model owned by this phase
- Reuses `integrations` (add `kind='linear'` rows). Sparse-checkout paths stored in settings (no
  migration). **Decision:** settings-driven.

## 5. IPC surface added
- Commands: `linear:connect`, `linear:listIssues(projectId)`, `linear:link(workspaceId, issue)`,
  `harness:capabilities(id)` (if not already exposed), sparse-checkout config commands.
- Events: none new (reuse `checks:updated`, `workspace:*`).

## 6. Definition of Done
- [ ] Create a workspace with harness = Codex and with harness = Cursor; each runs a turn, streams, and
      renders in the same chat UI as Claude Code (JSON stream or raw fallback).
- [ ] Capability flags drive UI: unsupported features hidden/disabled per harness, no crashes.
- [ ] Codex/Cursor adapter contract tests pass against recorded fixtures.
- [ ] Connect Linear; pick an issue to seed a workspace; branch/PR links back; optional status
      transition on PR open/merge works.
- [ ] Sparse checkout bounds a large-repo worktree; large diffs paginate without freezing the UI.
- [ ] `npm run check` green.

## 7. Tests
- Codex/Cursor contract tests (recorded fixtures → `AgentEvent` snapshots), incl. the raw-terminal
  fallback path.
- Capability-degradation UI tests per harness.
- Linear client against mocked HTTP (issues, link write-back, status transition).
- Sparse checkout + large-diff pagination integration tests on a synthetic large repo.

## 8. Risks / notes
- **CLI format drift across three harnesses** multiplies fixture-maintenance burden — keep fixtures
  small and focused; version-pin each CLI (spec §9).
- The abstraction is "proven" only if adding Codex/Cursor/Linear required **no** changes to feature UI —
  if it did, fold that back into the contracts in README §6 as a lesson.
- Raw-terminal fallback turn-boundary detection is heuristic — best-effort; don't block chat
  reconstruction on it.
