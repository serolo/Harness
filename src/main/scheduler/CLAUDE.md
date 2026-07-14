# src/main/scheduler — the scheduled-task firing service (Phase 12)

**Purpose:** turn per-workspace `scheduled_tasks` rows into real agent turns at their time (or on
demand), without ever bypassing the `HarnessSupervisor`. One `TaskScheduler` is constructed in
`src/main/index.ts` (`createAppContext`), `start()`ed in `whenReady` after `registerIpc`, and
`stop()`ped in `before-quit`.

## How it works
- **Tick loop** (`tick`, default every 30s): scans `repo.listDue(now)` (state `scheduled` AND
  `scheduled_at <= now`). For each due task — if the workspace is busy (`harness.isActive`) it is set
  `queued`; otherwise it fires. A `ticking` re-entrancy flag prevents overlapping ticks; a per-tick
  de-dupe fires each workspace at most once (later due tasks for it queue).
- **Firing** (`runTask`): sets the row `running` **before** `startTurn` (double-fire guard), resolves
  `StartTurnOpts` exactly like the `turn:start` producer — crucially `sessionId =
  latestSessionId(workspaceId)`, which is what makes a resume task continue the interrupted session —
  and drives `harness.startTurn`. The sink buffers events until the turnId is known, then mirrors each
  as a `turn:event` broadcast. Terminal events advance the row (`turn_end` → `done`; `error` →
  `error` + message).
- **Queue drain** (`onWorkspaceTurnEnd`, called from the supervisor's `onTurnEnd` hook wired in
  `index.ts`): starts the oldest `queued` task for the workspace. Its own turn-end drains the next, so
  the queue empties **one task per turn-end**, FIFO by `created_at`.

## Load-bearing semantics (don't break these)
- **Never bypass the supervisor.** Going through `startTurn` gives persistence (TurnRecorder → the
  turn shows in `chat:history`), the workspace status machine, the native completion notification, and
  the checkpoint hook — all for free. The scheduler only mirrors events + advances the task row.
- **`missed` is boot-only.** `repo.reconcileOnBoot(now)` (run once in `start()`) is the ONLY place a
  task becomes `missed` (overdue `scheduled` / leftover `queued` → `missed`; stale `running` → `done`
  or `error` from its joined turn). While the app is running, a late tick — e.g. after laptop
  **sleep/wake** — still fires the task; interval ticks compare timestamps, so a task due during sleep
  fires on the first tick after wake. Lateness ≠ missed.
- **Conflict re-queues.** If a user turn races the fire, `startTurn` throws `AppError('conflict')` and
  the task goes back to `queued` (the supervisor is the single source of truth for the one-turn
  invariant).
- **`turn:event` is scheduler-only.** See `src/main/ipc/CLAUDE.md` — user turns use the scoped
  `turn:start` stream; emitting `turn:event` for a user turn would double-render it in the renderer.

## Testing
`scheduler.test.ts` uses a real `ScheduledTasksRepo` over a temp DB + a fake supervisor (records
`startTurn`, exposes the sink) + an injected clock. Note the FK: a fired task records its `turn_id`,
so the fake's turnId must reference a real `turns` row (the test seeds one).
