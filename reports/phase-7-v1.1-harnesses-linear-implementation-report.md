# Implementation Report: Phase 7 — v1.1 Codex/Cursor Harnesses, Linear

## Plan
`plans/phase-7-v1.1-harnesses-linear-plan.md`

## Scope of this pass
The plan is a ~2–3 week, 7-task staging document. This cycle delivered the two headline
acceptance goals — **a 2nd/3rd agent CLI (Codex, Cursor) in the same chat UI with
capability-driven degradation**, and **Linear as a 2nd issue tracker** (backend + IPC + issue
picker) — i.e. **Tasks 1–5**. Tasks 6 (monorepo scale) and 7 (deferred polish) are deliberately
staged as follow-on increments (see Deviations); they are the least "prove-the-abstraction"
relevant and the most scope-prone (virtualized diff tree, etc.).

## Orchestration
**Mechanism:** parallel-subagents (the experimental `TeamCreate` tool was unavailable, so the
skill's normal parallel-subagent path was used). The lead (this session) serialized every
shared/hot-file append and integrated each returned diff.

| Agent / role | Task(s) | Outcome |
|---|---|---|
| `codex-coder` (coder) | Task 1 Codex adapter; then Task 3 Cursor adapter | DONE, gate-green |
| `rawterm-coder` (coder) | Task 2 raw-terminal fallback; then Task 4 capability UI | DONE, gate-green |
| `linear-coder` (coder) | Task 5 Linear backend (service/client/auth) | DONE, gate-green |
| **lead** (this session) | all `@shared/*` + `register.ts` + `index.ts` + `context.ts` appends; `PtyService.spawnRaw` + wiring; Linear DTO single-source swap; **Linear issue-picker UI**; security review; gate | DONE |

**Fallback note:** `linear-coder` and `rawterm-coder` both hit their session limits before their
last assignments finished (the Linear DTO import-swap and the Linear picker UI). The lead
completed both directly in the main session — the swap and the `NewWorkspaceDialog` Linear tab +
tests are lead-authored.

## Tasks Completed
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Codex adapter | DONE | `harness/codex.ts` mirrors `claude-code.ts`; own `normalizeCodex`; 17 contract tests vs `fixtures/codex/*`. Registered on the supervisor. |
| 2 | Raw-terminal fallback | DONE | `harness/raw-terminal.ts` — PTY-output-as-transcript, idle-timeout turn boundary (2s), PTY-exit backstop; 8 tests. |
| 3 | Cursor adapter | DONE | `harness/cursor.ts` runs through the Task-2 raw path (`rawTerminalFallback:true`); 10 tests. Registered with the real `PtyService` spawner. |
| 4 | Capability-driven UI | DONE | `stores/harness.ts` centralizes `capabilities()` reads; `Composer` now reads the **selected workspace's** harness (fixed a hardcoded `claude_code` bug); Plan mode hidden for codex/cursor. 7 store tests. |
| 5 | Linear integration | DONE | `integrations/linear/{auth,client,index}.ts` (API-key connect + GraphQL, token via `SecretStore`); full `linear:*` IPC; issue picker + inline connect in `NewWorkspaceDialog`. 29 backend + 5 dialog tests. |
| 6 | Monorepo scale | **STAGED** | Not implemented this pass (follow-on). |
| 7 | Deferred polish | **STAGED** | Not implemented this pass (follow-on). |

## Files Changed
- **Created:**
  - `src/main/harness/codex.ts`, `codex.test.ts`, `fixtures/codex/*.jsonl`
  - `src/main/harness/raw-terminal.ts`, `raw-terminal.test.ts`
  - `src/main/harness/cursor.ts`, `cursor.test.ts`, `fixtures/cursor/{transcript,ansi}.txt`
  - `src/renderer/stores/harness.ts`, `harness.test.ts`
  - `src/main/integrations/linear/{auth,client,index}.ts` (+ `.test.ts` for each)
  - `src/shared/linear.ts` (new shared DTO module)
- **Modified:**
  - `src/main/pty/index.ts` — added `spawnRaw` (surfaces the exit code the raw path needs); `index.test.ts` +1 test
  - `src/main/index.ts` — register Codex + Cursor (Cursor via `PtyService.spawnRaw` as `RawPtySpawner`); construct `LinearService` (shared repo + `SecretStore`)
  - `src/main/context.ts` — appended `linear: LinearService`
  - `src/shared/ipc.ts` — **appended** `linear:*` Commands + `linear:connect` StreamChannel (append-only; nothing reordered)
  - `src/main/ipc/register.ts` — Linear handlers + `linear:connect` producer (mirror `github:*`)
  - `src/renderer/features/chat/Composer.tsx` — read caps via the store, per selected workspace
  - `src/renderer/features/sidebar/NewWorkspaceDialog.tsx` (+ `.test.tsx`) — "From Linear" tab: list `linear:listIssues`, seed composer prompt, inline API-key connect

## Validation Gate Results
| Gate | Result |
|------|--------|
| format (prettier -c) | PASS |
| lint (eslint .) | PASS |
| typecheck (tsc -b) | PASS |
| tests (vitest-electron) | PASS — **56 files, 518 tests** (baseline was 444) |
| build (electron-vite) | PASS |

New behaviour exercised by tests: `codex.test.ts`, `cursor.test.ts`, `raw-terminal.test.ts`,
`pty/index.test.ts` (`spawnRaw` exit-code), `stores/harness.test.ts` (Plan hidden per harness),
`integrations/linear/*.test.ts`, `NewWorkspaceDialog.test.tsx` (Linear tab + connect).

## Acceptance Criteria
- [x] Workspace with harness = Codex / Cursor runs a turn, streams, renders in the same chat UI (JSON stream for Codex; raw fallback for Cursor). *(Adapters registered + selectable; contract-tested. Live end-to-end run needs the real CLIs installed — see drift note.)*
- [x] Capability flags drive the UI: Plan mode hidden for codex/cursor, shown for claude_code; no crashes; centralized in `stores/harness.ts` (no feature branch on harness id).
- [x] Codex/Cursor adapter contract tests pass against recorded fixtures (incl. raw-terminal path).
- [x] Connect Linear (API-key) + pick an issue to seed a workspace. Branch/PR write-back + settings-gated status transition: **backend + IPC implemented and tested** (`linear:link`, `linear:transition`), **not yet wired into the PR-open flow** — see Deviations.
- [ ] Sparse checkout + diff pagination — **Task 6, staged (not done this pass).**
- [x] `src/shared/**` changes append-only; renderer hardening intact; `npm run check` green.
- [x] Adding Codex/Cursor/Linear required **no feature-UI rewrite** — the one UI change was a **bug fix** (Composer read the wrong harness's caps); Linear reused the existing dialog/IPC generics (no preload/renderer-client change). Lesson: capability reads must be centralized + workspace-scoped, not per-id — realized in `stores/harness.ts`.

## Heightened-scrutiny paths touched
- **Process/terminal execution** (Codex/Cursor adapters, `spawnRaw`): all spawns use argument **arrays**, `shell:false`, prompt passed after a `--` end-of-flags separator; injection tests assert shell metacharacters stay a single arg. Terminal event guaranteed on every path; SIGINT/kill teardown via the supervisor (parity with `claude-code` — raw PTYs are not `ProcessRegistry`-registered, matching the existing agent-child model, Risk R2).
- **Secrets/tokens** (Linear): **named security review PASS** — token confined to `LinearService`→`SecretStore`→`LinearClient`; DB stores only `tokenRef`; no token in logs/errors/IPC frames/renderer (grep-verified: zero logging calls in Linear code; errors carry only HTTP status / Linear's own GraphQL text); `authHeaderValue` uses raw key for `lin_api_` personal keys, `Bearer` for OAuth (correct per Linear); `SecretStore` path-traversal guard reused unchanged; renderer keeps the key in local state behind a password input.
- **IPC/preload boundary**: `linear:*` are typed appends flowing over the existing generic preload bridge (no preload/renderer-client change); every handler narrows its untrusted payload; the connect producer validates `mode`/token and routes failures through `sink.error`.
- **DB/migrations**: none — Linear reuses the existing `integrations` table (`kind` discriminator); sparse-checkout settings (Task 6, deferred) were the only migration-adjacent item and are not in this pass.

## Issues / Deviations
1. **Tasks 6 & 7 staged, not implemented.** Monorepo sparse-checkout + diff pagination/virtualization and the palette/diff polish are the next increment. No stubs were left in the tree.
2. **CLI-drift (plan §9):** the real `codex` / `cursor-agent` CLIs are not installed in this
   environment, so their stream formats and argv are **hand-authored assumptions** (documented in
   each adapter header, versions pinned). Contract tests prove adapter↔assumed-fixture; they must
   be **re-pinned against the real CLIs** before a live run is trusted. `detect()` degrades
   gracefully when a CLI is absent (verified — the gate log shows `cursor-agent not available` handled).
3. **Linear write-back/status-transition not wired to PR-open.** `LinearService.linkWorkspace` /
   `transitionOnPr` and the `linear:link` / `linear:transition` IPC exist and are tested, but the
   `prWorkflow` open/merge path does not yet call them, and there is no settings flag gating the
   transition. Small follow-on (backend done).
4. **No `linear_issue` provenance sourceKind.** The picker creates a `sourceKind:'branch'`
   workspace + seeded prompt to avoid a change to frozen `@shared/models`. Distinct provenance
   tagging is a follow-on (append to the model + main-side handling).
5. **Two worker agents hit session limits** mid-assignment; the lead completed the Linear DTO
   single-source swap and the picker UI directly (noted above).

## Ready for Review
Tasks 1–5 complete; all blocking gates green (518 tests, build passing). Tasks 6–7 and the
follow-ons in Deviations are the next `/harness-implement` cycle.
