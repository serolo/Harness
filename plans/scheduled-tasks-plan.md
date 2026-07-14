# Plan: Phase 12 — Scheduled Tasks & Usage-Limit Resume

## Ticket / Feature
Per-workspace scheduled agent tasks (prompt + model + mode + optional one-shot time) plus an inline
"schedule resume at HH:MM" offer when a chat turn dies with a usage-limit error.

> **Companion doc:** [`docs/implementation-plan/phase-12-scheduled-tasks.md`](../docs/implementation-plan/phase-12-scheduled-tasks.md)
> is the full design (state machine §4.1, product decisions §1, security §7, test plan §8). This plan
> is the actionable ordered-task view; `/harness-implement` reads *this* file and follows the doc for
> detail. All line anchors below were re-verified on disk 2026-07-12 during planning.

## Affected Files

### Read before implementing
- `src/shared/harness.ts:24-32` — `StartTurnOpts` (append `model?`), `AgentMode`, `AgentEvent` union (frozen — do not touch).
- `src/shared/ipc.ts:208-212` — `todo:*` Commands block (mirror shape); `:315-347` `Events` map + reserved `turn:event` at `:335`.
- `src/main/db/migrations/0005_diff_review.ts` — closest table migration to clone.
- `src/main/db/migrations/index.ts:35-41` — ordered array; existing 0001/0003/0005/0006/0007 → **next is 0008**.
- `src/main/db/repos/todos.ts` — repo conventions (uuidv7, epoch millis, INTEGER 0/1, explicit `rowToDto`, `AppError('not_found')`, `db.transaction().execute`).
- `src/main/db/schema.ts` — `Database` interface + table typing convention.
- `src/main/harness/claude-code.ts:215-234` — `buildArgs` (insert `--model` after permission-mode block).
- `src/main/harness/turns.ts:137,142` — `latestSessionId(workspaceId)` (the resume mechanism).
- `src/main/harness/supervisor.ts:63,317-323` — `onTurnEnd` hook (queue-drain point); `isActive`/`getActiveTurnId`/`startTurn`.
- `src/main/ipc/register.ts:322-399` — the `turn:start` producer (mirror opts assembly + started-first buffering in the scheduler).
- `src/main/index.ts:216,350-360` — `createAppContext`, the `onTurnEnd` hook body (append the drain call here).
- `src/main/context.ts` — `AppContext` (append `tasks` + `scheduler`, additively).
- `src/renderer/app/AppLayout.tsx:49-56` — `CenterTab` type + `CENTER_TABS`.
- `src/renderer/features/checks/` (`useChecks.ts` + panel + rows) and `src/renderer/stores/checks.ts` — Tasks-tab template.

### Modify
- `src/shared/harness.ts` — append `model?: string` to `StartTurnOpts`.
- `src/shared/ipc.ts` — append six `task:*` Commands + `task:changed` Event.
- `src/main/db/schema.ts` — append `ScheduledTasksTable` + `scheduled_tasks` key.
- `src/main/db/migrations/index.ts` — register `migration0008ScheduledTasks`.
- `src/main/harness/claude-code.ts` — `--model` in `buildArgs`; one-line document-and-ignore comment in `codex.ts` / `cursor.ts`.
- `src/main/index.ts` — construct repo + scheduler; drain call in `onTurnEnd`; `start()` in `whenReady`; `stop()` in `before-quit`.
- `src/main/context.ts` — `tasks` + `scheduler` fields.
- `src/main/ipc/register.ts` — six `task:*` handlers with input narrowing.
- `src/renderer/app/AppLayout.tsx` — `'tasks'` tab + render branch + mount `useSchedulerTurnEvents` once.
- `src/renderer/features/chat/Transcript.tsx` + `ChatPanel.tsx` — render `<LimitResumeOffer/>` under error card; thread `workspaceId` prop.
- `src/main/ipc/CLAUDE.md` — reserved `turn:event` is now emitted (scheduler-only).

### Create
- `src/shared/tasks.ts` — task types, `CLAUDE_MODEL_PRESETS`, `MODEL_PATTERN` (+ no test; pure types).
- `src/shared/usageLimit.ts` + `.test.ts` — `parseUsageLimitMessage`.
- `src/main/db/migrations/0008_scheduled_tasks.ts` + `.test.ts`.
- `src/main/db/repos/tasks.ts` + `.test.ts` — `ScheduledTasksRepo`.
- `src/main/scheduler/index.ts` + `scheduler.test.ts` — `TaskScheduler`.
- `src/main/scheduler/CLAUDE.md` — missed-is-boot-only, queue-drain, sleep/wake semantics.
- `src/renderer/stores/tasks.ts` — Zustand `tasksByWorkspace`.
- `src/renderer/features/tasks/` — `useTasks.ts`, `TasksPanel.tsx` (+ `.test.tsx`), `TaskForm.tsx`, `ModelPicker.tsx`, `TaskRow.tsx`, `StateBadge.tsx`, `useSchedulerTurnEvents.ts`.
- `src/renderer/features/chat/LimitResumeOffer.tsx` + `.test.tsx`.

## Ordered Tasks

### Task 1 — Shared types (land first; everything downstream type-checks against this)
- What: Create `src/shared/tasks.ts` (`ScheduledTask`, `TaskState`, `TaskOrigin`, `CreateTaskReq`, `UpdateTaskReq`, `CLAUDE_MODEL_PRESETS`, `MODEL_PATTERN`) and `src/shared/usageLimit.ts` (`UsageLimitInfo`, `parseUsageLimitMessage`). Append `model?: string` to `StartTurnOpts`. Append six `task:*` Commands + `task:changed` to `src/shared/ipc.ts`.
- Pattern: `src/shared/ipc.ts:208-212` (todo block); `src/shared/harness.ts:24-32` (append-only field).
- Gotcha: **`src/shared/**` is FROZEN append-only** — append, never reorder/rename. `src/shared/*` must be import-safe from both processes (no Node/DOM/electron). Parser must be conservative — no real CLI-message fixture exists; fall back to `{ resetsAt: null }` rather than false-positive (doc §5.1).
- Validate: `node scripts/vitest-electron.mjs run src/shared/usageLimit.test.ts` && `bash ci/harness-gates.sh typecheck`

### Task 2 — DB: migration 0008 + repo
- What: `0008_scheduled_tasks.ts` (table + two indexes, doc §5.2), register in `migrations/index.ts`, append `ScheduledTasksTable` to `schema.ts`, `repos/tasks.ts` (`ScheduledTasksRepo`: `list/get/create/update/setState/delete/listDue/nextQueued/reconcileOnBoot`).
- Pattern: `migrations/0005_diff_review.ts`; `repos/todos.ts`; `migrations/0005_diff_review.test.ts`.
- Gotcha: **Heightened scrutiny (db/migrations).** Additive only — include the rollback note (doc §5.2). `reconcileOnBoot` in a single transaction; all four stale-`running` branches (doc §5.2). `update`/`delete` reject `AppError('conflict')` while `running`. `listDue` boundary is `<= now`.
- Validate: `node scripts/vitest-electron.mjs run src/main/db/migrations/0008_scheduled_tasks.test.ts` && `node scripts/vitest-electron.mjs run src/main/db/repos/tasks.test.ts`

### Task 3 — Harness model threading
- What: In `claude-code.ts` `buildArgs`, after the permission-mode block: `if (opts.model) args.push('--model', opts.model);`. Add document-and-ignore comment in `codex.ts`/`cursor.ts`. Extend `claude-code.test.ts`.
- Pattern: `claude-code.ts:223-228` (adjacent `--permission-mode` push).
- Gotcha: **Heightened scrutiny (process execution).** Model must be a discrete argv element under `spawn(shell:false)` — never string-interpolated. Validation lives at the IPC boundary (`MODEL_PATTERN`); test that a hostile string stays one argv element.
- Validate: `node scripts/vitest-electron.mjs run src/main/harness/claude-code.test.ts`

### Task 4 — Scheduler service + wiring
- What: `src/main/scheduler/index.ts` (`TaskScheduler`: `start/stop/onWorkspaceTurnEnd/runNow/tick/runTask`, doc §5.4). Wire in `index.ts` (construct after `harness`; drain call in `onTurnEnd` body at `:360`; `start()` in `whenReady` after `registerIpc`; `stop()` in `before-quit`) and `context.ts` (`tasks` + `scheduler`).
- Pattern: `register.ts:322-399` (opts assembly + started-first buffering); `index.ts:360` (existing `onTurnEnd` body).
- Gotcha: **Never bypass the supervisor** — persistence/status/notifications come free (doc §3.9). `setState('running')` *before* `startTurn` (double-fire guard) + `ticking` re-entrancy flag. `AppError('conflict')` from `startTurn` → re-`queued`. Resolve `sessionId: latestSessionId(workspaceId)` — this *is* the resume mechanism. Buffer sink events until `turnId` known; emit each as `turn:event`.
- Validate: `node scripts/vitest-electron.mjs run src/main/scheduler/scheduler.test.ts`

### Task 5 — IPC handlers
- What: Six `task:*` handlers in `register.ts` mirroring the `todo:*` block; each mutating handler emits `task:changed { workspaceId }`.
- Pattern: `register.ts` todo handlers.
- Gotcha: **Heightened scrutiny (IPC boundary).** Narrow every untrusted payload before acting: non-empty strings, `scheduledAt` `Number.isInteger && > 0` (past time allowed — fires next tick), `mode ∈ plan|default|auto_accept`, `model` matches `MODEL_PATTERN`, `origin ∈ user|limit_resume`. `task:create` verifies the workspace exists (`not_found`). `task:runNow`/`task:markDone` state-gate to `pending|scheduled|missed|error|queued` (else `conflict`).
- Validate: `node scripts/vitest-electron.mjs run src/main/ipc/register.tasks.test.ts`

### Task 6 — Renderer Tasks tab + live scheduler-turn visibility
- What: `stores/tasks.ts`, `features/tasks/*` (`useTasks`, `TasksPanel`, `TaskForm`, `ModelPicker`, `TaskRow`, `StateBadge`, `useSchedulerTurnEvents`), `AppLayout` tab append + mount `useSchedulerTurnEvents` once.
- Pattern: `features/checks/` + `stores/checks.ts`; `AppLayout.tsx:50-56` (`CenterTab`).
- Gotcha: Renderer stays sandboxed — reach main only through `window.api` (no preload edits needed; maps are generic). `<input type="datetime-local">` → epoch millis (**no new dependency**). `useSchedulerTurnEvents` routes `turn:event` into `useChatStore` — only the scheduler emits it, so no user-turn dedupe hazard. Mode select defaults to effective `agent.mode` from `settings:getEffective` ("workspace default").
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/tasks/TasksPanel.test.tsx`

### Task 7 — Usage-limit inline offer
- What: `LimitResumeOffer.tsx` (renders only when `parseUsageLimitMessage` matches); render it under the error card in `Transcript.tsx`, threading `workspaceId` from `ChatPanel` (additive prop).
- Pattern: `Transcript.tsx` `'error'` event case.
- Gotcha: **Nothing is scheduled without the click.** Click → `task:create` with `origin: 'limit_resume'`, `scheduledAt: resetsAt ?? undefined`, prompt `'Continue where you left off.'`. History replays the persisted error event, so the offer survives restarts (pairs with boot-time `missed`).
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/chat/LimitResumeOffer.test.tsx`

### Task 8 — Docs + full gate
- What: Update `src/main/ipc/CLAUDE.md` (reserved `turn:event` now emitted — scheduler-only); new `src/main/scheduler/CLAUDE.md`.
- Validate: `bash ci/harness-gates.sh`

## Execution Strategy
*How `/harness-implement` should build this. `/harness-implement` reads this verbatim.*
- **Task shape:** Cross-cutting, mostly-sequential dependency chain (shared types → db → harness → scheduler → IPC → renderer), touching **high-stakes / heightened-scrutiny** paths (IPC/preload boundary, process execution, git/fs-adjacent db migration). Not decomposable into independent parallel modules — Tasks 4–7 all depend on Tasks 1–2.
- **Pattern:** prompt-chaining + evaluator-optimizer (mandatory verifier on the heightened-scrutiny paths).
- **Agents:** `coder` (implements each ordered task in sequence) → `test-author` (writes/expands the §8 tests, ideally the regression-first migration/repo/scheduler tests) → `code-review` + `verifier` (**mandatory** — three heightened-scrutiny paths per doc §7).
- **Orchestration:** sequential prompt-chaining for Tasks 1→8 (each task's output is the next's input). Within a task, `coder` and `test-author` may run as parallel subagents. Prefer a team if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled; else parallel subagents. **No cross-module parallel decomposition** — the chain is a true dependency order.
- **Parallel decomposition + file-ownership:** none across tasks (sequential). The only safe concurrency is coder-vs-test-author on the *same* task, with test-author owning `*.test.ts(x)` files and coder owning implementation files, so they never touch the same file.
- **Rationale:** the dependency chain and the three heightened-scrutiny paths make a single disciplined chain with a mandatory independent verifier far safer than fan-out; multi-agent parallelism would only add coordination cost with no independent modules to exploit.

## Validation Gate
Run after all tasks (from repo root):
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: tsc -b + eslint + vitest + electron-vite build)
```

## Acceptance Criteria
- [ ] `scheduled_tasks` table (migration 0008) applies clean on a fresh DB **and** a DB at version 7; rollback note present.
- [ ] All `src/shared/**` changes are strictly appends (diff shows no reordered/renamed/rewritten existing entries).
- [ ] Six `task:*` commands + `task:changed`/`turn:event` events work end-to-end; every IPC handler narrows its untrusted input.
- [ ] `--model` reaches `spawn` argv only as a discrete element after passing `MODEL_PATTERN`; hostile strings stay one argv element (test proves it).
- [ ] Scheduler never bypasses the supervisor; `missed` is assigned only at boot; `queued` drains FIFO one-per-turn-end; `conflict` re-queues.
- [ ] Usage-limit error → inline offer; click creates a `limit_resume` task at the parsed reset time; nothing scheduled without the click.
- [ ] Every §8 test lands and passes; renderer hardening untouched (no preload edits, no Node globals in renderer).
- [ ] Heightened-scrutiny review notes written for the IPC boundary, process execution, and db migration (doc §7, two-reviewer rule).
- [ ] All Validation Gate blocking gates pass (run `/verify`); manual smoke path from doc §10.7 demonstrated.
