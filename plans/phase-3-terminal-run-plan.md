# Plan: Phase 3 — Terminal & Run Scripts

## Ticket / Feature
Give each workspace real node-pty terminals + one-click run scripts (live log tail, port/env
injection, big-terminal mode, open-in-IDE), and consolidate all child-process teardown into a single
shared `ProcessRegistry` wired into Phase-1 archive and app quit.
(Source: `docs/implementation-plan/phase-3-terminal-run.md`; spec §2.2, §5.2, §5.7, §9; README §6.2/§6.4/§7.4.)

## Complexity
**High.** Cross-cutting: main (pty/process/env/ipc) + renderer (terminal/run UI) + two refactors of
existing Phase-1 integration points. Two **heightened-scrutiny paths** apply
(`.claude/rules/security.md`): process/PTY execution (`src/main/pty`, `src/main/process`) and the
IPC/preload boundary. Native module (`node-pty`) already installed.

---

## Key design decisions (read before implementing)

1. **Transport = scoped streams (`createStream`/`webContents.send`), mirroring `turn:start`.**
   `pty:open` and `run:start` are `StreamChannels`, each with a **leading frame** carrying the
   allocated id (like `turn:start`'s `{kind:'started', turnId}`). Writes/resize/close/stop are
   separate request/response `Commands` keyed by that id. The renderer subscribes with
   `subscribeStream(..., { signal })` and cancels on unmount.
   - **`MessageChannelMain` is deferred.** `stream.ts` ships `createMessageChannelStream` for
     high-throughput PTY bytes, **but the preload has no wiring to receive a transferred port**
     (only the `stream:<id>`/`webContents.send` path is bridged). Adding that is a new preload
     bridge method + renderer port handling — a larger change on the heightened-scrutiny preload
     boundary. Phase 3 uses the existing microtask-batched `createStream` path (adequate soft
     backpressure — see `stream.ts` header). Flag `MessageChannelMain` as a follow-up optimization
     in `src/main/pty/CLAUDE.md`. **Do not** modify the frozen preload to add it unless a perf
     problem is demonstrated.

2. **Reserved `Events['pty:data']` / `Events['run:log']` stay unused.** They are frozen
   (append-only — cannot remove) but the scoped-stream transport (decision 1) supersedes them. The
   *only* broadcast event this phase emits is the existing `workspace:status` `running` overlay.
   Document this divergence in the pty/process CLAUDE.md so the next reader isn't confused. Do **not**
   reorder/rewrite the reserved entries.

3. **`ProcessRegistry` is main-only (NOT the frozen `@shared/**` contract)** — its stub in
   `src/main/process/index.ts` may be redesigned. Give it a handle-based API where each owner
   supplies its own `stop()` closure (node-pty → `pty.kill()`; child_process → tree-kill
   escalation), so the registry stays transport-agnostic and does the SIGTERM→SIGKILL escalation in
   one shared helper.

4. **One `buildEnv(...)` helper** feeds PTY, run scripts, and setup (§3.4). Refactor
   `WorkspaceManager.create`'s inline env to route through it. Sharing with the Phase-2 agent spawn
   is an `INTEGRATION(phase-2)` note, not required to land here.

---

## Affected Files

### Read before implementing
- `src/main/ipc/register.ts` (L89–248 `streamProducers`, L71–87 `handle`, L261–303 stream control)
  — the producer pattern to mirror for `pty:open`/`run:start`; the leading-frame + IIFE + `sink.error`
  discipline.
- `src/main/ipc/stream.ts` (L101–195 `createStream`, L36–45 frames) — the stream sink/teardown the
  producers use. **Do not modify.**
- `src/main/harness/supervisor.ts` (L60–253) — the closest "owns live child processes, keyed, with
  interrupt/quitAll" analogue; mirror its registry-clear-before-async discipline.
- `src/renderer/features/chat/useChat.ts` (whole) — the hook pattern for `subscribeStream` +
  leading-frame handling + AbortSignal teardown; mirror for `useTerminal`/`useRun`.
- `src/main/workspace/setup.ts` (whole) — the `execa` streaming-child pattern the `ProcessRunner`
  generalizes.
- `src/main/workspace/index.ts` (L45–75 deps, L164–181 setup env, L214–255 archive) — the
  `stopWorkspaceProcesses` hook + inline env to refactor.
- `src/main/index.ts` (L190–287 `createAppContext`, L217–218 stop hook, L411–430 before-quit) — the
  single construction + teardown site.
- `src/preload/api.d.ts`, `src/preload/index.ts`, `src/renderer/ipc/index.ts` — the bridge/funnel the
  new channels flow through (append via `@shared/ipc`; **no signature changes** to these three).
- `src/main/settings/schema.ts` (L55–90 `[scripts]`) — `run` list + `run_mode` shape already exist.
- `src/renderer/app/AppLayout.tsx` — where the terminal/run pane mounts (center or a tab beside chat).

### Modify
- `src/shared/ipc.ts` — **APPEND-ONLY**: new `Commands` (`pty:write`, `pty:resize`, `pty:close`,
  `run:stop`, `run:list`, `ide:open`), new `StreamChannels` (`pty:open`, `run:start`), and their DTOs.
- `src/main/process/index.ts` — real `ProcessRegistry` (handle-based) + `ProcessRunner` bodies; add
  `src/main/process/env.ts` (buildEnv) and `src/main/process/kill.ts` (tree-kill escalation).
- `src/main/pty/index.ts` — real `PtyService` (node-pty); constructor now takes the `ProcessRegistry`.
- `src/main/ipc/register.ts` — add `pty:open`/`run:start` producers + the 6 new command handlers.
- `src/main/index.ts` — construct `PtyService(registry)`; wire `stopWorkspaceProcesses` →
  `registry.stopWorkspace`; add registry teardown to `before-quit` (after `quitAll`).
- `src/main/workspace/index.ts` — route setup env through `buildEnv`; `stopWorkspaceProcesses` becomes
  the real registry hook (injected).
- `src/renderer/app/AppLayout.tsx` — mount the terminal/run feature.
- `src/main/pty/CLAUDE.md`, `src/main/ipc/CLAUDE.md` — document transport decisions 1 & 2.

### Create
- `src/main/process/env.ts` — `buildEnv({ port, worktreePath, name, settingsEnv })`.
- `src/main/process/kill.ts` — `treeKillEscalate(pid, graceMs)` (SIGTERM → SIGKILL via `tree-kill`).
- `src/main/process/registry.test.ts` — `stopWorkspace`/`killAll` kill a real sleeper tree; escalation.
- `src/main/process/runner.test.ts` — concurrent vs single mode; exit code surfaced; overlay set/clear.
- `src/main/pty/index.test.ts` — open→write→echo round-trip on a temp shell; resize; close deregisters.
- `src/renderer/features/terminal/` — `TerminalPanel.tsx`, `TerminalTab.tsx`, `useTerminal.ts`,
  `RunPanel.tsx`, `useRun.ts`, `terminalStore.ts` (client-side tab persistence), `*.test.tsx`.

---

## Ordered Tasks

### Task 1 — Append the IPC contract to `src/shared/ipc.ts`
- What: APPEND to `Commands`, `StreamChannels`, and new DTOs. Suggested shapes:
  ```ts
  // Commands (append)
  'pty:write':  { req: { ptyId: string; data: string }; res: void };
  'pty:resize': { req: { ptyId: string; cols: number; rows: number }; res: void };
  'pty:close':  { req: { ptyId: string }; res: void };
  'run:stop':   { req: { workspaceId: string; runId: string }; res: void };
  'run:list':   { req: { workspaceId: string }; res: RunScriptInfo[] };
  'ide:open':   { req: { workspaceId: string; ide: IdeName }; res: void };
  // StreamChannels (append)
  'pty:open':  { arg: PtyOpenArg;  chunk: PtyStreamChunk };
  'run:start': { arg: RunStartArg; chunk: RunStreamChunk };
  // DTOs
  export type IdeName = 'cursor' | 'code';
  export interface PtyOpenArg { workspaceId: string; cols?: number; rows?: number }
  export type PtyStreamChunk = { kind: 'started'; ptyId: string } | { kind: 'data'; data: string };
  export interface RunStartArg { workspaceId: string; scriptName: string }
  export type RunStreamChunk =
    | { kind: 'started'; runId: string }
    | { kind: 'log'; chunk: string }
    | { kind: 'exit'; code: number | null; durationMs: number };
  export interface RunScriptInfo { name: string; label?: string; icon?: string; running: boolean; runId?: string }
  ```
- Pattern: `src/shared/ipc.ts:185` (`turn:start`) — leading-frame stream; `:53` (`CloneProgress`) —
  discriminated chunk union.
- Gotcha: **append only**; never reorder/rename existing entries or the reserved `Events` (decision 2).
  Adding a `StreamChannels` key forces a matching `streamProducers` entry (tsc exhaustiveness) — Task 5.
- Validate: `bash ci/harness-gates.sh typecheck`

### Task 2 — `ProcessRegistry` + kill escalation (`src/main/process/{index,kill}.ts`)
- What: Redesign `ProcessRegistry` around a handle:
  `interface ProcessHandle { id: string; workspaceId: string; kind: 'pty'|'run'|'setup'|'agent'; pid?: number; stop(): Promise<void> }`.
  Methods: `register(h)`, `unregister(id)`, `list(workspaceId?)`, `stop(id)`, `stopWorkspace(workspaceId)`,
  `killAll()` (alias/keep for before-quit). `stop*` call each handle's `stop()`, then `unregister`.
  `kill.ts`: `treeKillEscalate(pid, graceMs=5000)` — `tree-kill(pid,'SIGTERM')`, then after grace
  `tree-kill(pid,'SIGKILL')`; resolve when the tree is gone.
- Pattern: `src/main/harness/supervisor.ts:60` (keyed live map, clear-before-async).
- Gotcha (heightened scrutiny): teardown must be idempotent + best-effort — a `stop()` that throws
  must not abort `stopWorkspace`/`killAll` for siblings (`Promise.allSettled`). tree-kill is the single
  reliable path (spec §9, Risk R1).
- Validate: `node scripts/vitest-electron.mjs run src/main/process/registry.test.ts`

### Task 3 — `buildEnv` (`src/main/process/env.ts`)
- What: `buildEnv({ port, worktreePath, name, settingsEnv }): Record<string,string>` →
  `{ ...settingsEnv, PORT, APP_PORT: String(port), WORKSPACE_PATH: worktreePath, WORKSPACE_NAME: name }`.
  Pure; no `process.env` merge here (callers merge at spawn, as `setup.ts` does).
- Pattern: `src/main/workspace/index.ts:168` inline env (this replaces it).
- Gotcha: never interpolate `worktreePath`/`name` into a shell string — they flow only as env values.
- Validate: `bash ci/harness-gates.sh typecheck`

### Task 4 — `PtyService` (`src/main/pty/index.ts`)
- What: real node-pty bodies. `spawn(opts, sink)`: `import('node-pty').spawn(shell, args, {cwd,env,cols,rows})`
  where `shell` defaults to `process.env.SHELL || '/bin/zsh'`, `env = { ...process.env, ...opts.env }`;
  `onData` → `sink.push({ptyId,data})` (as `PtyStreamChunk` `data` frames at the producer, or keep
  `PtyChunk` internally and map in the producer); `onExit` → `sink.end()` + deregister. Constructor takes
  `ProcessRegistry`; register a handle with `stop: () => this.kill(id)`. `write/resize/kill/killAll`.
- Pattern: existing stub signatures (`src/main/pty/index.ts:37`); registry handle like Task 2.
- Gotcha (heightened scrutiny): args are an **array** (never a shell string); `cwd` is the worktree;
  a leaked PTY survives window close — every spawn MUST register + every exit/kill MUST deregister.
  node-pty is native — keep the dynamic `import()` local to the method so the type graph stays clean
  (stub header + pty/CLAUDE.md). Needs `npm run rebuild` if ABI mismatches.
- Validate: `node scripts/vitest-electron.mjs run src/main/pty/index.test.ts`

### Task 5 — `ProcessRunner` + stream producers (`src/main/process/index.ts`, `src/main/ipc/register.ts`)
- What: `ProcessRunner.start(spec, sink)`: `execa(command, { cwd, env:{...process.env,...spec.env}, shell:true, reject:false, all:true })`
  (mirror `setup.ts`); stream `cp.all` → `sink` `log` frames; on exit push `{kind:'exit',code,durationMs}`
  then `end()`; register a handle with `stop: () => treeKillEscalate(cp.pid)`. Track running runs per
  workspace for `run:list` + `run_mode`. `single` mode: stop the workspace's other run(s) before start.
  Runner asks `WorkspaceManager.setStatus(id,'running')` when the first run starts and back to `idle`
  (or prior status) when the last stops — inject a `setStatus`/overlay hook (don't write status directly).
  In `register.ts`: add `pty:open` + `run:start` producers (IIFE + `sink.error`), and the 6 command
  handlers (validate/narrow every payload; resolve workspace → worktree; reject archived/missing).
  `ide:open`: `execFile(ide, [worktreePath], { detached:true })` — **arg array, no shell**, enum-validate `ide`.
- Pattern: `src/main/ipc/register.ts:180` (`turn:start` leading-frame producer); `:373` (`turn:interrupt`
  input validation).
- Gotcha: adding the `StreamChannels` keys (Task 1) makes `streamProducers` non-exhaustive until both
  producers exist (tsc error) — add them together. Producers must not throw synchronously. Overlay must
  clear even if a run crashes (route exit through the same finalize path).
- Validate: `node scripts/vitest-electron.mjs run src/main/process/runner.test.ts`

### Task 6 — Wire construction + teardown (`src/main/index.ts`, `src/main/workspace/index.ts`)
- What: in `createAppContext`: `const pty = new PtyService(processRegistry)`; pass `pty` into ctx;
  give `ProcessRunner` the registry + a `setStatus` overlay hook; replace the
  `stopWorkspaceProcesses` no-op (L217–218) with `(id) => processRegistry.stopWorkspace(id)`. In
  `before-quit` (L414–430): after `quitAll()`, `await processRegistry.killAll()` before `app.quit()`.
  In `WorkspaceManager.create`, build setup env via `buildEnv`.
- Pattern: `src/main/index.ts:269` (registry shared), `:220` (WorkspaceManager deps).
- Gotcha (heightened scrutiny, spec §9): archive must `stopWorkspace` **before** `git worktree remove`
  (already ordered at `workspace/index.ts:232`) — now it actually kills the tree. before-quit must
  still call `app.quit()` in `finally` so a registry hang can't wedge shutdown.
- Validate: `bash ci/harness-gates.sh typecheck lint`

### Task 7 — Terminal + Run renderer feature (`src/renderer/features/terminal/`)
- What: `useTerminal(workspaceId)` — `subscribeStream('pty:open', {...}, onChunk, {signal})`, capture
  `ptyId` from the `started` frame, feed `data` frames to an xterm.js instance; `@xterm/addon-fit` on
  resize → `invoke('pty:resize',...)`; keystrokes → `invoke('pty:write',...)`; webgl + links addons;
  copy/paste. `terminalStore.ts` persists open tabs per workspace (client-side, no DB — §4). `RunPanel`
  + `useRun`: `invoke('run:list')` → buttons (icon+label); click → `run:start` stream (log tail +
  autoscroll, exit-code/duration badge) / `run:stop`. Big-Terminal toggle (maximize; expose the command,
  shortcut wiring is Phase 6). Open-in-IDE buttons → `invoke('ide:open',...)`.
- Pattern: `src/renderer/features/chat/useChat.ts` (stream+abort+leading-frame); mount in
  `AppLayout.tsx:43` (a tab beside `ChatPanel`, or the right pane).
- Gotcha: abort the stream on unmount/workspace-change/tab-close (no listener leak — mirror useChat);
  dispose xterm + addons on unmount. All IPC via `@renderer/ipc`, never `window.api` (README §10).
  xterm CSS import must work under electron-vite (import `@xterm/xterm/css/xterm.css`).
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/terminal/RunPanel.test.tsx`

### Task 8 — Docs
- What: update `src/main/pty/CLAUDE.md` (decision 1: scoped-stream transport, MessageChannelMain
  deferred) and `src/main/ipc/CLAUDE.md` (decision 2: reserved `pty:data`/`run:log` events unused).
- Validate: n/a (prose).

---

## Execution Strategy
*How `/harness-implement` should build this. Read verbatim.*
- **Task shape:** cross-cutting (main + renderer + 2 refactors), **heightened-scrutiny** (process/PTY
  exec + IPC boundary), medium-high complexity.
- **Pattern:** prompt-chaining + evaluator-optimizer, with mandatory verification.
- **Agents:** `coder` (main: Tasks 1–6 + 8) → `coder` (renderer: Task 7) → `test-author` (main tests,
  parallel with renderer coder once the contract from Task 1 lands) → `code-review` + `verifier`
  (both **mandatory** — heightened-scrutiny paths).
- **Orchestration:** prefer a **team** if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled (main-owner
  + renderer-owner + test-author as peers sharing the task list); else sequential/parallel subagents.
- **Parallel decomposition + file-ownership:**
  - Serialize the seam: **Task 1 (shared/ipc.ts) lands first** — everything else compiles against it.
  - Main-owner owns `src/main/{process,pty}/**`, `src/main/ipc/register.ts`, `src/main/index.ts`,
    `src/main/workspace/index.ts`.
  - Renderer-owner owns `src/renderer/features/terminal/**` + the `AppLayout.tsx` mount — starts after
    Task 1, runs parallel to main Tasks 4–6.
  - `test-author` owns `*.test.ts(x)` for main (Tasks 2/4/5) — parallel, no overlap with coder files.
  - `src/shared/ipc.ts`, `AppLayout.tsx`, the CLAUDE.md files are append/edit points — one owner each
    to avoid conflicts.
- **Rationale:** the process/PTY teardown path is the phase's top risk (zombie/orphan processes,
  spec §9) and touches two heightened-scrutiny surfaces, so verification is non-negotiable; the
  main/renderer split is a clean file-ownership boundary once the shared contract is frozen first.

---

## Validation Gate
Run after all tasks (from repo root):
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: tsc -b + eslint + vitest + electron-vite build)
```
Targeted suites while iterating:
```
node scripts/vitest-electron.mjs run src/main/process/registry.test.ts
node scripts/vitest-electron.mjs run src/main/process/runner.test.ts
node scripts/vitest-electron.mjs run src/main/pty/index.test.ts
node scripts/vitest-electron.mjs run src/renderer/features/terminal/RunPanel.test.tsx
```
> **Memory caveat:** repo-root git commands fail in this environment; tests use tmpdir repos/shells,
> not the repo root. Don't rely on `git diff` at the repo root to verify.

## Acceptance Criteria
- [ ] Open a terminal in a workspace → real shell in the worktree; typing + resize work; `PORT`/env present.
- [ ] Configure a run script → button appears; start tails logs live; stop terminates the **process tree**.
- [ ] `run_mode=concurrent` runs two scripts at once; `single` replaces; `running` overlay reflects state.
- [ ] Archiving a workspace with a live dev server stops it (SIGTERM→SIGKILL) **before** `worktree remove`
      (Phase-1 archive hook now routes through `ProcessRegistry`).
- [ ] Big-Terminal toggles; Open-in-IDE launches Cursor/VS Code at the worktree (arg-array spawn, no shell).
- [ ] App quit (`before-quit`) stops all run scripts + terminals (agents interrupted first by Phase 2).
- [ ] `src/shared/**` changes are append-only; renderer hardening intact; reserved events not removed.
- [ ] All Validation Gate blocking gates pass (run `/verify`).
```
