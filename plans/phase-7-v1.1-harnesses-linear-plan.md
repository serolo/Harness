# Plan: Phase 7 — v1.1 Codex/Cursor Harnesses, Linear, Monorepo Scale

> **Staging plan** produced by the remaining-work completion pass (Task 7). Phase 7 is
> ~2–3 weeks and **out of scope for that implementation pass** — this document exists so
> Phase 7 can start its own `/harness-implement` cycle from a written contract. Source of
> truth: `docs/implementation-plan/phase-7-v1.1-harnesses-linear.md` (+ README §6.3 harness
> interface, §6.5 integrations). Nothing here is built yet.

## Ticket / Feature
Prove the **harness** and **integration** abstractions were built right by adding a 2nd/3rd
agent CLI (**Codex, Cursor**) and a 2nd issue tracker (**Linear**) **without touching core
feature UI**, plus **monorepo-scale** work (sparse checkout, diff pagination) and deferred
diff/command-palette polish. The abstraction is "proven" only if these land with **no**
changes to feature UI — any UI change needed is a lesson to fold back into README §6 contracts.

## Why now / dependencies
- **Depends on Phase 2** (the `Harness` pattern — `src/main/harness/{claude-code,mock}.ts`,
  `supervisor.ts`, `parser.ts`, `@shared/harness`) and **Phase 5** (the integration pattern —
  `src/main/integrations/{index,github/*}.ts`, `SecretStore`, the `github:connect` device-flow
  stream). Both patterns are frozen and stable, so Phase 7 is additive.
- `HarnessCapabilities` **already carries the four flags** Phase 7 needs
  (`supportsResume`, `supportsMcp`, `supportsPlanMode`, `rawTerminalFallback`) — no shared-type
  change for capability-driven degradation, only real values from the new adapters + UI reads.

## Status ledger (verified against the tree on 2026-07-07)
| Deliverable | State | Evidence |
|---|---|---|
| Codex adapter (`harness/codex.ts`) | ⛔ absent | only `claude-code.ts` + `mock.ts` exist |
| Cursor adapter (`harness/cursor.ts`) | ⛔ absent | — |
| Capability-driven UI degradation | ⛔ absent | flags exist in `@shared/harness`; no UI reads them to hide/disable |
| Raw-terminal chat fallback | ⛔ absent | chat assumes a JSON `AgentEvent` stream (`parser.ts`) |
| Linear integration (`integrations/linear/`) | ⛔ absent | only `integrations/github/*` exists |
| Monorepo scale (sparse checkout, diff pagination) | ⛔ absent | `git`/`diff` services have no sparse/pagination path |
| Deferred diff/palette polish | 🟡 partial | palette exists (Phase 6 H2); per-commit diff extras absent |

## Affected Files

### Read before implementing (the seams to mirror)
- `docs/implementation-plan/phase-7-v1.1-harnesses-linear.md` (whole) + README §6.3/§6.5 — the contract.
- `src/main/harness/claude-code.ts` — the reference `Harness` impl: `detect()`, `startTurn()` →
  `AgentEvent` normalization, `capabilities()`. Mirror this shape for `codex.ts`/`cursor.ts`.
- `src/main/harness/parser.ts` + `parser.test.ts` — JSON-line → `AgentEvent` normalization + fixtures.
- `src/main/harness/supervisor.ts` — `register()` / `listHarnesses()` / `startTurn()`; the frozen
  method surface Phase 7's adapters plug into (no supervisor change expected).
- `src/main/harness/fixtures/` + `claude-code.test.ts` — the recorded-fixture contract-test pattern to
  reproduce for Codex/Cursor (incl. the raw-terminal fallback path).
- `src/main/integrations/index.ts` + `integrations/github/{auth,client,pr}.ts` + `CLAUDE.md` — the
  `IntegrationService` shape, `SecretStore` token handling, and the `github:connect` stream to mirror
  for Linear (OAuth + a GraphQL client instead of REST).
- `src/renderer/features/sidebar/NewWorkspaceDialog.tsx` — the GitHub issue-picker + composer-prefill
  flow to extend for a Linear issue picker.
- `src/renderer/features/chat/{ChatPanel,Composer}.tsx` + `@shared/harness` `HarnessCapabilities` — where
  capability flags must gate plan-mode / MCP / resume affordances (centralize; no branching on harness id).
- `src/main/git/*` + `src/main/diff/*` — the worktree-add + diff-compute paths sparse-checkout + pagination extend.

### Modify (append-only where shared)
- `src/shared/ipc.ts` — **append** Linear commands (`linear:connect` stream or command, `linear:listIssues`,
  `linear:link`) and (if not already exposed) `harness:capabilities`; sparse-checkout config command(s).
  Append DTOs (`LinearIssue`, link result). **Append-only** — never reorder existing entries.
- `src/shared/harness.ts` — add the `HarnessId` union members `codex` / `cursor` are **already present**
  in the enum mirrors (`schema.ts` `harnessIdSchema` lists `claude_code|codex|cursor`) — confirm, don't re-add.
- `src/main/ipc/register.ts` — register the new Linear + sparse-checkout handlers (mirror `github:*`).
- `src/main/index.ts` — register the Codex/Cursor adapters on the supervisor (mirror the `claude_code`
  registration); construct the Linear connector into `IntegrationService`/context.
- `src/main/context.ts` — append any new service handle (Linear connector) at the end (append-only).

### Create
- `src/main/harness/codex.ts` (+ `codex.test.ts` + `fixtures/codex/*`).
- `src/main/harness/cursor.ts` (+ `cursor.test.ts` + `fixtures/cursor/*`).
- `src/main/harness/raw-terminal.ts` (+ test) — turn-boundary heuristics + PTY-output-as-transcript,
  persisted as `events` (`kind='text'`) so chat reconstruction works.
- `src/main/integrations/linear/{index,auth,client}.ts` (+ tests) — OAuth + GraphQL (`graphql-request`),
  token via `SecretStore`.
- `src/renderer/stores/harness.ts` (+ test) — the single place UI reads `capabilities()` per selected
  harness, so no feature-code branches on harness id.
- `src/renderer/features/...` — capability-degradation wiring + Linear issue picker (extend, don't fork).

## Ordered Tasks (each a landed-pattern clone; parallel-safe where noted)

1. **Codex adapter** — `codex.ts` mirroring `claude-code.ts`; `detect()` + `startTurn()` → `AgentEvent`
   via `parser.ts`; capability flags; contract tests vs recorded fixtures. Auth inherited from the user's
   Codex login (no credential handling, spec §1.2). *Owns `harness/codex*`.*
2. **Raw-terminal fallback** — `raw-terminal.ts` for harnesses without a JSON stream: render raw PTY output
   as transcript (reuse Phase 3 PTY), heuristic turn boundaries, persist `kind='text'` events. Resolves
   spec §9. *Blocks Task 3 (Cursor may depend on it).*
3. **Cursor adapter** — `cursor.ts`; if Cursor lacks a JSON stream, set `rawTerminalFallback=true` and use
   Task 2's path. Contract tests vs fixtures. *Owns `harness/cursor*`.*
4. **Capability-driven UI degradation** — `stores/harness.ts` centralizes `capabilities()` reads; hide
   plan-mode selector when unsupported, disable MCP config + resume affordances (fall back to
   summary-seeded new sessions, like checkpoint-revert). No feature branches on harness id. UI tests per
   harness. *Depends on Tasks 1/3 for real flags.*
5. **Linear integration** — `integrations/linear/*`: OAuth + GraphQL client, token via `SecretStore`,
   `kind='linear'` rows; `linear:*` IPC (mirror `github:*`); issue picker in NewWorkspaceDialog
   (prefill composer); write-back (link branch/PR; optional settings-gated status transition on PR
   open/merge). *Owns `integrations/linear/*`; parallel-safe with Tasks 1–4.*
6. **Monorepo scale** — sparse checkout on worktree add (`git sparse-checkout set <paths>`, paths in
   settings — no migration); diff pagination (lazy file/hunk load, virtualized tree — extend Phase 4);
   diff/status cache tuning. Integration tests on a synthetic large repo. *Owns `git`/`diff` extensions.*
7. **Deferred polish** — per-commit diff filtering extras (multi-commit ranges, per-commit view);
   command-palette depth (recent items, provider-aware entries — extends Phase 6 `features/palette/*`).

## Execution Strategy
- **Pattern:** prompt-chaining per task (`coder` → `test-author` → `code-review`); the three adapters
  (Codex/Cursor/Linear) are **landed-pattern clones** and parallelize well after the shared `@shared/ipc`
  appends are serialized through one agent. **Named security review** on the Linear OAuth/token path
  (heightened-scrutiny: secrets — `.claude/rules/security.md`) and on any new subprocess spawn in the
  adapters (command-injection surface).
- **Serialize** the shared hot files: `src/shared/ipc.ts`, `src/main/ipc/register.ts`, `src/main/index.ts`,
  `src/main/context.ts` (append-only, one appender at a time). **Disjoint trees** (parallel): Task 1
  `harness/codex*`, Task 3 `harness/cursor*` (after Task 2), Task 5 `integrations/linear/*`, Task 6
  `git`/`diff` extensions.
- **Risk to watch (spec §9):** CLI format drift across three harnesses multiplies fixture maintenance —
  keep fixtures small + version-pin each CLI. Raw-terminal turn-boundary detection is heuristic
  (best-effort; must not block chat reconstruction).

## Validation Gate
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate (npm run check + build) before PR
```
Note (memory `broken-git-link`): repo-root git + git-dependent hooks remain degraded until the git link
is repaired — rely on the gate + tmpdir-repo tests, not `git diff`.

## Acceptance Criteria (from the phase doc §6)
- [ ] Create a workspace with harness = **Codex** and with **Cursor**; each runs a turn, streams, and
      renders in the **same** chat UI as Claude Code (JSON stream **or** raw fallback).
- [ ] Capability flags drive the UI: unsupported features hidden/disabled per harness, no crashes.
- [ ] Codex/Cursor adapter **contract tests** pass against recorded fixtures (incl. raw-terminal path).
- [ ] Connect **Linear**; pick an issue to seed a workspace; branch/PR links back; optional status
      transition on PR open/merge works (settings-gated).
- [ ] **Sparse checkout** bounds a large-repo worktree; large diffs **paginate** without freezing the UI.
- [ ] `src/shared/**` changes append-only; renderer hardening intact; **`npm run check` green** (run /verify).
- [ ] Adding Codex/Cursor/Linear required **no** feature-UI changes — or the exception is folded back into
      README §6 as a contract lesson.
