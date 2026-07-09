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
