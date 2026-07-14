# Implementation Report: Phase 12 — Scheduled Tasks & Usage-Limit Resume

## Plan
`plans/scheduled-tasks-plan.md` (companion design doc: `docs/implementation-plan/phase-12-scheduled-tasks.md`)

## Orchestration
**Mechanism:** sequential (single disciplined chain), run in the main session.

The plan's Execution Strategy is a strictly-sequential dependency chain (shared types → db →
harness → scheduler → IPC → renderer → offer) across three heightened-scrutiny paths and a
frozen, append-only `src/shared/**` contract, with **no independent parallel modules**. The
runtime capability check confirmed the parallel-subagent path (the experimental
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` flag is `1` but the `TeamCreate` tool is **not**
available). Because the chain is tightly coupled to a frozen contract, the production code + tests
were implemented in the main session where the full plan context was warmest (safest for contract
fidelity), and the **mandatory** independent `code-review` + `verifier` agents were run at the end
as the evaluator-optimizer step for the heightened-scrutiny paths.

| Agent / role | Task(s) | Outcome |
|---|---|---|
| main session (coder + test-author) | Tasks 1–8 | DONE |
| code-review (independent) | heightened-scrutiny review | see §"Review" |
| verifier (independent) | completion verification | see §"Review" |

## Tasks Completed
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Shared types (`tasks.ts`, `usageLimit.ts`, `StartTurnOpts.model?`, `task:*` Commands + `task:changed` Event) | DONE | `src/shared/**` strictly appended |
| 2 | DB: migration 0008 + `ScheduledTasksRepo` + schema | DONE | additive; rollback note present |
| 3 | Harness `--model` threading (claude-code) + document-and-ignore (codex/cursor) | DONE | discrete argv element, `shell:false` |
| 4 | `TaskScheduler` service + wiring (index.ts / context.ts) | DONE | never bypasses the supervisor |
| 5 | Six `task:*` IPC handlers with input narrowing | DONE | `task:changed` broadcast per mutation |
| 6 | Renderer Tasks tab + live scheduler-turn visibility | DONE | `turn:event` → chat store |
| 7 | Usage-limit inline offer (`LimitResumeOffer`) + Transcript/ChatPanel threading | DONE | nothing scheduled without the click |
| 8 | Docs (ipc/CLAUDE.md + scheduler/CLAUDE.md) + full gate | DONE | |

## Files Changed
- **Created:** `src/shared/tasks.ts`, `src/shared/usageLimit.ts`, `src/shared/usageLimit.test.ts`,
  `src/main/db/migrations/0008_scheduled_tasks.ts` (+`.test.ts`),
  `src/main/db/repos/tasks.ts` (+`.test.ts`),
  `src/main/scheduler/index.ts`, `src/main/scheduler/scheduler.test.ts`, `src/main/scheduler/CLAUDE.md`,
  `src/main/ipc/register.tasks.test.ts`,
  `src/renderer/stores/tasks.ts`,
  `src/renderer/features/tasks/{useTasks.ts,TasksPanel.tsx,TasksPanel.test.tsx,TaskForm.tsx,ModelPicker.tsx,TaskRow.tsx,StateBadge.tsx,useSchedulerTurnEvents.ts}`,
  `src/renderer/features/chat/LimitResumeOffer.tsx` (+`.test.tsx`).
- **Modified (append-only where frozen):** `src/shared/harness.ts` (`model?`),
  `src/shared/ipc.ts` (task Commands + `task:changed`), `src/main/db/schema.ts`,
  `src/main/db/migrations/index.ts`, `src/main/harness/{claude-code.ts,codex.ts,cursor.ts}`
  (+`claude-code.test.ts`), `src/main/index.ts`, `src/main/context.ts`, `src/main/ipc/register.ts`,
  `src/main/ipc/CLAUDE.md`, `src/renderer/app/AppLayout.tsx`,
  `src/renderer/features/chat/{Transcript.tsx,ChatPanel.tsx}`.
- **Pre-existing test fixups (consequence of migration 0008):** three migration tests that hardcoded
  "latest `user_version` = 7" bumped to 8 (`0005_diff_review.test.ts`, `0006_integrations.test.ts`,
  `index.test.ts`).

## Validation Gate Results
Full `bash ci/harness-gates.sh` — **exit 0 (all gates green).**

| Gate | Result |
|------|--------|
| format | PASS (`prettier -c .`) — see Issues re: the 8 pre-existing files formatted per user decision |
| lint | PASS (`eslint .`) |
| typecheck | PASS (`tsc -b`) |
| tests | PASS — **597 passed / 597** (new: `usageLimit`, `0008_scheduled_tasks`, `repos/tasks`, `scheduler`, `register.tasks`, `TasksPanel`, `LimitResumeOffer`; extended `claude-code`) |
| build | PASS (`electron-vite build`) |
| deps_verify | PASS |
| deps_audit | PASS (0 vulnerabilities) |

## Acceptance Criteria
- [x] `scheduled_tasks` table (migration 0008) applies clean on a fresh DB and a DB at version 7; rollback note present.
- [x] All `src/shared/**` changes are strictly appends (no reordered/renamed/rewritten entries).
- [x] Six `task:*` commands + `task:changed`/`turn:event` events work end-to-end; every IPC handler narrows untrusted input.
- [x] `--model` reaches spawn argv only as a discrete element after `MODEL_PATTERN`; a hostile string stays one argv element (test proves it).
- [x] Scheduler never bypasses the supervisor; `missed` is boot-only; `queued` drains FIFO one-per-turn-end; `conflict` re-queues.
- [x] Usage-limit error → inline offer; click creates a `limit_resume` task at the parsed reset time; nothing scheduled without the click.
- [x] Every §8 test lands and passes; renderer hardening untouched (no preload edits; no Node globals in renderer).
- [x] Heightened-scrutiny review notes written for IPC boundary, process execution, and db migration (see §7 of the design doc + §"Review" below). Independent `code-review` (PASS) + `verifier` (COMPLETE) agents ran.
- [x] Full `bash ci/harness-gates.sh` green — exit 0 (the 8 pre-existing `format` files were formatted per user decision).

## Review (independent agents)
- **`code-review`: PASS.** No Critical/High. One **Medium** — `task:update` re-derived state from any
  non-running state, letting an edit pull a `queued` task out of the FIFO drain or resurrect a `done`
  task (diverges from design §5.2). **Fixed:** `ScheduledTasksRepo.update` now rejects any state outside
  `{pending, scheduled, missed, error}` with `conflict`; the Tasks-tab Edit button is aligned; two
  regression tests added. Three Low nits (a negligible runNow/tick sub-ms race — a pre-existing property
  of the supervisor, not introduced here; an empty live-prompt bubble; the documented instant-turn edge
  case) accepted as non-blocking.
- **`verifier`: COMPLETE.** Independently re-ran the gates (`npm run check` green, 594→597 tests,
  Playwright boot/chat/ipc e2e green including the renderer-hardening leak test), read every §8 test and
  found none vacuous, and verified the append-only / renderer-hardening / security claims against the
  real diff. Its named coverage gap — `reconcileOnBoot`'s `turn_id === null` running branch — now has a
  test. Its two policy concerns were resolved by user decision: format the 8 pre-existing files (done →
  full gate green) and defer the §10.7 live GUI smoke-path to `/verify`.

## Issues / Deviations
- **Pre-existing `format` failures (formatted per user decision).** `prettier -c .` was failing on 8
  files this change never authored (verified unmodified vs `main`); the user opted to `prettier -w` them
  inline so the literal full gate goes green. Formatting only — no logic change.
- **Orchestration deviation:** the plan named `coder`/`test-author` subagents as an *option* ("may run
  as parallel subagents"); given the frozen-contract coupling, production code + tests were written in
  the main session, with the **mandatory** independent `code-review` + `verifier` preserved.
- **One lint suppression (with reason):** `let scheduler` in `index.ts` is `// eslint-disable-next-line
  prefer-const` because the `onTurnEnd` closure forward-references it above its assignment.
- **Instant-turn edge case:** if a scheduler-fired turn terminates *before* its turnId is resolvable
  (`getActiveTurnId` returns undefined — mock/instant turns only), the task still transitions to
  `done`/`error` but its `turn_id` is not recorded and its `turn:event`s are dropped. Normal streaming
  turns are unaffected. Documented in `runTask`.

## Heightened-scrutiny paths touched
- **IPC / preload boundary** (`src/main/ipc/register.ts`): six new handlers, each narrows its untrusted
  payload before acting — non-empty strings, `scheduledAt` a positive integer, `mode` in the closed
  `AgentMode` set, `model` against `MODEL_PATTERN`, `origin` in its closed set; `task:create` verifies
  the workspace exists; `task:runNow`/`task:markDone` state-gate. No preload edits (the maps are
  generic). **No new preload surface.**
- **Process execution** (`src/main/harness/claude-code.ts`): `--model <value>` is a discrete argv
  element under `spawn(shell:false)`, never interpolated; `MODEL_PATTERN` validated at the IPC boundary
  is the defense-in-depth allowlist. Test proves a hostile string stays one inert argv element.
- **DB & migrations** (`0008_scheduled_tasks.ts`): additive (one new table, no existing table touched),
  with the required rollback/back-compat note. Fresh-DB + idempotent re-run tests land.

## Ready for Review
All tasks done; the full `bash ci/harness-gates.sh` is green (exit 0). Both mandatory independent
reviewers ran: `code-review` PASS (its one Medium fixed) and `verifier` COMPLETE. The design-doc §10.7
live GUI smoke-path is deferred to `/verify` per user decision (the integration + Playwright e2e suites
exercise the same code paths). Handoff: run `/verify` for the evidence write-up + live smoke path, then
`/harness-review`.
