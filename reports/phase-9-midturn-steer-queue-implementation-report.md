# Implementation Report: Phase 9 — Mid-Turn Steer & Message Queue

## Plan
`plans/phase-9-midturn-steer-queue-plan.md`

## Orchestration
**Mechanism:** parallel-subagents (the plan named a sequential `coder` → `test-author` chain
with a mandatory parallel `code-review` + `verifier` tail; `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
but the team path was not needed — the frozen-contract coupling makes a single ordered builder
cheaper, exactly as the plan's Execution Strategy prescribed).

| Agent / role | Task(s) | Outcome |
|---|---|---|
| coder | Tasks 1–8 production code (shared → db → main → ipc → renderer) | DONE |
| test-author | repo/supervisor/store/UI tests, capability-literal fixes, E2E (Task 9) | DONE |
| test-author (follow-up) | `useChat.test.tsx` — steer/auto-flush state machine | DONE |
| code-review | heightened-scrutiny review (DB, IPC boundary, turn lifecycle) | PASS w/ findings |
| verifier | independent completion verification | caught a real regression → fixed → green |
| orchestrator (this session) | integration, applied review fixes, fixed the regression, ran gates | DONE |

## Tasks Completed
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Shared contract: `queue.ts`, `HarnessCapabilities.supportsMidTurnSteer`, `SteerResult`/`SteerableTurnHandle`, 6 `Commands` | DONE | Append-only; `TurnHandle` untouched |
| 2 | Migration 0008 + `schema.ts` + `QueuedMessagesRepo` | DONE | Atomic, permutation-checked `reorder`; rollback note |
| 3 | Supervisor `steer()` | DONE | Typed `conflict`, duck-typed `'steer' in handle`, same live sink |
| 4 | MockHarness `{ steerable }` option | DONE | Dynamic capability + sink-injecting `steer` |
| 5 | Close capability-literal blast radius | DONE | 3 adapters + 3 bench profiles + mock profile + Composer literal |
| 6 | IPC handlers (5 `queue:*` + `turn:steer`) | DONE | Every payload narrowed; preload untouched |
| 7 | Renderer queue store | DONE | DB-authoritative (re-loads after each mutation) |
| 8 | Renderer UI + wiring | DONE | `QueueList`, Composer busy→enqueue + "Steer now", `useChat` auto-flush + capability-aware steer/fallback |
| 9 | E2E + full gate | DONE | Playwright queue+auto-flush and steer-fallback specs |

## Files Changed
**Created (production):**
- `src/shared/queue.ts` — `QueuedMessage` DTO
- `src/main/db/migrations/0008_turn_queue.ts` — `queued_messages` table + index + rollback note (version 8)
- `src/main/db/repos/queued-messages.ts` — `QueuedMessagesRepo`
- `src/renderer/stores/queue.ts` — DB-backed per-workspace queue store
- `src/renderer/features/chat/QueueList.tsx` — editable/reorderable/deletable rows + per-row "Steer now"

**Modified (production):**
- `src/shared/harness.ts` — appended `supportsMidTurnSteer` (last field), `SteerResult`, `SteerableTurnHandle`
- `src/shared/ipc.ts` — appended 6 `Commands` (+ imports); no `Events`/`StreamChannels` change
- `src/main/db/schema.ts` — `QueuedMessagesTable` + `queued_messages` on `Database`
- `src/main/db/migrations/index.ts` — registered `migration0008TurnQueue`
- `src/main/harness/supervisor.ts` — `async steer(workspaceId, text)`
- `src/main/harness/mock.ts` — `steerable?` option + `SteerableTurnHandle`
- `src/main/harness/{claude-code,codex,cursor}.ts` — `supportsMidTurnSteer: false`
- `src/main/harness/bench/profiles.ts` — `supportsMidTurnSteer: false` (3 profiles + mock profile)
- `src/main/ipc/register.ts` — 6 narrowed handlers + `isAgentMode` guard
- `src/renderer/features/chat/Composer.tsx` — busy→enqueue routing, always-visible "Steer now", optimistic caps literal
- `src/renderer/features/chat/useChat.ts` — auto-flush-on-idle + capability-aware `steer` (true inject / legible interrupt+resend fallback)
- `src/renderer/features/chat/ChatPanel.tsx` — hosts `QueueList`, wires queue store + steer

**Created (tests / E2E):**
- `src/main/db/repos/queued-messages.test.ts` (11), `src/renderer/stores/queue.test.ts` (6),
  `src/renderer/features/chat/QueueList.test.tsx` (9), `src/renderer/features/chat/useChat.test.tsx` (5),
  `e2e/queue-steer.spec.ts` (2)

**Modified (tests):**
- `src/main/harness/supervisor.test.ts` (+3 steer tests)
- Capability-literal / migration-version updates: `src/main/harness/{cursor,codex}.test.ts`,
  `src/renderer/features/chat/ChatPanel.test.tsx`, `src/renderer/stores/harness.test.ts`,
  `src/main/db/index.test.ts`, `src/main/db/migrations/{0005_diff_review,0006_integrations}.test.ts`
  (the last three: `user_version` "latest" assertion 7 → 8 for the new migration)

_(Not Phase 9: `context.ts`, `index.ts`, `shared/bench.ts`, `bench/`, `fixtures/`, `harness/CLAUDE.md`,
the phase-8 plan/report, and `harness-bench-nightly.yml` are pre-existing Phase-8 working-tree changes.)_

## Validation Gate Results
| Gate | Result |
|------|--------|
| format | **FAIL — pre-existing/out-of-scope** (5 committed-at-HEAD, unmodified files fail `prettier -c`: `sshKeys.ts`, `ghCli.ts`, `SettingsPanel.tsx`, `NewWorkspaceDialog.tsx`, `stores/chat.ts`). All Phase-9 files pass `prettier -c`. Flagged via a background-task chip. |
| lint | PASS (`eslint .`) |
| typecheck | PASS (`tsc -b`) |
| tests | PASS — full Vitest **570 passed, 3 skipped, 0 failed** (61 files). New-behaviour tests: `queued-messages.test.ts`, `supervisor.test.ts` steer block, `stores/queue.test.ts`, `QueueList.test.tsx`, `useChat.test.tsx` |
| build | PASS (`electron-vite build`) |
| E2E | PASS — `7 passed` incl. `queue-steer.spec.ts` (queue+auto-flush order; steer-fallback interrupt+resend) |

## Acceptance Criteria
- [x] Enqueue N messages while a turn streams; each is an editable/reorderable/deletable row
- [x] Queue DB-backed, survives restart (migration 0008 + repo persistence/ordering tests; hydrate-on-open)
- [x] On idle, queue head auto-sends as the next turn, in order (`useChat.test.tsx` head-first + one-per-idle; E2E)
- [x] "Steer now" degrades to interrupt+resend for shipped harnesses when `supportsMidTurnSteer === false` (supervisor conflict test + `useChat.test.tsx` fallback + E2E)
- [x] True injection (no interrupt) when `MockHarness` is `steerable: true` (supervisor + `useChat.test.tsx` short-circuit)
- [x] `supervisor.steer` throws typed `conflict` (never silent) with no active/steerable turn
- [x] `reorder` rejects a non-permutation (missing/extra/duplicate id) and is atomic (single transaction)
- [x] `src/shared/**` append-only; `TurnHandle` unchanged; renderer hardening intact; `src/preload/index.ts` unedited
- [x] Migration 0008 ships with a rollback/back-compat note
- [x] All blocking gates pass (format is pre-existing/out-of-scope, see above)

## Issues / Deviations
- **Regression caught & fixed by the verifier:** registering migration 0008 bumps `PRAGMA user_version`
  to 8, but three committed migration tests asserted 7 as "latest" — the *full* Vitest suite failed
  (6 tests) even though the targeted Phase-9 suites passed. Updated the 6 assertions to 8. (Lesson:
  run the full suite, not just the feature's files, when a migration count changes.)
- **Code-review findings applied** (no Critical): High — `useChat.steer` swallowed a resolved
  `'rejected'` result instead of falling through to the fallback (now only `'injected'`
  short-circuits); Medium — steer dropped the message's `attachments`/`mode` on the fallback resend
  (now threaded through `steer()` and the queued-row path); Medium — queue now auto-advances after a
  steer resend (`flushQueueHead` kicked in both branches); Medium — idle-steer guarded by
  `steerPendingRef`; Low — `queue:update` now rejects an all-whitespace prompt.
- **Deferred (documented):** a steerable-mock E2E proving true injection with no interrupt — the
  shipped app wires a non-steerable `MockHarness` with no runtime hook to enable `steerable`, and per
  scope no production wiring was added to enable it; the true-injection path is proven by the
  supervisor + mock + `useChat` unit tests instead. `codex`/`cursor` are `supportsResume: false`, so
  their fallback resend is a context-less new turn — an accepted, documented degradation (§8), not a bug.

## Heightened-scrutiny paths touched
- **DB & migrations** (`src/main/db/*`): migration 0008 (additive table + index, version 8, rollback
  note); `QueuedMessagesRepo` — Kysely param-bound (no SQL injection), atomic permutation-checked
  `reorder`. Named-clean in review.
- **IPC / preload boundary** (`src/shared/ipc.ts`, `src/main/ipc/register.ts`, `src/preload/index.ts`):
  append-only `Commands`; every handler narrows untrusted payloads (non-empty ids, array attachments,
  `isAgentMode` enum guard, non-empty steer text); no payload interpolated into shell/git; preload
  unchanged (generic `invoke`). Named-clean in review.
- **Process / turn lifecycle** (`src/main/harness/supervisor.ts`, `mock.ts`): `steer()` throws typed
  `conflict` (never silent), duck-types `'steer' in handle`, pushes into the same live sink (no new
  stream), single-turn invariant intact; fallback stays in the renderer (main has no auto-start path).
  Named-clean in review.

## Ready for Review
All Phase-9 tasks done; all blocking gates green (format failure is pre-existing repo drift on files
untouched by this change, tracked separately). Code-review = PASS (findings applied); verifier's hard
blocker (migration-version regression) fixed and the full suite re-run green.

**Handoff:** run `/verify` (evidence), then `/harness-review` (or comment `/claude-review` on the PR).
