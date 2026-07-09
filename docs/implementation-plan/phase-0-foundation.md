# Phase 0 — Foundation & Scaffolding (Electron)

> **Read [`README.md`](./README.md) first.** This phase establishes the shared contracts everything
> else builds on. Nothing in Phases 1–7 can start until Phase 0's stubs type-check and the IPC bridge
> works end-to-end.

**Spec refs:** §2 (architecture), §2.3 (filesystem), §3 (data model), §4.1 (harness contract), §7 (security), §8 (M-pre).
**Estimated size:** ~1 week. **Depends on:** nothing. **Blocks:** all phases.

---

## 1. Goal

Stand up the Electron + electron-vite app skeleton with: a TypeScript **main process** exposing an
`AppContext` with **stubbed service classes** for every subsystem (README §3), a typed IPC bridge
(`ipcMain.handle` + `contextBridge` preload + a stream helper) whose contract lives in
`src/shared/ipc.ts`, a migrated SQLite database (core tables) via better-sqlite3 + Kysely, a read-only
layered settings service, `electron-log` logging, an `AppError` model, hardened `BrowserWindow`
security, and a minimal but real app shell (window, sidebar placeholder, main pane). After Phase 0, an
agent can pick up any later phase and build against stable seams.

---

## 2. Scope

**In scope**
- Electron + electron-vite project init; `main`/`preload`/`renderer` targets; TS project refs; scripts;
  CI; electron-builder config (unsigned dev build ok).
- `AppContext` with service-class **stubs** for **all** subsystems named in README §3.
- IPC framework: `src/shared/ipc.ts` (command + event + stream-channel maps), `ipcMain.handle`
  registration pattern, preload `contextBridge` exposing typed `window.api` (`invoke`/`on`/`stream`),
  the `createStream()` helper (scoped channel + `MessageChannelMain` path).
- DB: better-sqlite3 open at `paths.dbPath()`, Kysely typed `Database` interface, a numbered-migration
  runner (`user_version`), migration `0001_core` creating `projects`, `workspaces`. Repos for these.
- `AppError` shape (`src/shared/errors.ts`) + throw/reject/rethrow convention.
- `paths.ts` (single source for all on-disk locations via `app.getPath`, spec §2.3).
- Read-only `SettingsService` with layered merge + zod-typed `EffectiveSettings` (defaults real; file
  layers wired but may be empty).
- `electron-log` to `logs/`.
- Hardened window (`contextIsolation`, `nodeIntegration:false`, `sandbox`, CSP); deep-link scheme
  registration (`setAsDefaultProtocolClient`); native-module rebuild wired.
- App shell: three-pane layout, empty sidebar, theme, Zustand + TanStack Query providers, an IPC
  health-check (`app:ping`).

**Out of scope** (stubbed only)
- Real git/workspace/harness/pty/diff/checks/integration logic — bodies `throw new Error('not
  implemented')`.
- Settings write path, validation, hot-reload (Phase 6).

---

## 3. Task breakdown

### 3.1 Project init & tooling
1. Scaffold with `electron-vite` (React + TS template) into the repo root, matching README §3. Set
   `electron-builder` `appId` + product name (resolve the branding open question — pick a working
   name and record it). Configure macOS target (`dmg`, `zip`), category, entitlements placeholder.
2. Deps (main): `better-sqlite3`, `kysely`, `execa`/`simple-git`, `node-pty`, `chokidar`, `tree-kill`,
   `@octokit/rest`, `@octokit/graphql`, `smol-toml`, `zod`, `electron-log`, `uuid`. Feature-gate
   later-phase deps if desired but prefer present so stubs type-check.
3. Deps (renderer): `react`, `zustand`, `@tanstack/react-query`, `@xterm/xterm` (+addons),
   `monaco-editor`/`@monaco-editor/react`, `shiki`, `tailwindcss`, Radix.
4. Deps (dev/test): `typescript`, `eslint` + config, `vitest`, `@testing-library/react`, `playwright`,
   `@electron/rebuild`, `electron-builder`.
5. `package.json` scripts (README §8). TS project refs: `tsconfig.{main,preload,renderer,shared}.json`
   + root `tsconfig.json` with `references`. Strict mode on.
6. **Native modules:** wire `@electron/rebuild` (postinstall or a `rebuild` script) so `better-sqlite3`
   + `node-pty` build for the Electron ABI. Document in README §10 (already noted).
7. `.github/workflows/ci.yml` on macOS runner: install → `@electron/rebuild` → `npm run check`.
8. `eslintrc`, `prettier`, strict `tsconfig`.

### 3.2 Paths & app data
- `src/main/paths.ts`: resolve `userData = app.getPath('userData')`, `dbPath()`, `logsDir()`,
  `settingsPath()`, `secretsDir()`, `projectDir(id)`, `repoDir(id)`, `worktreesDir(id)`,
  `worktreeDir(id, name)`. Create dirs on first run. **Only module allowed to hardcode these paths.**

### 3.3 Error model
- `src/shared/errors.ts`: `AppErrorCode` union + `AppError` class (`{ code, message, details? }`,
  serializable). `src/main/error.ts`: helpers to wrap `unknown`/native errors → `AppError`; an IPC
  boundary wrapper that catches and rejects with the serialized shape. Renderer `src/renderer/ipc`
  rethrows a typed `AppError`.

### 3.4 Database
- `src/main/db/index.ts`: open better-sqlite3 at `paths.dbPath()` (WAL mode), construct Kysely with the
  `SqliteDialect`, run migrations on startup.
- `src/main/db/migrations/0001_core.ts` (or `.sql`): `projects`, `workspaces` (full column set per spec
  §3, incl. `port`, `source_kind`, `source_ref`, `harness`, `status`, `archived_at`). Indexes:
  `workspaces(project_id)`, unique `workspaces(project_id, name)`.
- **Migration runner:** track applied version via `PRAGMA user_version` (or a `_migrations` table);
  apply pending migrations in order inside a transaction. Keep it tiny and explicit.
- `src/main/db/repos/projects.ts`, `.../workspaces.ts`: typed CRUD (Kysely) used by Phase 1. Table
  types declared in the Kysely `Database` interface; DTOs re-exported to `src/shared/models.ts`.

### 3.5 Service stubs & AppContext
- Create every module dir from README §3 with an `index.ts` exposing the service **class** + method
  signatures throwing `not implemented`. Required stubs: `GitService`, `WorkspaceManager`,
  `HarnessSupervisor` (+ the `Harness` interface, `AgentEvent`, `StartTurnOpts`, `Attachment`
  **fully defined** in `src/shared/harness.ts`, no bodies), `PtyService`, `ProcessRunner` +
  `ProcessRegistry`, `DiffService`, `CheckpointService`, `ChecksService`, `IntegrationService`,
  `SettingsService`.
- `src/main/context.ts`: `AppContext` holding `{ db, settings, git, workspaces, harness, pty, process,
  diff, checkpoint, checks, integrations }`, constructed in `src/main/index.ts` and passed to IPC
  registration.
- **Freeze the `Harness` interface + `AgentEvent` union** exactly as README §6.3 — the single most
  important artifact of Phase 0.

### 3.6 IPC framework
- `src/shared/ipc.ts`: the typed **command map** (`{ 'app:ping': (req) => res, ... }`), **event map**
  (`{ 'workspace:status': payload, ... }` from README §6.2), and **stream-channel names**. Later
  phases append to these maps.
- `src/main/ipc/register.ts`: register `app:ping` (`() => 'ok'`) and `app:info`; establish the
  `handle(channel, fn)` helper wrapping errors (§3.3). Implement `createStream()` (scoped channel via
  `webContents.send('stream:<id>', chunk)` + an `end` marker; plus the `MessageChannelMain` variant
  for high-throughput). Ship a demo `app:echoStream` proving the streaming pattern end-to-end.
- `src/main/ipc/events.ts`: typed `emit(event, payload)` helpers for the frozen broadcast events.
- `src/preload/index.ts`: `contextBridge.exposeInMainWorld('api', { invoke, on, stream })`, typed from
  `src/shared/ipc.ts`. **No `ipcRenderer` or Node globals exposed.**
- `src/renderer/ipc/index.ts`: thin typed wrappers (`invoke`, `onEvent`, `subscribeStream`) over
  `window.api`. **All Electron access funnels here.**

### 3.7 Settings (read-only skeleton)
- `src/main/settings/index.ts`: `EffectiveSettings` as a **zod** schema (sections from spec §5.7:
  `scripts`, `env`, `agent`, `git`, `mcp`) with sensible defaults. `SettingsService.load()` merges
  layers defaults → user → project-shared → project-local (files parsed with `smol-toml`; absent →
  skip). `get()` returns a cloned snapshot. **No** validation surfacing / hot-reload yet (Phase 6);
  expose the zod schema for Phase 6 (and `zod-to-json-schema` if a published schema is wanted).

### 3.8 Logging
- `src/main/logging.ts`: init `electron-log` (file transport in `logs/`, console in dev). Init first in
  `src/main/index.ts`; route `AppError`s and uncaught exceptions.

### 3.9 App shell (renderer)
- `src/renderer/app/`: providers (QueryClient, theme), a 3-pane `AppLayout` (left sidebar rail, center
  content, right context panel), all placeholders.
- `src/renderer/features/sidebar/`: empty project/workspace list from a Zustand store (seeded empty).
- Visible **"IPC OK"** indicator calling `app:ping` on mount — proves the round trip through preload.
- **Hardened `BrowserWindow`** in `src/main/index.ts`: `contextIsolation:true`, `nodeIntegration:false`,
  `sandbox:true`, `webSecurity`, strict CSP. Register `harness://` via `setAsDefaultProtocolClient`;
  `open-url`/`second-instance` handler logs the URL (nav stub).

---

## 4. Data model owned by this phase
- Migration `0001_core`: `projects`, `workspaces` (+ indexes). Migration bookkeeping via `user_version`
  / `_migrations`.

## 5. IPC surface added
- Commands: `app:ping`, `app:info`, `app:echoStream` (streaming pattern demo).
- Events: payload types registered for `workspace:status`, `workspace:created`, `workspace:archived`
  (emitted later).
- Contract: `src/shared/ipc.ts` command/event/stream maps in place.

## 6. Definition of Done
- [ ] `npm run dev` launches the app; window shows the 3-pane shell and a green "IPC OK" from `app:ping`.
- [ ] `npm run check` fully green (`tsc -b`, eslint, vitest, `electron-vite build`).
- [ ] Renderer is hardened: no Node globals / `ipcRenderer` reachable from the page; only `window.api`.
- [ ] Fresh-DB migration creates core tables; a round-trip test inserts+reads a `Project` and a `Workspace`.
- [ ] `AppContext` exposes a stub for **every** subsystem in README §3; project type-checks with all registered.
- [ ] `Harness` interface + `AgentEvent` union present verbatim per README §6.3 in `src/shared/harness.ts`.
- [ ] `paths`, `AppError`, `SettingsService.get()`, `electron-log` to `logs/` all functional.
- [ ] `app:echoStream` demonstrates the streaming helper (proves the `Channel<T>` analogue).
- [ ] `@electron/rebuild` builds `better-sqlite3` + `node-pty` for the Electron ABI in CI.

## 7. Tests
- Main (Vitest): migration + `projects`/`workspaces` CRUD round-trip; settings layered-merge with 0/1/2
  file layers; `AppError` serialization shape.
- Renderer: renders `AppLayout`; `app:ping` (mocked `window.api`) flips the indicator.
- E2E (Playwright `_electron`, optional this phase): app boots, window visible.

## 8. Risks / notes
- **Native modules (better-sqlite3, node-pty)** are the top setup risk — get `@electron/rebuild`
  working in CI on day one; a wrong ABI fails at runtime, not build.
- **Renderer security** must be right from the start (contextIsolation/sandbox/CSP) — retrofitting is
  painful. Preload exposes only the typed `window.api`.
- **Streaming helper design** (`createStream` / `MessageChannelMain`) is load-bearing for Phases 2/3 —
  prove it here with `app:echoStream`, including backpressure behavior.
- **Branding/appId** must be finalized here (deep-link scheme + safeStorage service name derive from it).
- **better-sqlite3 is synchronous** — fine at this scale; document the `utilityProcess` escape hatch
  (README §7.3) but don't build it now.
