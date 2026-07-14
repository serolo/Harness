# Phase 12 — Scheduled Tasks & Usage-Limit Resume

> **Read [`README.md`](./README.md) (esp. §6.2 IPC contract, §6.3 Harness interface, §7 conventions) first.**

**Estimated size:** ~1–1.5 weeks. **Depends on:** Phase 2 (harness/chat/turn plumbing), Phase 6
(settings read path — already landed). **Parallelizable with:** any of Phases 8–11 (no shared
files besides append-only `src/shared/*`).

**Status of this document:** fully planned against the codebase as of 2026-07-12. Every file path,
line anchor, and template named below was verified on disk during planning; the "Findings" section
records what exists and what does not, so an implementing agent does not need to re-derive it.

---

## 1. Goal

Two user problems, one feature:

1. **"My subscription usage window ran out mid-work; I want the agent to pick the work back up at
   HH:MM when the limit resets."** When a chat turn dies with a usage-limit error, the chat shows an
   inline **"Schedule resume at HH:MM"** offer (reset time parsed from the CLI's error message).
   One click creates a scheduled resume task; **nothing is ever scheduled without the click.**
2. **A per-workspace task system**: each task carries a **prompt + model + permission mode + an
   *optional* one-shot schedule time**. Timed tasks fire automatically at their date+time; untimed
   tasks sit in the list until the user runs them manually ("Run now") or marks them done. A new
   **"Tasks" center tab** (next to Chat / Terminal / Diff) lists them with state badges and actions.

Session continuity comes for free: every new turn already auto-resumes the workspace's last harness
session (the `turn:start` producer resolves `recorder.latestSessionId(workspaceId)` into
`opts.sessionId`), so a "resume task" is nothing more than a new turn fired at the reset time.

### Product decisions (locked with the product owner — do not re-litigate)

| Question | Decision |
|---|---|
| Limit-reached behaviour | **Inline offer, user confirms.** No auto-scheduling, no silent retries. |
| What is a task | Prompt + model + mode + **optional** schedule. Untimed tasks are run/marked-done manually. The existing `todos` feature is untouched. |
| Recurrence | **One-shot only** (a specific date+time). No cron/recurring in this phase. |
| Missed while app closed | Task becomes **`missed`** and waits for the user (re-schedule / run now / mark done). Nothing runs behind the user's back after a restart. Lateness while the app *is* running (laptop sleep) is not "missed" — the task still fires on the first tick after wake. |
| Fire while workspace busy | Task becomes **`queued`** and starts automatically when the active turn ends (FIFO, oldest `created_at` first). |
| Model selection | **Preset dropdown** (`opus` / `sonnet` / `haiku`) + a custom-string escape hatch. **Tasks only** — the normal chat composer keeps the CLI default. |
| Permission mode | **Per-task picker** (`plan` / `default` / `auto_accept`), defaulting to the workspace's effective `agent.mode` ("workspace default"). |
| UI placement | New **"Tasks" center tab**, scoped to the selected workspace. |

---

## 2. Scope

**In scope**
- `scheduled_tasks` table (migration 0008) + `ScheduledTasksRepo`.
- A main-process `TaskScheduler` service (`src/main/scheduler/`): tick loop, boot reconciliation
  (overdue → `missed`), busy → `queued` + drain on turn end, firing turns through the existing
  `HarnessSupervisor`.
- Six `task:*` IPC commands + a `task:changed` broadcast event.
- `model?: string` appended to the frozen `StartTurnOpts`; `--model` threading in the Claude
  adapter only.
- A shared usage-limit message parser (`src/shared/usageLimit.ts`) + the inline
  `LimitResumeOffer` in the chat transcript.
- Tasks tab UI (`src/renderer/features/tasks/`): list, state badges, create/edit form with model +
  mode + optional datetime pickers, per-state actions.
- Live visibility of scheduler-fired turns in the existing chat transcript via the reserved
  `Events['turn:event']` channel.

**Out of scope**
- Recurring schedules (cron / "every day at HH:MM").
- Auto-scheduling or auto-retry on limit errors (user must click the offer).
- Model selection for normal chat turns / a settings-level default model.
- Model threading for `codex` / `cursor` adapters (document-and-ignore; presets are Claude-specific).
- Any change to the frozen `AgentEvent` union or `TurnHandle` shape.
- Cross-workspace task views (the tab is per-workspace; a global view is a possible follow-up).

---

## 3. Findings from codebase exploration (verified on disk — trust, but re-verify line anchors)

These findings shape the whole design; they are recorded so the implementing agent starts warm.

1. **Session resume already works end-to-end.** `TurnRecorder.latestSessionId(workspaceId)`
   (`src/main/harness/turns.ts:142`) → the `turn:start` producer (`src/main/ipc/register.ts:362`)
   passes it as `opts.sessionId` → the Claude adapter emits `--resume <sessionId>`
   (`src/main/harness/claude-code.ts:219`) and captures the new session id back
   (`turns.ts:137`). A scheduler-fired turn that resolves `latestSessionId` the same way
   **automatically continues the interrupted conversation** — this is the entire "resume when the
   limit resets" mechanism.
2. **There is NO model parameter anywhere.** `StartTurnOpts` (`src/shared/harness.ts:24`) has
   `workspaceDir, prompt, attachments, sessionId?, mode?, mcpConfig, permissionPolicy` — no LLM
   model field. `buildArgs` in `claude-code.ts:215` never passes `--model`. This phase appends the
   field (append-only is the sanctioned move on the frozen interface; all four adapters —
   `claude-code`, `codex`, `cursor`, `mock` — compile unchanged since they take `StartTurnOpts`
   structurally).
3. **There is NO usage-limit detection.** `AppErrorCode` (`src/shared/errors.ts:8`) is a frozen
   closed set without any rate/quota code. A limit failure surfaces as a generic terminal
   `{ kind: 'error', message }` `AgentEvent` (`claude-code.ts:170-198`) → `TurnStatus 'error'`.
   The only rate-limit code in the repo is GitHub REST header handling
   (`src/main/integrations/github/client.ts:13-33`) — unrelated. Detection must pattern-match the
   error `message` string. **There is no fixture of the real CLI limit message** in
   `src/main/harness/fixtures/` (only a generic `error_during_execution`), so the parser must be
   conservative with a graceful no-time fallback (see §6.1).
4. **There is NO scheduler/cron/queue infrastructure.** `setTimeout` appears only tactically
   (session-resolve timeout, diff debounce, kill polling). The scheduler service is greenfield.
5. **One active turn per workspace** is enforced by `HarnessSupervisor`
   (`src/main/harness/supervisor.ts`, in-memory registry keyed by `workspaceId`;
   `AppError('conflict')` if busy). The supervisor exposes a best-effort **`onTurnEnd(workspaceId,
   turnId)` hook** (`supervisor.ts:63`, fired at `supervisor.ts:317-323` after finalize, wired in
   `src/main/index.ts:360`) — this is the drain point for `queued` tasks.
6. **The `Events['turn:event']` broadcast channel is typed but never emitted**
   (`src/shared/ipc.ts:333-335`, "Reserved (Phase 2): a single streamed AgentEvent chunk for a
   turn"). It is the sanctioned vehicle for streaming scheduler-fired turn output to the renderer
   **without adding any new stream channel**. `src/main/ipc/CLAUDE.md` documents the "reserved
   events stay unused" divergence and **must be updated** when this phase starts emitting it.
7. **Templates to clone** (mirror the nearest analogue, per `.claude/rules/conventions.md`):
   - Migration: `src/main/db/migrations/0005_diff_review.ts` (creates `todos` — structurally the
     closest table). Migrations are raw SQL against the better-sqlite3 handle, registered in the
     ordered array in `src/main/db/migrations/index.ts:35`, versioned via `PRAGMA user_version`,
     each in its own transaction. Existing numbers: 0001, 0003, 0005, 0006, 0007 → **next is 0008**.
     (`scripts/migrate.ts` is a throwaway stub — real migrations run at boot via `openDb`.)
   - Repo: `src/main/db/repos/todos.ts` (`TodosRepo`) — uuidv7 ids, epoch-millis timestamps,
     INTEGER 0/1 booleans, explicit `rowToDto`, `AppError('not_found')`, multi-step writes in
     `db.transaction().execute(...)`.
   - Commands: `'todo:list' / 'todo:create' / 'todo:toggle'` (`src/shared/ipc.ts:208-212`).
   - Renderer panel: `src/renderer/features/checks/` (`useChecks.ts` + panel + rows) +
     `src/renderer/stores/checks.ts` (Zustand).
   - Turn-producer shape to mirror in the scheduler: the `turn:start` producer at
     `src/main/ipc/register.ts:322-399` (payload validation, opts assembly from settings +
     `latestSessionId`, started-first event buffering, `sink.error` on failure).
8. **Center tab switcher**: `type CenterTab = 'chat' | 'terminal' | 'diff'` + `CENTER_TABS` at
   `src/renderer/app/AppLayout.tsx:50-54`; tabs get `data-testid="center-tab-<id>"` for free.
9. **Free side effects of going through the supervisor**: `TurnRecorder` persists the turn +
   events (so `chat:history` replays it), workspace status flips `working` → `needs_attention`,
   the `notify:needsAttention` event and the native `NotificationService.turnDone` toast fire on
   completion, and the checkpoint snapshot hook runs. The scheduler must therefore **never bypass
   the supervisor** — it gets persistence, status, and notifications for free, and the supervisor
   remains the single owner of the turn lifecycle.

---

## 4. Design overview

### 4.1 Task state machine

```
                 ┌────────── mark done ───────────────┐
 (no time) ──>  pending ──── run now ────> running ──>│ done
 (time set) ──> scheduled ── due+idle ───> running ───│
                 │  due+busy                 │ turn error
                 ▼                           ▼
               queued ─── turn ends ───>   error ── re-schedule / run now ──> scheduled / running

 boot reconciliation only:
   scheduled (overdue)  -> missed
   queued               -> missed
   running (stale)      -> done | error   (reconciled from the joined turns row)

 missed ── re-schedule ──> scheduled     missed ── run now ──> running     missed ── mark done ──> done
```

Rules:
- `missed` is assigned **only at boot reconciliation** — while the app is running, a late tick
  (e.g. after laptop sleep) still fires the task.
- `queued` drains FIFO (oldest `created_at`), **one task per turn-end** (the drained task's own
  turn-end drains the next).
- `delete` and `update` are rejected with `AppError('conflict')` while `running` (interrupt the
  turn first).
- `running`-before-start write + a tick re-entrancy guard prevent double-fires.

### 4.2 How a scheduled turn reaches the chat UI

The scheduler calls `HarnessSupervisor.startTurn` directly in main (no IPC hop). Its sink forwards
each `AgentEvent` as a broadcast on the reserved `Events['turn:event']` channel
(`{ workspaceId, turnId, event }`). A renderer hook mounted once in `AppLayout` routes these into
the existing per-workspace chat store — so a task firing in a background workspace accumulates
there and is fully visible when the user switches (the sidebar already shows `working` via
`workspace:status`). **No double-render hazard:** only the scheduler emits `turn:event`;
user-initiated turns keep flowing over the scoped `turn:start` stream.

---

## 5. Task breakdown

### 5.1 Shared types (`src/shared/*` — all appends; land first, everything downstream type-checks against this)

**New file `src/shared/tasks.ts`** (pure — import-safe from both processes, no Node/DOM/electron):

```ts
import type { AgentMode } from './harness';

export type TaskState =
  | 'pending'    // untimed, waiting for manual action
  | 'scheduled'  // timed, waiting for its moment
  | 'queued'     // fired while the workspace was busy; drains on turn end
  | 'running'    // its turn is active
  | 'done'       // completed (turn succeeded, or user marked done)
  | 'missed'     // its time passed while the app was closed; needs user action
  | 'error';     // its turn failed, or firing failed

export type TaskOrigin = 'user' | 'limit_resume';

export interface ScheduledTask {
  id: string;                 // UUIDv7
  workspaceId: string;
  prompt: string;
  model: string | null;       // null = CLI default
  mode: AgentMode | null;     // null = effective settings agent.mode at fire time
  scheduledAt: number | null; // epoch millis; null = untimed
  state: TaskState;
  origin: TaskOrigin;
  turnId: string | null;      // set once the task has produced a turn
  errorMessage: string | null;
  createdAt: number;          // epoch millis
  updatedAt: number;
}

export interface CreateTaskReq {
  workspaceId: string;
  prompt: string;
  model?: string;
  mode?: AgentMode;
  scheduledAt?: number;
  origin?: TaskOrigin;        // defaults to 'user'
}

export interface UpdateTaskReq {
  id: string;
  prompt?: string;
  model?: string | null;
  mode?: AgentMode | null;
  scheduledAt?: number | null; // set on pending/missed/error/scheduled → 'scheduled'; null → 'pending'
}

/** Preset dropdown values — `claude --model` accepts these family aliases. */
export const CLAUDE_MODEL_PRESETS = ['opus', 'sonnet', 'haiku'] as const;

/** Conservative allowlist for the custom-model escape hatch. Validated at the IPC boundary
 *  before the string can ever reach spawn argv (defense in depth on top of shell:false). */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/;
```

**New file `src/shared/usageLimit.ts`** (pure; used by the renderer offer — main has no consumer
yet but the helper lives in shared so it can gain one):

```ts
export interface UsageLimitInfo {
  resetsAt: number | null; // epoch millis; null = limit detected but reset time unknown
}

/** Returns null when the message is NOT a usage-limit error. */
export function parseUsageLimitMessage(message: string): UsageLimitInfo | null;
```

Matching strategy (documented in the file header — **no fixture of the real message exists**, so
be conservative and fail toward "offer without a prefilled time" rather than false positives):
1. Primary: `/usage limit reached\|(\d{9,13})/i` — the CLI's known
   `Claude AI usage limit reached|<epoch>` pipe form; normalize epoch seconds → millis when
   `< 1e12`.
2. Secondary: `/usage limit reached.*?resets\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i` —
   textual "… resets at 5pm" → next occurrence of that wall-clock time (today or tomorrow).
3. Fallback: bare `/usage limit reached/i` → `{ resetsAt: null }`.
4. Anything else → `null`. Explicit non-matches to test: GitHub "rate limit" wording, generic
   errors, "usage" alone.

**Append to `src/shared/harness.ts`** — one optional field on the frozen `StartTurnOpts`
(append-only is legal; existing adapters ignore it structurally):

```ts
export interface StartTurnOpts {
  // ... existing fields unchanged ...
  permissionPolicy: PermissionPolicy;
  /** Optional model override passed to the CLI (e.g. `--model sonnet`). APPEND-ONLY (Phase 12). */
  model?: string;
}
```

**Append to `src/shared/ipc.ts`** — after the last existing `Commands` block, mirroring `todo:*`:

```ts
// --- Phase 12: per-workspace scheduled agent tasks (APPEND-ONLY) ---
/** List a workspace's tasks. */
'task:list':     { req: { workspaceId: string }; res: ScheduledTask[] };
/** Create a task (state derived: scheduledAt present → 'scheduled', absent → 'pending'). */
'task:create':   { req: CreateTaskReq; res: ScheduledTask };
/** Edit prompt/model/mode/schedule. Rejected with 'conflict' while running. */
'task:update':   { req: UpdateTaskReq; res: ScheduledTask };
/** Delete. Rejected with 'conflict' while running. */
'task:delete':   { req: { id: string }; res: void };
/** Fire immediately (queues if the workspace is busy). */
'task:runNow':   { req: { id: string }; res: ScheduledTask };
/** Manually mark done without running. */
'task:markDone': { req: { id: string }; res: ScheduledTask };
```

And to `Events`:

```ts
/** A scheduled task for this workspace changed (created/updated/fired/finished). Phase 12. */
'task:changed': { workspaceId: string };
```

**No new `StreamChannel`.** Scheduler turn output reuses the reserved `Events['turn:event']`
broadcast (`ipc.ts:335`). The preload (`src/preload/index.ts`) and renderer IPC client
(`src/renderer/ipc/index.ts`) are generic over the maps — **zero edits needed there** (verified).

### 5.2 Data model — migration 0008 + repo

**New `src/main/db/migrations/0008_scheduled_tasks.ts`** (clone the 0005 shape; `version: 8`;
register at the end of the array in `src/main/db/migrations/index.ts`):

```sql
CREATE TABLE scheduled_tasks (
  id            TEXT PRIMARY KEY,                 -- UUIDv7
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  prompt        TEXT NOT NULL,
  model         TEXT,                             -- NULL = CLI default
  mode          TEXT,                             -- plan|default|auto_accept; NULL = settings default
  scheduled_at  INTEGER,                          -- epoch millis; NULL = untimed
  state         TEXT NOT NULL,                    -- pending|scheduled|queued|running|done|missed|error
  origin        TEXT NOT NULL,                    -- user|limit_resume
  turn_id       TEXT REFERENCES turns(id),        -- NULL until the task has run
  error_message TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_scheduled_tasks_workspace_id ON scheduled_tasks (workspace_id);
CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks (state, scheduled_at);
```

**Rollback / back-compat note (required per `.claude/rules/security.md`):** purely additive —
one new table, no existing table touched, older app versions never read it. Manual rollback:
`DROP INDEX idx_scheduled_tasks_due; DROP INDEX idx_scheduled_tasks_workspace_id;
DROP TABLE scheduled_tasks;`.

Append `ScheduledTasksTable` + the `scheduled_tasks` key to the `Database` interface in
`src/main/db/schema.ts`, typed with the shared unions per the file's convention.

**New `src/main/db/repos/tasks.ts`** — `ScheduledTasksRepo`, cloning `todos.ts` conventions
(uuidv7, epoch millis, explicit `rowToTask`, `AppError('not_found')` on missing rows):

```ts
class ScheduledTasksRepo {
  list(workspaceId: string): ScheduledTask[];            // created_at ASC; UI does display grouping
  get(id: string): ScheduledTask;                        // not_found on miss
  create(input: CreateTaskReq): ScheduledTask;           // state = scheduledAt ? 'scheduled' : 'pending'
  update(id: string, patch: Omit<UpdateTaskReq, 'id'>): ScheduledTask;
      // conflict while running; re-derives state:
      //   scheduledAt set on pending|missed|error|scheduled → 'scheduled'
      //   scheduledAt cleared → 'pending'
  setState(id: string, state: TaskState,
           extra?: { turnId?: string; errorMessage?: string | null }): ScheduledTask;
  delete(id: string): void;                              // conflict while running
  listDue(now: number): ScheduledTask[];                 // state='scheduled' AND scheduled_at <= now, ASC
  nextQueued(workspaceId: string): ScheduledTask | undefined; // oldest 'queued'
  reconcileOnBoot(now: number): string[];                // returns affected workspaceIds
}
```

`reconcileOnBoot` (single transaction):
- `scheduled` with `scheduled_at <= now` → `missed`;
- `queued` → `missed`;
- stale `running` → join `turns` on `turn_id`: turn `completed` → `done`; turn `error` → `error`;
  turn `interrupted` / still-`streaming` / no turn → `error` with
  `error_message = 'app closed while the task was running'`.

### 5.3 Harness model threading

- `src/main/harness/claude-code.ts` `buildArgs` (~line 215), after the permission-mode block:

  ```ts
  if (opts.model) {
    args.push('--model', opts.model); // discrete argv element — spawn(shell:false), never interpolated
  }
  ```

- `codex.ts` / `cursor.ts` `buildArgs`: **document-and-ignore** — a one-line comment
  (`// opts.model is Claude-specific; codex keeps its CLI default`). `mock.ts` needs nothing
  (structural typing).
- Validation lives at the IPC boundary (`MODEL_PATTERN`) so an arbitrary string can never reach
  argv un-narrowed. This is a **heightened-scrutiny path** (process execution) per
  `.claude/rules/security.md` — call it out in review.

### 5.4 Scheduler service — new `src/main/scheduler/index.ts` (`TaskScheduler`)

```ts
export interface TaskSchedulerDeps {
  repo: ScheduledTasksRepo;
  harness: Pick<HarnessSupervisor, 'startTurn' | 'isActive' | 'getActiveTurnId'>;
  getWorkspace: (id: string) => Workspace | null;
  settings: Pick<SettingsService, 'get'>;
  latestSessionId: (workspaceId: string) => string | undefined; // ctx.recorder
  emit: <K extends EventChannel>(event: K, payload: EventPayload<K>) => void;
  now?: () => number;       // injectable clock for tests
  tickIntervalMs?: number;  // default 30_000
}

export class TaskScheduler {
  start(): Promise<void>;   // reconcileOnBoot → emit task:changed per affected workspace
                            //   → immediate tick → setInterval
  stop(): void;             // clearInterval; idempotent
  onWorkspaceTurnEnd(workspaceId: string): void; // drain: nextQueued → runTask (fire-and-forget, own catch)
  runNow(id: string): Promise<ScheduledTask>;    // shared by the tick and the task:runNow handler
  private tick(): Promise<void>;                 // re-entrancy-guarded (a `ticking` boolean)
  private runTask(task: ScheduledTask): Promise<void>;
}
```

**`tick()`**: for each task in `repo.listDue(now())` — if `harness.isActive(task.workspaceId)` →
`setState('queued')` + `emit('task:changed', …)`; else `void runTask(task)`.

**`runTask(task)`** — mirrors the `turn:start` producer (`register.ts:322-399`) minus the scoped
stream:
1. `setState('running')` **before** starting (double-fire guard) + `emit('task:changed')`.
2. Resolve the workspace; missing/archived (no `worktreePath`) → `setState('error',
   { errorMessage })`, emit, return.
3. Build `StartTurnOpts` exactly like the producer does: `settings.get()`,
   `sessionId: latestSessionId(workspaceId)` (**this is what makes a limit-resume task continue
   the interrupted session — no extra work**), `mode: task.mode ?? settings.agent.mode`,
   `mcpConfig`, `permissionPolicy`, plus `model: task.model ?? undefined`.
4. Sink: buffer events until the turnId is known (mirror the producer's started-first buffering),
   then emit each as `emit('turn:event', { workspaceId, turnId, event })`. Terminal events:
   `turn_end` → `setState('done', { turnId })`; `error` → `setState('error', { turnId,
   errorMessage: event.message })`; either way emit `task:changed`. `sink.error(e)` → same error
   path.
5. `await harness.startTurn(workspaceId, opts, sink)` in try/catch: `AppError('conflict')` (a
   user turn raced the tick) → back to `setState('queued')`; any other throw → `setState('error')`.
   After it resolves, `getActiveTurnId(workspaceId)` supplies the turnId; record it and flush the
   buffer.

Everything else is free via the supervisor (see Findings §3.9): persistence via `TurnRecorder`
(so the turn appears in `chat:history` on next open), workspace status flips, the
`notify:needsAttention` + native toast on completion, checkpoint snapshot.

**Wiring** (`src/main/index.ts` `createAppContext`, ~line 216):
- Declare `let scheduler: TaskScheduler | undefined;` before the `HarnessSupervisor` construction;
  inside the existing `onTurnEnd` hook body (line 360) append
  `scheduler?.onWorkspaceTurnEnd(workspaceId);` (the hook is already best-effort-guarded by the
  supervisor).
- Construct the repo + `scheduler = new TaskScheduler({...})` after `harness`; add `tasks` and
  `scheduler` to the returned ctx. Append both fields to `AppContext` in `src/main/context.ts`
  (additive per that file's rule).
- In `whenReady`, after `registerIpc(ctx)`: `void ctx.scheduler.start();`.
- In `before-quit`: `try { ctx.scheduler.stop(); } catch { … }` alongside the other teardowns.
  In-flight scheduler turns are interrupted by the existing `harness.quitAll()`; their stale
  `running` rows are fixed by the next boot's `reconcileOnBoot`.

### 5.5 IPC handlers — `src/main/ipc/register.ts` (heightened scrutiny: narrow everything)

Six handlers mirroring the `todo:*` block. Validation before acting (all payloads are untrusted):
- `task:list` — `workspaceId` non-empty string.
- `task:create` — `workspaceId` / `prompt` non-empty strings; `scheduledAt`, if present,
  `Number.isInteger && > 0` (**a past time is allowed** — it simply fires on the next tick;
  document this); `mode` ∈ `plan|default|auto_accept`; `model`, if present, must match
  `MODEL_PATTERN` (rejects whitespace/shell metacharacters); `origin` ∈ `user|limit_resume`.
  Verify the workspace exists (`not_found` otherwise). Create, `emit('task:changed')`, return.
- `task:update` — same field narrowing (nullable variants); the repo rejects `running`.
- `task:delete` — id non-empty; repo rejects `running`.
- `task:runNow` — id non-empty; only valid from `pending|scheduled|missed|error|queued` (else
  `conflict`); delegates to `ctx.scheduler.runNow(id)`.
- `task:markDone` — id non-empty; same state gate; `setState('done')`.

Every mutating handler emits `task:changed { workspaceId }`.

### 5.6 Renderer — Tasks tab + live scheduler-turn visibility

**AppLayout** (`src/renderer/app/AppLayout.tsx:50`): append `'tasks'` to `CenterTab` and
`{ id: 'tasks', label: 'Tasks' }` to `CENTER_TABS`; render branch
`centerTab === 'tasks' ? <TasksPanel workspaceId={selectedWorkspaceId} /> : …`.

**New `src/renderer/features/tasks/`** (template: `features/checks/` + `stores/checks.ts`):
- `useTasks.ts` — mirrors `useChecks.ts`: fetch `task:list` on mount / workspace change; subscribe
  `onEvent('task:changed', p => p.workspaceId === workspaceId && reload())` with cleanup; actions
  `createTask / updateTask / deleteTask / runNow / markDone`, each invoking the command (the
  server emits `task:changed`, so no optimistic bookkeeping). Backing Zustand store
  `src/renderer/stores/tasks.ts` (`tasksByWorkspace` map, mirroring `stores/checks.ts`).
- `TasksPanel.tsx` — list + "New task" button + empty state.
- `TaskForm.tsx` — create/edit dialog: prompt textarea; `ModelPicker`; mode select
  (`plan / default / auto_accept`, defaulting to the workspace's effective `agent.mode` from
  `settings:getEffective`, labeled "workspace default"); optional `<input type="datetime-local">`
  → epoch millis (**no new dependency**); client-side `MODEL_PATTERN` check for friendlier errors
  (the server re-validates).
- `ModelPicker.tsx` — `<select>`: `Default (CLI)` + `CLAUDE_MODEL_PRESETS` + `Custom…` revealing a
  text input.
- `TaskRow.tsx` + `StateBadge.tsx` — badges: `missed` amber, `error` red, `running` pulsing,
  `queued` "waiting for active turn…", `done` muted. Actions per state: **Run now**
  (`pending|scheduled|missed|error|queued`), **Mark done**, **Edit** (opens `TaskForm`; the
  missed-state affordance is a prominent **Reschedule** button opening the form focused on the
  datetime field), **Delete** (hidden while running).

**New `src/renderer/features/tasks/useSchedulerTurnEvents.ts`**, mounted **once** in `AppLayout`:
subscribes `onEvent('turn:event', ({ workspaceId, turnId, event }) => …)` and drives the existing
`useChatStore`: if the workspace's last turn's id ≠ `turnId` → start a new store turn + set busy;
then route events exactly like `useChat.sendTurn`'s chunk handler (`turn_end` → end turn
completed + busy false; `error` → append + end turn error + busy false; else append). Only the
scheduler emits `turn:event`, so there is no dedupe hazard with user turns.

### 5.7 Usage-limit inline offer

- **New `src/renderer/features/chat/LimitResumeOffer.tsx`**: props `{ workspaceId, message }`.
  Renders only when `parseUsageLimitMessage(message)` matches. Copy: "Usage limit reached —
  **Schedule resume at HH:MM**" (local-time-formatted `resetsAt`); when `resetsAt` is `null` the
  button reads "Create resume task…". Click →
  `invoke('task:create', { workspaceId, prompt: 'Continue where you left off.',
  scheduledAt: resetsAt ?? undefined, origin: 'limit_resume' })` → flips to a confirmation state
  ("Scheduled for HH:MM — edit in the Tasks tab"). Nothing is created without the click; the
  prompt/time are editable afterwards via the Tasks tab.
- `src/renderer/features/chat/Transcript.tsx`: the `'error'` event case renders the existing
  error card **plus** `<LimitResumeOffer/>` beneath it. `Transcript` has no `workspaceId` prop
  today — thread it down from `ChatPanel` (additive prop). Because history hydration replays the
  same persisted error event, **the offer survives app restarts** (pairing with the boot-time
  `missed` flow).

### 5.8 Docs

- Update `src/main/ipc/CLAUDE.md`: the reserved `turn:event` channel is now emitted — by the
  scheduler only; user turns keep the scoped `turn:start` stream.
- New `src/main/scheduler/CLAUDE.md`: missed-is-boot-only, queue-drain, conflict-requeue,
  sleep/wake semantics.

---

## 6. IPC surface added by this phase

| Channel | Kind | Shape |
|---|---|---|
| `task:list` | Command | `{ workspaceId } → ScheduledTask[]` |
| `task:create` | Command | `CreateTaskReq → ScheduledTask` |
| `task:update` | Command | `UpdateTaskReq → ScheduledTask` |
| `task:delete` | Command | `{ id } → void` |
| `task:runNow` | Command | `{ id } → ScheduledTask` |
| `task:markDone` | Command | `{ id } → ScheduledTask` |
| `task:changed` | Event | `{ workspaceId }` |
| `turn:event` | Event (reserved → now emitted) | `{ workspaceId, turnId, event: AgentEvent }` — scheduler-fired turns only |

---

## 7. Security notes (heightened-scrutiny paths — named review required)

- **IPC boundary** (`src/main/ipc/register.ts`): all six handlers validate and narrow untrusted
  payloads before acting; enum fields checked against closed sets.
- **Process execution** (`src/main/harness/claude-code.ts`): the `model` string reaches `spawn`
  argv only after passing the `MODEL_PATTERN` allowlist at the IPC boundary; it is always a
  discrete argv element with `shell: false` — never string-interpolated.
- **Turn lifecycle**: the scheduler never bypasses the supervisor; `WorkspaceManager.setStatus`
  remains the only status writer.
- **DB**: additive migration + rollback note (§5.2).
- No secrets are touched; task rows contain only user-authored prompts.

---

## 8. Test plan (Vitest under Electron: `node scripts/vitest-electron.mjs run <file>`; tests next to code)

| File | Exercises |
|---|---|
| `src/main/db/migrations/0008_scheduled_tasks.test.ts` | fresh-DB apply + idempotent re-run (mirror `0005_diff_review.test.ts`) |
| `src/main/db/repos/tasks.test.ts` | CRUD + `rowToTask` round-trip; state derivation on create/update (timed → scheduled, untimed → pending, reschedule missed → scheduled); update/delete `conflict` while running; `listDue` boundary (`<= now`); `nextQueued` FIFO; all four `reconcileOnBoot` branches |
| `src/main/scheduler/scheduler.test.ts` | fake timers + injected `now`; fake supervisor (`isActive`, recording `startTurn` replaying a scripted event sequence into the sink): due task fires → `done`; busy workspace → `queued`; `onWorkspaceTurnEnd` drains FIFO; `AppError('conflict')` from `startTurn` re-queues; error terminal → `error` + message; `turn:event` payload ordering incl. buffered-until-turnId; boot reconcile → `missed`; `stop()` halts ticking; opts assembly (mode default, model passthrough, resume sessionId) |
| `src/shared/usageLimit.test.ts` | pipe-epoch seconds and millis; textual "resets at 5pm"; bare match → `resetsAt: null`; non-matches (GitHub "rate limit", generic errors) |
| `src/main/harness/claude-code.test.ts` (extend) | `buildArgs` emits `['--model','sonnet']` as discrete argv elements; absent when `opts.model` undefined; a hostile model string stays a single argv element |
| IPC validation (extend the existing register test pattern, or new `register.tasks.test.ts`) | rejects empty workspaceId/prompt, bad mode enum, model failing `MODEL_PATTERN`, non-integer `scheduledAt`; `task:runNow` state gating |
| `src/renderer/features/tasks/TasksPanel.test.tsx` | list renders state badges; missed row shows Reschedule/Run-now; create form submits `task:create` with model/mode/time; `task:changed` triggers refetch |
| `src/renderer/features/chat/LimitResumeOffer.test.tsx` | renders only for matching error messages; click invokes `task:create` with parsed `resetsAt` + `origin: 'limit_resume'`; confirmation state |

---

## 9. Ordered implementation steps

1. **Shared types** — `src/shared/tasks.ts`, `src/shared/usageLimit.ts` (+ its test), appends to
   `src/shared/harness.ts` (`model?`) and `src/shared/ipc.ts` (Commands/Events).
2. **DB** — migration `0008_scheduled_tasks.ts` (+ rollback note + test), `schema.ts` append,
   `repos/tasks.ts` + test.
3. **Harness threading** — `--model` in `claude-code.ts` `buildArgs` + test; codex/cursor comments.
4. **Scheduler** — `src/main/scheduler/index.ts` + test; wiring in `index.ts` / `context.ts`.
5. **IPC** — six `task:*` handlers with narrowing + validation tests.
6. **Renderer Tasks tab** — `stores/tasks.ts`, `features/tasks/*`, AppLayout tab,
   `useSchedulerTurnEvents`; panel test.
7. **Limit offer** — `LimitResumeOffer.tsx`, Transcript/ChatPanel prop threading; tests.
8. **Docs + gate** — CLAUDE.md updates (§5.8); `bash ci/harness-gates.sh` green.

---

## 10. Definition of Done

1. All tasks in §5 implemented; `bash ci/harness-gates.sh` green (`tsc -b`, `eslint .`, vitest,
   `electron-vite build`).
2. All `src/shared/**` changes are strictly appends (diff shows no reordered/renamed existing
   entries).
3. Every new behaviour has a test from §8; the full table lands.
4. Migration 0008 runs clean on a fresh DB and on a DB at version 7; rollback note present.
5. Renderer hardening untouched (no preload edits beyond none; no Node globals in renderer).
6. Heightened-scrutiny review notes written for §7's paths (two-reviewer rule).
7. Manual smoke path demonstrated (`/verify`):
   - create a task 1 minute out → it fires, its turn streams into the chat transcript, state → `done`;
   - fire a task while a chat turn is active → `queued` → drains automatically at turn end;
   - restart the app past a task's due time → `missed` badge + Reschedule flow works;
   - simulate a usage-limit error event → inline offer appears, click creates a `limit_resume`
     task at the parsed time, task visible in the Tasks tab.

---

## 11. Risks & open questions

- **Real CLI limit-message format is unverified** (no fixture in the repo). The parser is
  deliberately conservative with a no-time fallback; worst case the offer renders without a
  prefilled time. **Follow-up:** capture a real limit message as a fixture the first time one is
  seen in the wild, and tighten the regex + test against it.
- **Repurposing the reserved `turn:event` channel** diverges from the Phase-3 "reserved events
  stay unused" note in `src/main/ipc/CLAUDE.md` — this is exactly what the reservation was for,
  but the CLAUDE.md update (§5.8) is mandatory, and the emitter set must stay scheduler-only to
  avoid double-rendering user turns.
- **Tick vs user-turn race**: handled by the supervisor being the single source of truth
  (`conflict` → re-queue) plus the `running`-before-start write and the tick re-entrancy guard.
- **Sleep/wake**: interval ticks compare timestamps, so a task due during sleep fires on the first
  tick after wake. Running-app lateness ≠ `missed` (`missed` is boot-only). Documented in the
  scheduler CLAUDE.md.
- **Background-workspace fires**: sidebar `working` status + the completion notification + the
  per-workspace chat store keep the user informed without focus-stealing.
- **Model preset drift**: the `opus|sonnet|haiku` aliases are CLI-owned; if the CLI changes its
  alias set, the custom-string escape hatch is the pressure valve (no release needed).
