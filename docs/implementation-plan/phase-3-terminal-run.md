# Phase 3 — Terminal & Run Scripts (Electron)

> **Read [`README.md`](./README.md) first.**

**Spec refs:** §2.2 (process model), §5.2 (terminal & run scripts), §5.7 (`[scripts]`, `run_mode`), §8 (M3), §9 (archive with live servers).
**Estimated size:** ~1 week. **Depends on:** Phase 0, Phase 1. **Parallelizable with:** Phases 2, 4.
**Owns:** the shared **ProcessRegistry** (used by Phase 1 archive hook + Phase 2 agent processes).

---

## 1. Goal

Give each workspace real terminals (node-pty + xterm.js) and one-click **run scripts** (named commands
from settings rendered as buttons) with live log tailing, port injection, big-terminal mode, and
open-in-IDE. Consolidate all child-process management into a single `ProcessRegistry` so archive/quit
can reliably tear down process trees.

---

## 2. Scope

**In scope**
- `PtyService` (node-pty): spawn a shell PTY per terminal tab, bidirectional streaming, resize.
- Terminal UI: xterm.js tabs, fit/resize, webgl, paste, per-workspace persistence of open tabs.
- `ProcessRunner` + **`ProcessRegistry`**: named run scripts as start/stop processes, stdout/stderr
  tail to a Run panel, exit-code handling, `run_mode = concurrent|single`.
- Env injection: `PORT`/`APP_PORT` = workspace port, workspace path vars, `[env]` from settings.
- Big Terminal Mode (maximize toggle) and Open-in-IDE (`cursor <path>` / `code <path>`).
- Wire `ProcessRegistry` into Phase 1's archive hook and Phase 2's agent-process registration.

**Out of scope**
- Run-script *configuration UI* (Phase 6 settings UI) — scripts are read from settings here.

---

## 3. Task breakdown

### 3.1 ProcessRegistry (`src/main/process/registry.ts`) — shared
- Central registry of every child process the app spawns (agent turns, run scripts, setup scripts,
  terminals) keyed by `{ workspaceId, kind, id }`.
- `register(handle)`, `stop(id)`, `stopWorkspace(workspaceId)` performing **SIGTERM→(grace)→SIGKILL**
  on the whole process tree via **`tree-kill`** (or `detached` + `process.kill(-pgid)`) — spec §9.
  `shutdownAll()` on `before-quit`.
- Phase 1's archive hook and Phase 2's supervisor call into this instead of managing PIDs themselves.
  **Refactor the Phase-1 setup runner to route through here.**

### 3.2 PtyService (`src/main/pty/`)
```ts
class PtyService {
  open(workspaceId: string, cwd: string, env: Env, sink: StreamSink<PtyChunk>): Promise<PtyId>;
  write(pty: PtyId, data: string): Promise<void>;
  resize(pty: PtyId, cols: number, rows: number): Promise<void>;
  close(pty: PtyId): Promise<void>;
}
```
- `node-pty.spawn(shell, [], { cwd, env, cols, rows })` — the user's login shell in the worktree with
  injected env. `onData` → `PtyChunk` over the stream sink (prefer `MessageChannelMain` for
  throughput). Register in `ProcessRegistry`.

### 3.3 Run scripts (`src/main/process/runner.ts`)
- Read named scripts from `settings.scripts.run` (name, command, icon, label). `start(workspaceId,
  scriptName, sink: StreamSink<RunLogChunk>)` spawns (`execa`/`spawn`) with `cwd=worktree`, env (port +
  `[env]`), registers in `ProcessRegistry`, tails stdout/stderr → sink, tracks status. `stop(...)`.
- `run_mode`: `concurrent` allows multiple named scripts at once; `single` stops the previous.
- Emit a `running` status **overlay** via `WorkspaceManager.setStatus` semantics (README §6.4) while
  any run script is active; clear when all stop.

### 3.4 Env injection
- Central `buildEnv(workspace)` → `{ PORT, APP_PORT, WORKSPACE_PATH, WORKSPACE_NAME, ...settings.env }`.
  Used by PTYs, run scripts, setup scripts, and agent spawns (share with Phase 2 to avoid drift).

### 3.5 Terminal UI (`src/renderer/features/terminal/`)
- xterm.js instance per tab bound to a PTY stream; `@xterm/addon-fit` on container resize → `resize`.
  Tabs: add/close/rename; persist open tabs per workspace (client-side store). Copy/paste, links addon,
  webgl addon.
- **Big Terminal Mode:** maximize terminal to full window with a toggle + shortcut (shortcut
  registration lands in Phase 6; expose the command now).
- **Run panel:** buttons from settings (icon+label); click → start/stop; live log tail with autoscroll;
  exit-code + duration badges.
- **Open-in-IDE** buttons: spawn `cursor <worktree>` / `code <worktree>` detached from main.

---

## 4. Data model owned by this phase
- None. Terminal tab layout is client-side state (no migration). **Decision:** no DB.

## 5. IPC surface added
- Commands: `pty:open(workspaceId)` (streamed), `pty:write`, `pty:resize`, `pty:close`,
  `run:start(workspaceId, script)` (streamed), `run:stop(workspaceId, script)`, `run:list(workspaceId)`,
  `ide:open(workspaceId, ide)`.
- Streams: `PtyChunk`, `RunLogChunk`.
- Events: `run:log` status transitions; `workspace:status` `running` overlay on/off.

## 6. Definition of Done
- [ ] Open a terminal in a workspace → real shell in the worktree, typing/resize work, port env present.
- [ ] Configure a run script → button appears; start tails logs live; stop terminates the process tree.
- [ ] `run_mode=concurrent` runs two scripts at once; `single` replaces; `running` overlay reflects state.
- [ ] Archiving a workspace with a live dev server stops it (SIGTERM→SIGKILL) before `worktree remove`
      (verifies the Phase-1 archive hook now routes through `ProcessRegistry`).
- [ ] Big Terminal Mode toggles; Open-in-IDE launches Cursor/VS Code at the worktree.
- [ ] App quit (`before-quit`) stops all run scripts + terminals (agents interrupted by Phase 2).
- [ ] `npm run check` green.

## 7. Tests
- PtyService: open→write→read echo round-trip on a temp shell; resize; close deregisters.
- ProcessRegistry: `stopWorkspace` kills a spawned sleeper process tree; escalation SIGTERM→SIGKILL.
- Runner: concurrent vs single mode; exit-code surfaced; overlay status set/cleared.
- Renderer: terminal renders PTY chunks; run button start/stop; log autoscroll.

## 8. Risks / notes
- **Zombie/orphan processes** are the top risk — `ProcessRegistry` is the single reliable teardown
  path. Test the archive-with-live-server case explicitly (spec §9). Use `tree-kill` on macOS.
- **node-pty native build** must match the Electron ABI (`@electron/rebuild`, README §10).
- **PTY throughput** — webgl addon + `MessageChannelMain` streaming for high-volume output.
- Sharing `buildEnv` with Phase 2's agent spawn avoids env drift between terminal and agent.
