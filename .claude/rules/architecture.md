# Architecture Rules

`[GATE]` / `[REVIEW]` tagged, same convention as `security.md`.

## The process model (respect the boundary)

This is an Electron app (`harness`) built with electron-vite. Three trust zones:

| Zone | Location | Role |
|---|---|---|
| **Main** (full privilege) | `src/main/*` | git, PTY/process, db (better-sqlite3), filesystem, integrations, settings |
| **Preload** (bridge) | `src/preload/*` | the *only* place that wires main↔renderer, via a narrow `contextBridge` API |
| **Renderer** (sandboxed UI) | `src/renderer/*` | React UI: `app/`, `features/`, `components/`, `stores/`, `ipc/` client |
| **Shared** | `src/shared/*` | types + pure helpers imported by both sides (no Node-only or DOM-only deps) |

Main subsystems: `checkpoint`, `checks`, `db`, `diff`, `git`, `harness`, `integrations`,
`ipc`, `process`, `pty`, `settings`, `workspace`.

## Rules

- `[REVIEW]` Renderer code never imports from `src/main/*` and never touches Node built-ins
  (`fs`, `child_process`, `path`, …) directly — it goes through the preload IPC API. Main code
  never imports from `src/renderer/*`.
- `[REVIEW]` `src/shared/*` must be import-safe from **both** processes: no `electron`, no Node-
  only, no DOM-only imports. Put cross-boundary types here.
- `[REVIEW]` A new main→renderer capability is added as a **typed IPC channel**: handler in
  `src/main/ipc/*`, bridge method in `src/preload/*`, client wrapper in `src/renderer/ipc/*`,
  shared types in `src/shared/*`. Mirror the nearest existing channel rather than inventing a
  new shape.
- `[REVIEW]` Keep side-effecting work (git, fs, spawn, db) in `src/main/*`. Renderer stays
  presentational + state; long-running work is a main-process job surfaced over IPC.
- `[REVIEW]` DB access goes through the `src/main/db` layer, not ad-hoc better-sqlite3 handles
  scattered across subsystems.
