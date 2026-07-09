# src/main/pty — terminal processes (node-pty)

**Purpose:** `PtyService` owns one `node-pty` process per terminal tab (rendered by xterm.js in the
renderer). Output streams to the renderer over the scoped `pty:open` stream; input/resize/close flow
back in over the keyed `pty:write`/`pty:resize`/`pty:close` commands.

## How it works
Constructed in `src/main/index.ts` **with the shared `ProcessRegistry`**; every `spawn` registers a
handle (`kind: 'pty'`, `stop → kill`) and every exit/kill deregisters it, so archive + app-quit
tree-kill every PTY (README §7.4). `spawn()` is **async** (the native module is dynamically imported
on first use) and resolves the allocated `ptyId` used by `write`/`resize`/`kill`. Env is merged
(`PORT`/`APP_PORT` + workspace vars via `buildEnv`) over the inherited env; `cwd` is the workspace
worktree.

## Transport (Phase 3 decision 1 — scoped streams, not the reserved event)
Bytes reach the renderer over the **scoped `pty:open` stream** (`createStream` / `webContents.send`),
mirroring `turn:start`: the producer sends a leading `{ kind: 'started', ptyId }` frame, then
`{ kind: 'data' }` frames (buffered until `started`, so the id always arrives first). The reserved
broadcast `Events['pty:data']` is **intentionally unused** — the scoped stream supersedes it (see
`src/main/ipc/CLAUDE.md`). **`MessageChannelMain` is a deferred optimization:** `stream.ts` ships a
`createMessageChannelStream`, but the preload has no wiring to receive a transferred port, and adding
it touches the heightened-scrutiny preload boundary. Phase 3 uses the microtask-batched `createStream`
path (adequate soft backpressure). Do **not** add the MessageChannel path unless a perf problem is
demonstrated.

## Gotchas
- **`node-pty` is a NATIVE module.** Keep it out of the type graph where only a type is needed —
  the stub declares its option/chunk types inline rather than importing the binding. It needs
  `electron-rebuild` (`npm run rebuild`) after install / Electron version bumps.
- **Command execution is a heightened-scrutiny path** (`.claude/rules/security.md`): the shell/args
  are an arbitrary-execution surface. Prefer an argument array over a shell string; never build a
  shell command by interpolating untrusted or workspace-derived input.
- Output crosses to the renderer as a stream/event — apply the same backpressure discipline as
  `src/main/ipc/stream.ts`; don't block the event loop pushing large bursts synchronously.
- Every spawned child MUST be registered for teardown — a leaked PTY survives window close.
- **`spawnRaw` (Phase 7) is the exception to registration.** It backs the raw-terminal harness
  fallback (`harness/raw-terminal.ts` → Cursor): unlike `spawn` (which drives a `StreamSink` and
  hides the exit code), it returns a handle exposing raw `onData` chunks **and the exit CODE** via
  `onExit` — the code is what the transcript uses to pick `turn_end` (0) vs `error` (nonzero). It
  deliberately does **not** register in `ProcessRegistry`: agent turns are owned by the
  `HarnessSupervisor` and torn down via its `quitAll`→`interrupt`→`kill` path (parity with the
  `claude-code`/`codex` `child_process` children; the supervisor's deferred-R2 note). The
  returned shape structurally matches `raw-terminal.ts`'s `RawPtyHandle`, so `index.ts` passes the
  service straight in as the injected `RawPtySpawner` with no glue.
