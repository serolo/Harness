# Harness

Harness is a macOS desktop app for running multiple coding agents against one repository. It manages
git workspaces, agent conversations, terminals, diffs, checkpoints, checks, and integration workflows
from a single Electron application.

The implementation is TypeScript end to end:

- Electron main process for the core services
- React renderer built with Vite
- `contextBridge` preload API for all renderer-to-main communication
- SQLite via `better-sqlite3` and Kysely
- `node-pty` and xterm.js for terminal sessions
- system `git` plus typed wrappers for repository operations

## Requirements

- macOS
- Node.js 22 or newer
- npm
- system `git`

Native Electron modules are rebuilt after install through the `postinstall` script.

## Getting Started

```sh
npm install
npm run dev
```

If native bindings need to be rebuilt manually:

```sh
npm run rebuild
```

## Scripts

```sh
npm run dev       # Start the Electron/Vite development app
npm run build     # Build main, preload, and renderer targets
npm run package   # Create macOS dmg/zip packages with electron-builder
npm run test      # Run Vitest through the Electron test harness
npm run test:e2e  # Run Playwright Electron tests
npm run check     # Type-check, lint, test, and build
npm run migrate   # Run local database migrations
```

The full repository gate is also available as:

```sh
bash ci/harness-gates.sh
```

## Project Layout

```text
src/main/      Electron main process, core services, IPC handlers, database, git, harnesses
src/preload/   Hardened contextBridge API exposed to the renderer
src/shared/    Types shared by main, preload, and renderer
src/renderer/  React application, feature views, stores, and IPC clients
docs/          Product spec, implementation plan, and developer workflow docs
e2e/           Playwright Electron tests
scripts/       Migration and test runner utilities
```

## Development Notes

- Use npm; `package-lock.json` is authoritative.
- Keep renderer access to the main process behind `window.api` from `src/preload/index.ts`.
- Treat `src/shared/**` as the typed contract between processes. Extend contracts additively.
- Add SQLite schema changes through numbered migrations.
- Run focused tests for the area you change, then `npm run check` before merging.

See [CLAUDE.md](CLAUDE.md) for the repo-wide engineering agreement and
[docs/implementation-plan/README.md](docs/implementation-plan/README.md) for the detailed system
plan.
