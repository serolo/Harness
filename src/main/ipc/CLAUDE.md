# src/main/ipc — the main-process IPC surface

**Purpose:** wire every renderer-reachable capability onto the main process, behind a typed error
boundary. Called once as `registerIpc(ctx)` from `src/main/index.ts` after the `AppContext` is built.

## How it works
Three channel kinds, all typed in `@shared/ipc` (the frozen contract):
- **Commands** (`register.ts` `handle(...)`): request→response via `ipcMain.handle`. Every handler
  is wrapped in the error boundary.
- **Events** (`events.ts`): fire-and-forget `webContents.send('<domain>:<event>', payload)`; the
  renderer subscribes with `api.on(...)`.
- **Streams** (`stream.ts` + the `streamProducers` registry in `register.ts`): scoped streams
  started via `stream:start`, delivering repeated chunks then `end`/`error`. Adding a `StreamChannel`
  in `@shared/ipc` forces a matching `streamProducers` entry (tsc exhaustiveness).

## Gotchas
- **The error boundary is the whole point.** A handler that throws must reject with a value from
  which a typed `AppError` (code + details) can be rebuilt. Electron carries only the Error
  *message* across a `handle()` rejection — so `handle` normalizes via `toAppError`, logs, and
  re-throws an `Error` whose message ENCODES the serialized shape (`encodeAppErrorMessage`); the
  preload decodes it. Never throw a raw object/value out of a handler.
- **Streams clone intact** (`webContents.send` uses structured clone) — a stream `error` frame is a
  plain `SerializedAppError`, no message-encoding needed. This asymmetry with commands is deliberate.
- **Producers must not throw synchronously** — route failures through `sink.error(...)` so the
  renderer sees a typed error on the stream. Async work goes in an IIFE.
- Adding a command/stream = **append** to the map in `@shared/ipc` (never reorder) + add the handler
  or producer here + the preload bridge + the renderer client.

## Phase 3 divergence (decision 2 — reserved events stay unused)
The reserved broadcast events `Events['pty:data']` and `Events['run:log']` are **typed but never
emitted**. Phase 3 delivers PTY output and run-script logs over **scoped streams** (`pty:open` /
`run:start`) instead — each carries a leading `{ kind: 'started', <id> }` frame (the allocated
`ptyId`/`runId`), then `data`/`log` frames, and (for runs) a terminal `{ kind: 'exit' }` frame. This
scopes each stream to one pty/run (no per-frame id, natural teardown via the stream's `AbortSignal`)
and matches the `turn:start` shape. The reserved entries are frozen/append-only — do **not** remove or
reorder them; the only broadcast this phase emits is the existing `workspace:status` `running` overlay.

## Phase 12 divergence — `turn:event` is now emitted (scheduler-only)
The reserved broadcast `Events['turn:event']` (`{ workspaceId, turnId, event }`), typed since Phase 2
and previously never emitted, is now emitted **by the `TaskScheduler` only** (`src/main/scheduler`).
A scheduler-fired turn has no scoped `turn:start` stream (it runs in main, not from a renderer
`api.stream`), so its `AgentEvent`s are mirrored to this broadcast; the renderer routes them into the
shared chat store via `useSchedulerTurnEvents` (mounted once in `AppLayout`). **User-initiated turns
keep flowing over the scoped `turn:start` stream** — the emitter set for `turn:event` MUST stay
scheduler-only, or user turns would double-render. The `task:changed { workspaceId }` broadcast (also
Phase 12) tells the renderer's Tasks tab to refetch after any task mutation.

Before a scheduler turn's first `turn:event`, `task:turnStarted` announces the task id, persisted
turn id, provider session id, and prompt. The renderer uses it to open a dedicated resumable task
chat tab; reopening a workspace reconstructs the same ownership from `task:list` + `chat:history`.

## Durable chat tabs (`chat:contexts:*`) and turn ownership

A chat tab is a real row (`chat_contexts`, migration 0016), not renderer state. The four
`chat:contexts:{list,create,rename,close}` commands construct `ChatContextsRepo(ctx.db)` inline
(like `todo:*`) — the repo is stateless and nothing else needs it, so `AppContext` gains no field.

- **`chat:contexts:list` bootstraps.** It creates the single `'Untitled'` tab when a workspace has
  none, so the DEFAULT TAB HAS ONE SOURCE OF TRUTH. If the renderer invented its own default
  instead, two panel mounts racing on the same workspace would each create one and split the
  transcript — the exact bug this table exists to fix.
- **`turn:start`'s `contextId` is never trusted as given.** It is accepted only after resolving to
  a real row whose `workspaceId` matches the request's (else `AppError('not_found')`), so a turn
  can't be filed into another workspace's transcript. Omitted/empty leaves the turn unowned.
- **Ownership direction is turn→context** (`turns.context_id`), matching the existing task→turn
  edge (`scheduled_tasks.turn_id`). The two are orthogonal and MUST stay so: scheduler-fired turns
  never carry a `contextId`, so a task-owned turn keeps `context_id = NULL` forever and task tabs
  keep reconstructing from `task:list` + `chat:history` exactly as before.
- **Closing a tab never deletes history.** `close` nulls `context_id` on the tab's turns and deletes
  the row in ONE transaction (not via an FK `ON DELETE` action — the column was added by
  `ALTER TABLE` and carries none). `chat:history` is unaffected; the renderer simply stops showing
  NULL-context turns in a manual tab. After migration 0016's backfill, `context_id IS NULL` on a
  non-task turn means only "its tab was explicitly closed" — there is no legacy/fallback bucket.

## Application updater ownership

`UpdateService` is the sole owner of updater state. `update:getStatus` is a read-only hydration
command and MUST NOT start network work; `update:check` is the only renderer-triggered network
operation, and `update:install` is the only restart/install operation. Every transition is broadcast
as `update:status`, allowing a renderer that subscribes before hydrating to close the launch-event
race without introducing another preload primitive.

The installed application consumes the public GitHub release metadata embedded by electron-builder.
It never accepts a feed URL or GitHub token over IPC. `GH_TOKEN`, signing certificates, and Apple
notarization credentials are CI-only secrets and must never enter renderer payloads, packaged
resources, updater status/error messages, or logs.
