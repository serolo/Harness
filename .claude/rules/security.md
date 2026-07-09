# Security Rules

Tagged rules that guide AI + human review and (for `[GATE]`) compile to a check in
`ci/harness-gates.sh`. `[GATE]` = mechanically enforced, build fails. `[REVIEW]` = judgement
call by the AI reviewer + a human. Every line should trace to a concrete failure — see
`/harness-improve` and `docs/ai_harness/AI_Harness_Playbook.md` §"failure-to-rule ratchet".

## Heightened-scrutiny paths (this Electron app)

Changes touching any of these get an explicit, named security note in review and — per the
two-reviewer rule — a human reviewer:

- **IPC / preload boundary** (`src/preload/*`, `src/main/ipc/*`, `src/renderer/ipc/*`) — the
  trust boundary between the sandboxed renderer and full-privilege main process.
- **Process & terminal execution** (`src/main/process/*`, `src/main/pty/*`, any
  `child_process`/`node-pty`/shell) — arbitrary command execution surface.
- **Git & filesystem on user workspaces** (`src/main/git/*`, `src/main/workspace/*`,
  `src/main/diff/*`, `src/main/checkpoint/*`) — destructive ops + path traversal.
- **Database & migrations** (`src/main/db/*`, `scripts/migrate.ts`, better-sqlite3).
- **Secrets / tokens / settings** (`src/main/settings/*`, `src/main/integrations/*`).
- **Packaging & updates** (`electron-builder` config, any auto-update path).

## Rules

- `[REVIEW]` The renderer stays sandboxed: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox` on. Never expose raw `ipcRenderer`, `require`, or Node built-ins to renderer code —
  expose a **narrow, typed** API via `contextBridge` in `src/preload/*`. Traces to: Electron
  RCE via over-broad preload surface.
- `[REVIEW]` Every IPC handler in `src/main/ipc/*` **validates and narrows its inputs** before
  acting. Treat all channel payloads as untrusted; never interpolate them into shell strings.
- `[REVIEW]` Prefer `execFile`/`spawn` with an argument array over `exec`/shell strings when
  running external commands (git, PTY launch). No string-built shell commands from user or
  workspace-derived input — command injection.
- `[REVIEW]` Resolve and confine filesystem/git paths to the intended workspace root; reject
  `..` traversal and absolute paths that escape it before any read/write/delete.
- `[REVIEW]` No secrets/tokens in logs, error messages, committed fixtures, or the renderer.
  Keep credentials in the main process (`src/main/settings`/`integrations`) only.
- `[GATE]` No hard-coded secrets in source (enforced by the `secrets` gate once wired in
  `ci/harness-gates.sh`; until then this is `[REVIEW]`).
- `[REVIEW]` DB schema changes ship with a migration in `scripts/migrate.ts` and a
  back-compat/rollback note (SQLite is on the user's disk — no server-side redo).
