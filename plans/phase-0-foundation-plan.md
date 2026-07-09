# Plan: Phase 0 — Foundation & Scaffolding (Electron)

## Ticket
Phase 0 of the Parallel Coding Agents app (`docs/implementation-plan/phase-0-foundation.md`). Stand
up the Electron + electron-vite skeleton with frozen shared contracts, a migrated SQLite DB, a typed
IPC bridge, read-only layered settings, logging, a hardened window, and a minimal app shell — so any
later phase (1–7) can build against stable seams. **No feature logic; all subsystem bodies are stubs.**

## Context: this is a greenfield repo
The repo currently contains **only docs** (`docs/parallel-agents-spec.md`, `docs/implementation-plan/*`)
and `.claude/`. There is **no `package.json`, no `src/`, no build**. Therefore:
- Every file below is a **Create**. The "Pattern" for each task is the **spec/README section that
  defines the exact shape** to build (there is no existing code to mirror yet).
- The authoritative sources are, in priority order: `docs/implementation-plan/README.md` (the binding
  stack + shared-contract decisions) → `docs/parallel-agents-spec.md` (the product/data-model source of
  truth) → `docs/implementation-plan/phase-0-foundation.md` (this phase's task list).
- Where README and spec disagree, **README wins for anything crossing the process boundary** (it is the
  frozen-contract document — see the Harness reconciliation gotcha in Task 2).

## Affected Files
### Read before implementing (context — do not modify)
- `docs/implementation-plan/README.md` (whole file) — the binding stack + shared contracts. **Especially
  §3 repo layout (L71–132), §6.2 IPC contract (L229–261), §6.3 Harness interface (L263–306), §6.5
  settings (L319–325), §7.6 security (L359–366), §8 scripts (L379–392).**
- `docs/parallel-agents-spec.md` — §2.3 filesystem (L86–104), §3 data model DDL (L107–187), §4.1
  harness (L195–227), §5.7 settings (L300–310), §7 security (L328–334).
- `docs/implementation-plan/phase-0-foundation.md` — the per-task detail this plan operationalizes.

### Create (grouped by owning task — see Execution Strategy for the ownership map)
- **Task 1 (tooling):** `package.json`, `electron.vite.config.ts`, `electron-builder.yml`,
  `tsconfig.json` + `tsconfig.{main,preload,renderer,shared}.json`, `.eslintrc.cjs`, `.prettierrc`,
  `.gitignore`, `.github/workflows/ci.yml`, `ci/harness-gates.sh`.
- **Task 2 (shared contracts):** `src/shared/errors.ts`, `src/shared/harness.ts`,
  `src/shared/models.ts`, `src/shared/ipc.ts`.
- **Task 3 (main utils):** `src/main/paths.ts`, `src/main/logging.ts`, `src/main/error.ts`.
- **Task 4 (db):** `src/main/db/index.ts`, `src/main/db/schema.ts`, `src/main/db/migrations/index.ts`,
  `src/main/db/migrations/0001_core.ts`, `src/main/db/repos/projects.ts`,
  `src/main/db/repos/workspaces.ts`.
- **Task 5 (stubs + AppContext type):** `src/main/{git,workspace,harness,pty,process,diff,checkpoint,checks,integrations}/index.ts`,
  `src/main/context.ts`.
- **Task 6 (ipc framework):** `src/main/ipc/register.ts`, `src/main/ipc/events.ts`,
  `src/main/ipc/stream.ts`, `src/preload/index.ts`, `src/preload/api.d.ts`, `src/renderer/ipc/index.ts`.
- **Task 7 (settings):** `src/main/settings/index.ts`, `src/main/settings/schema.ts`.
- **Task 8 (app shell):** `src/renderer/main.tsx`, `src/renderer/index.html`,
  `src/renderer/app/{App.tsx,AppLayout.tsx,providers.tsx,theme.ts}`,
  `src/renderer/stores/workspaces.ts`, `src/renderer/features/sidebar/Sidebar.tsx`,
  `src/renderer/components/` (as needed), Tailwind config + entry CSS.
- **Task 9 (convergence):** `src/main/index.ts` (app lifecycle + hardened `BrowserWindow` + wiring).
- **Task 10 (tests):** `src/main/db/*.test.ts`, `src/main/settings/*.test.ts`,
  `src/shared/errors.test.ts`, `src/renderer/app/AppLayout.test.tsx`, `e2e/boot.spec.ts` (optional).

---

## Ordered Tasks

### Task 1 — Scaffold electron-vite app, tooling, native-module rebuild, CI
- **What:** Initialize the electron-vite React+TS project at repo root matching README §3 layout.
  - `package.json` scripts **verbatim per README §8 (L379–392):** `dev`, `build`, `package`, `check`
    (`tsc -b && eslint && vitest run && electron-vite build`), `test`, `test:e2e`, `migrate`.
  - Install deps per phase doc §3.1: **main** — `better-sqlite3`, `kysely`, `execa` + `simple-git`,
    `node-pty`, `chokidar`, `tree-kill`, `@octokit/rest`, `@octokit/graphql`, `smol-toml`, `zod`,
    `electron-log`, `uuid`; **renderer** — `react`, `react-dom`, `zustand`, `@tanstack/react-query`,
    `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl`, `monaco-editor` +
    `@monaco-editor/react`, `shiki`, `tailwindcss`, Radix primitives; **dev/test** — `typescript`,
    `eslint` + config, `prettier`, `vitest`, `@testing-library/react`, `@testing-library/jest-dom`,
    `playwright`, `@electron/rebuild`, `electron-builder`, `electron`, `electron-vite`, `@types/*`.
    Prefer installing later-phase deps **now** so stubs type-check (phase doc §3.1.2).
  - `electron.vite.config.ts`: three targets (`main`, `preload`, `renderer`) with React plugin + HMR.
  - TS project references: root `tsconfig.json` with `references` to
    `tsconfig.{main,preload,renderer,shared}.json`; **`strict: true`** everywhere; `shared` is a
    referenced project so main+renderer share one contract.
  - `electron-builder.yml`: set `appId`, `productName`, macOS `dmg` + `zip` targets, category,
    entitlements placeholder. **Resolve the branding open question (README §11):** use working name
    **`harness`** (product name "Harness", `appId: com.serolo.harness`) — chosen because the spec
    already hardcodes the `harness://` deep-link scheme (§5.8) and the safeStorage service name derives
    from it. Record it in a top-of-file comment; flag as provisional (see Open Decisions).
  - `.eslintrc.cjs` + `.prettierrc`: strict, TS-aware; `.gitignore` (node_modules, out, dist, `*.db`,
    `.context`, secrets).
  - **Native rebuild (top risk — phase doc §8):** wire `@electron/rebuild` as a `rebuild` script and a
    `postinstall` hook so `better-sqlite3` + `node-pty` build for the **Electron ABI** (a wrong ABI
    fails at runtime, not build).
  - `.github/workflows/ci.yml`: macOS runner → `npm ci` → `npx @electron/rebuild` → `npm run check`.
  - **`ci/harness-gates.sh` (addition beyond the phase doc — bridges the PIV toolchain):** a small shell
    wrapper the downstream `/harness-implement` Stop hook and `/verify` invoke. `format`→`prettier -c`,
    `lint`→`eslint`, `typecheck`→`tsc -b`; no-arg → full `npm run check`. Without this the handoff to
    `/harness-implement` calls a script that doesn't exist in this repo.
- **Pattern:** README §3 (L71–132) for the tree, §8 (L379–392) for scripts, phase doc §3.1 for deps.
- **Gotcha:** `better-sqlite3` and `node-pty` are **native modules** — the app will build but crash at
  runtime if not rebuilt for Electron's ABI. Get `@electron/rebuild` green on day one, in CI too.
  `sandbox: true` (Task 9) can interfere with some native preload requires — validate the DB opens
  under the real Electron runtime, not just under `vitest`/node.
- **Validate:** `npm install && npm run rebuild && npx electron-vite build` (builds all three targets);
  `bash ci/harness-gates.sh typecheck` runs clean on the empty scaffold.

### Task 2 — Freeze the shared contracts (`src/shared/`) — the load-bearing task
- **What:** Author the four contract files that main + renderer both import. These are **append-only**
  for all later phases (README §5.2) — get the shapes right.
  - `src/shared/errors.ts`: `AppErrorCode` union **exactly** per README §7.2 (L336–341):
    `io | db | git | harness | integration | settings | not_found | conflict | invalid_input |
    internal`. `AppError` class `{ code: AppErrorCode; message: string; details?: unknown }`, **JSON-
    serializable** (a `toJSON()`/plain-object form that survives the IPC boundary — Electron structured-
    clones the rejection, so `Error` subclass fields must be enumerable or explicitly serialized).
  - `src/shared/harness.ts`: **copy README §6.3 (L263–306) VERBATIM** — `HarnessId`, `Harness`,
    `StartTurnOpts`, `TurnHandle`, `AgentEvent` union, `Attachment` union. Then define the supporting
    types §6.3 references but doesn't fully spell out, and **freeze them too**: `HarnessCapabilities`
    `{ supportsResume; supportsMcp; supportsPlanMode; rawTerminalFallback: boolean }`, `DetectResult`
    `{ installed: boolean; version?: string; authenticated: boolean }`, `AgentMode =
    "plan" | "default" | "auto_accept"`, `McpServerConfig` (minimal: `{ name: string; command: string;
    args?: string[]; env?: Record<string,string> }`), `PermissionPolicy` (minimal:
    `{ allowedTools?: string[]; allow?: string[]; deny?: string[]; confirmBeforeRun?: boolean }`),
    `Todo` `{ id: string; body: string; done: boolean; source: "user" | "agent" }` (matches spec §3
    `todos` table + `todo_update` event), `Usage` `{ inputTokens?: number; outputTokens?: number }`.
    `StreamSink<T>` is defined in `ipc.ts` (below) and imported here.
  - `src/shared/models.ts`: `Project` and `Workspace` DTO types matching spec §3 columns (L110–133).
    IDs are **UUIDv7 strings**; timestamps are **`number` epoch-millis** (README §6.1 L226–228). Use
    string-literal unions for enum-ish columns (`Workspace.status`, `source_kind`, `harness`). These are
    the DTOs the DB repos (Task 4) return.
  - `src/shared/ipc.ts`: the three typed maps + the streaming primitive.
    - `Commands` map (request→response): seed with `'app:ping': () => 'ok'`, `'app:info': () =>
      AppInfo`, `'app:echoStream': (req: { text: string }) => void` (stream demo). Model it so later
      phases **append** entries (e.g. `interface Commands { 'app:ping': { req: void; res: 'ok' }; ... }`).
    - `Events` map (broadcast payloads) — **frozen names per README §6.2 (L250–261):**
      `workspace:status { workspaceId; status }`, `workspace:created { workspace: Workspace }`,
      `workspace:archived { workspaceId }`. Reserve (typed but emitted later) `turn:event`, `pty:data`,
      `run:log`, `diff:changed`, `checks:updated`, `settings:changed`, `notify:needsAttention`.
    - `StreamChannels`: names/payloads for scoped streams (seed with `app:echoStream`).
    - `StreamSink<T>` `{ push(chunk: T): void; end(): void; error(e: AppError): void }` — the main-side
      push handle produced by `createStream()` (README §6.2 L240–243; consumed by `Harness.startTurn`).
- **Pattern:** README §6.1–6.3 (L210–306), §7.2 (L336–341); spec §3 (L110–133), §4.1 (L219–226).
- **Gotcha (CRITICAL — Harness reconciliation):** README §6.3 and spec §4.1 **disagree**. Spec §4.1 is
  pull-based (`TurnHandle { events: AsyncIterable<AgentEvent> }`, `startTurn(...): TurnHandle`, no
  `capabilities()`, `mcpConfig?` optional). README §6.3 is push-based (`startTurn(opts, sink:
  StreamSink<AgentEvent>): Promise<TurnHandle>`, adds `capabilities()` + `DetectResult`, `mcpConfig`
  **required**, `TurnHandle { sessionId; interrupt() }` with **no `events`**). **Freeze README §6.3** —
  the phase doc §3.5 says "exactly as README §6.3", and README is the binding contract doc. Do **not**
  merge the two shapes. Leave a `// FROZEN: README §6.3 — supersedes spec §4.1 (push-based sink)`
  comment so Phase 2 doesn't re-litigate it.
- **Gotcha:** `AppError` must round-trip through `ipcRenderer.invoke` rejection (structured clone). Test
  the serialized shape (Task 10). Don't rely on `instanceof` across the boundary.
- **Validate:** `npx tsc -p tsconfig.shared.json --noEmit` clean; `git grep -n "kind:" src/shared/harness.ts`
  shows all 7 `AgentEvent` variants (`text, tool_use, tool_result, file_edit, todo_update, turn_end,
  error`).

### Task 3 — Main-process foundation utilities: paths, logging, error boundary
- **What:**
  - `src/main/paths.ts`: resolve `userData = app.getPath('userData')` and expose `dbPath()`,
    `logsDir()`, `settingsPath()`, `secretsDir()`, `projectDir(id)`, `repoDir(id)`,
    `worktreesDir(id)`, `worktreeDir(id, name)` per spec §2.3 (L86–104). **Create dirs on first run**
    (`fs.mkdirSync(..., { recursive: true })`). **This is the only module allowed to hardcode on-disk
    locations** (phase doc §3.2).
  - `src/main/logging.ts`: init `electron-log` — file transport into `paths.logsDir()`, console in dev;
    export the logger; helper to route `AppError`s + `process.on('uncaughtException'/'unhandledRejection')`
    (phase doc §3.8). Must be init-able **before** anything else in `index.ts`.
  - `src/main/error.ts`: helpers `toAppError(unknown): AppError` (wrap native/unknown → typed
    `AppError`), and re-export the `AppError` shape from `src/shared/errors.ts`. The IPC boundary
    wrapper that catches + rejects with the serialized shape lives in `ipc/register.ts` (Task 6) but
    uses `toAppError` from here.
- **Pattern:** spec §2.3 (L86–104) for path layout; README §7.5 (L355–357) for logging; §7.2 for errors.
- **Gotcha:** `app.getPath('userData')` is only valid **after** the Electron `app` `ready`-ish; `paths.ts`
  must be lazy (functions, not module-level constants evaluated at import) or only called after app init.
  Don't create dirs at import time.
- **Validate:** `npx tsc -p tsconfig.main.json --noEmit` clean (with Tasks 2 present).

### Task 4 — Database: better-sqlite3 + Kysely + migration runner + `0001_core` + repos
- **What:**
  - `src/main/db/index.ts`: open `better-sqlite3` at `paths.dbPath()` in **WAL mode**
    (`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON`); construct Kysely with `SqliteDialect`; run
    migrations on startup; export the typed `Kysely<Database>` handle.
  - `src/main/db/schema.ts`: the Kysely `Database` interface (table types for `projects`, `workspaces`).
    Re-derive/align with `src/shared/models.ts` DTOs (Task 2) — DB row types may differ from DTOs
    (e.g. `INTEGER` booleans) so keep the mapping explicit in the repos.
  - `src/main/db/migrations/0001_core.ts`: create `projects` and `workspaces` with the **full column
    set per spec §3 (L110–133)** — incl. `workspaces.port`, `source_kind`, `source_ref`, `harness`,
    `status`, `archived_at`. Indexes: `workspaces(project_id)` and **unique** `workspaces(project_id,
    name)` (phase doc §3.4).
  - `src/main/db/migrations/index.ts`: the **migration runner** — track applied version via
    `PRAGMA user_version`; apply pending migrations **in order inside a transaction**; keep it tiny and
    explicit (phase doc §3.4). Numbered array of `{ version, up(db) }`.
  - `src/main/db/repos/projects.ts`, `repos/workspaces.ts`: typed CRUD via Kysely, returning
    `src/shared/models.ts` DTOs. Generate IDs with **UUIDv7** (`uuid` v7); timestamps `Date.now()`.
- **Pattern:** spec §3 DDL (L107–187); README §2 DB row (L46), §6.1 (L210–228), §7.3 concurrency (L344–348).
- **Gotcha:** `better-sqlite3` is **synchronous** (README §7.3) — fine at this scale; keep queries small
  and never loop huge sets on the main thread. Document the `utilityProcess` escape hatch in a comment,
  don't build it. Migration runner must be **idempotent** on a fresh DB and re-runnable (no double-apply)
  — this is exactly what the round-trip test asserts.
- **Validate:** `npx vitest run src/main/db` — the migration + `projects`/`workspaces` CRUD round-trip
  test (Task 10) passes against a temp DB.

### Task 5 — Subsystem service stubs + `AppContext`
- **What:** Create every module dir from README §3 with an `index.ts` exposing the service **class** with
  its public method signatures and bodies that `throw new Error('not implemented')` (phase doc §3.5).
  Required stubs: `GitService` (`src/main/git/`), `WorkspaceManager` (`src/main/workspace/`),
  `HarnessSupervisor` (`src/main/harness/supervisor.ts` — owns live agent processes keyed by
  `workspaceId`, at most one active turn/ws; imports the frozen `Harness`/`AgentEvent` from
  `src/shared/harness.ts`), `PtyService` (`src/main/pty/`), `ProcessRunner` + `ProcessRegistry`
  (`src/main/process/`), `DiffService` (`src/main/diff/`), `CheckpointService` (`src/main/checkpoint/`),
  `ChecksService` (`src/main/checks/`), `IntegrationService` (`src/main/integrations/`). (`SettingsService`
  is the one stub that gets a **real** read-only body — see Task 7.)
  - `src/main/context.ts`: `AppContext` type/interface holding `{ db, settings, git, workspaces,
    harness, pty, process, diff, checkpoint, checks, integrations }`. Define the type here; **concrete
    construction happens in `src/main/index.ts` (Task 9)** and is passed to IPC registration. Import the
    `Kysely<Database>` type (Task 4) and `SettingsService` type (Task 7) type-only.
- **Pattern:** README §3 module dirs (L96–110), §6.3 for the `Harness` types the supervisor references,
  §6.4 status machine ownership note (L308–311) for `WorkspaceManager`.
- **Gotcha:** Give each stub method a **real, thought-through signature** (params + return type) even
  though the body throws — later-phase agents build against these signatures, and a wrong signature is a
  contract break. Prefer the signatures already implied by the spec (e.g. `WorkspaceManager.setStatus()`
  from §6.4, `createStream`-fed `startTurn` from §6.3). Keep imports type-only where possible to avoid
  pulling native modules into the type graph.
- **Validate:** `npx tsc -p tsconfig.main.json --noEmit` clean; `AppContext` names all 11 fields.

### Task 6 — IPC framework: register + events + stream helper + preload + renderer bridge
- **What:**
  - `src/main/ipc/stream.ts`: `createStream()` — the scoped-channel helper. Renderer calls
    `api.stream(channel, args, onChunk)`; main allocates a subscription id and pushes via
    `webContents.send('stream:<id>', chunk)` until an `end` marker (README §6.2 L240–243). Also
    implement the **`MessageChannelMain`** variant for high-throughput streams (PTY/agent tokens).
    Returns a `StreamSink<T>` (the type from Task 2). Handle **backpressure** and teardown on renderer
    disconnect (phase doc §8 — "prove it with `app:echoStream`, including backpressure").
  - `src/main/ipc/register.ts`: the `handle(channel, fn)` helper that wraps every handler in the
    **error boundary** (catch → `toAppError` → reject with serialized shape, Task 3). Register
    `app:ping` (`() => 'ok'`), `app:info` (static app/version info), and the `app:echoStream` demo
    proving the streaming pattern end-to-end. Signature `registerIpc(ctx: AppContext)`.
  - `src/main/ipc/events.ts`: typed `emit(event, payload)` helpers over `webContents.send` for the
    frozen broadcast events (README §6.2 L250–261).
  - `src/preload/index.ts`: `contextBridge.exposeInMainWorld('api', { invoke, on, stream })`, typed from
    `src/shared/ipc.ts`. **Expose ONLY `window.api` — no `ipcRenderer`, no Node globals** (README §7.6).
    `src/preload/api.d.ts` declares `window.api` globally for the renderer.
  - `src/renderer/ipc/index.ts`: thin typed wrappers `invoke`, `onEvent`, `subscribeStream` over
    `window.api`. **All Electron access in the renderer funnels through this file** (README §10).
- **Pattern:** README §6.2 (L229–261), §7.6 (L359–366), §10 (L413–421); phase doc §3.6.
- **Gotcha:** With `sandbox: true`, the preload runs in a limited context — `contextBridge` is available
  but Node `require` is not (except a small allowlist). Keep the preload dependency-free. The stream
  `end` marker + `MessageChannelMain` port cleanup must not leak listeners across turns (this helper is
  load-bearing for Phases 2/3). Reject-with-`AppError` must serialize (see Task 2 gotcha).
- **Validate:** `npx tsc -b` clean across main+preload+renderer; after Task 9, `npm run dev` shows the
  round trip (green "IPC OK") and `app:echoStream` streams chunks then ends.

### Task 7 — Settings read-only skeleton (`src/main/settings/`)
- **What:**
  - `src/main/settings/schema.ts`: `EffectiveSettings` as a **zod** schema with the sections from spec
    §5.7 (L300–310): `[scripts]` (setup/run/archive, `run_mode`), `[env]`, `[agent]` (default harness,
    mode, permission policy, prompts), `[git]` (branch prefix, merge strategy), `[mcp]`. Provide
    **real, sensible defaults**. Export the schema for Phase 6 (and note `zod-to-json-schema` is
    available if a published JSON Schema is later wanted).
  - `src/main/settings/index.ts`: `SettingsService` with `load()` that merges layers **defaults → user
    (`paths.settingsPath()`) → project shared (`.harness/settings.toml`) → project local
    (`.harness/settings.local.toml`)** — files parsed with `smol-toml`; **absent file → skip layer**
    (README §6.5 L319–325, spec §5.7 layering L302–309). `get()` returns a **cloned** snapshot. **No**
    write path, **no** validation surfacing, **no** hot-reload (those are Phase 6). This replaces the
    `SettingsService` stub from Task 5's set.
- **Pattern:** README §6.5 (L319–325); spec §5.7 (L300–310). Config libs: README §2 (L54).
- **Gotcha:** Only *user* and *project* layers are wired now; the *managed* layer (`/Library/Application
  Support/<app>/managed.toml`) is reserved for v2 (spec §5.7 item 1) — don't implement it. `get()` must
  return a **clone** so callers can't mutate shared state. Highest layer wins (project local > shared >
  user > defaults) — get the merge precedence right; it's table-tested in Task 10.
- **Validate:** `npx vitest run src/main/settings` — layered-merge test with 0/1/2 file layers passes.

### Task 8 — App shell (renderer): providers, 3-pane layout, empty sidebar, IPC-OK indicator
- **What:**
  - `src/renderer/main.tsx` + `index.html`: React 18 root; mount `<App/>`; Tailwind entry CSS.
  - `src/renderer/app/providers.tsx`: `QueryClientProvider` (TanStack Query) + theme provider.
  - `src/renderer/app/AppLayout.tsx`: **three-pane** layout — left sidebar rail, center content, right
    context panel — all placeholders (phase doc §3.9).
  - `src/renderer/stores/workspaces.ts`: a Zustand store seeded **empty** (project/workspace list).
  - `src/renderer/features/sidebar/Sidebar.tsx`: renders the empty list from the store.
  - **Visible "IPC OK" indicator**: on mount call `invoke('app:ping')` via `src/renderer/ipc/` (Task 6);
    flip a green indicator when it returns `'ok'` — proves the round trip through preload (phase doc §3.9,
    DoD L154).
  - Tailwind + Radix configured; theme tokens in `app/theme.ts`.
- **Pattern:** README §3 renderer tree (L118–124), §10 renderer isolation (L413–417); phase doc §3.9.
- **Gotcha:** The renderer must reach main **only** through `src/renderer/ipc/` (never
  `window.electron`/`ipcRenderer`) — the CSP + sandbox will break direct access anyway. Keep the shell
  minimal; this is scaffolding, not the real UI.
- **Validate:** `npx vitest run src/renderer/app` — `AppLayout` renders; a mocked `window.api.invoke`
  resolving `'ok'` flips the indicator (Task 10).

### Task 9 — Convergence: main entry + hardened `BrowserWindow` + wiring (`src/main/index.ts`)
- **What:** The app entry that assembles everything.
  1. Init `electron-log` **first** (Task 3).
  2. On `app.whenReady()`: run DB open + migrations (Task 4), construct `SettingsService.load()`
     (Task 7), instantiate all stub services, assemble the concrete **`AppContext`** (Task 5), call
     `registerIpc(ctx)` (Task 6).
  3. Create a **hardened `BrowserWindow`**: `contextIsolation: true`, `nodeIntegration: false`,
     `sandbox: true`, `webSecurity: true`, a **strict CSP** (no remote content), preload = Task 6's
     preload (README §7.6 L359–366; phase doc §3.9).
  4. Deep-link: `app.setAsDefaultProtocolClient('harness')`; handle `open-url` (macOS) +
     `second-instance` by **logging the URL** (nav is a stub for now) (phase doc §3.9).
  5. Quit handling scaffold (`before-quit` hook present, no process-tree logic yet — that's Phase 3).
- **Pattern:** README §3 index.ts responsibilities (L84–91), §7.6 security (L359–366); spec §5.8 deep
  link (L315). phase doc §3.9.
- **Gotcha:** `sandbox: true` + `nodeIntegration: false` is the **hard-to-retrofit** decision (phase doc
  §8) — get it right now. The CSP must be strict but still allow the electron-vite dev server in dev
  (dev vs prod CSP differ). Migrations must complete **before** the window loads anything that calls DB
  IPC. Native module (`better-sqlite3`) must load in the **main** process (not the sandboxed renderer).
- **Validate:** `npm run dev` — window shows the 3-pane shell + green "IPC OK"; `app:echoStream` streams
  in the demo; no `ipcRenderer`/Node globals reachable from the page (check `window.ipcRenderer ===
  undefined` in devtools).

### Task 10 — Tests (author with `test-author`, independent of the code author)
- **What:** per phase doc §7 / README §9.
  - **Main (Vitest):** migration + `projects`/`workspaces` CRUD round-trip against a temp DB; settings
    layered-merge with 0/1/2 file layers; `AppError` serialization shape (survives structured clone).
  - **Renderer (Vitest + Testing Library):** `AppLayout` renders; `app:ping` with a **mocked**
    `window.api` flips the "IPC OK" indicator.
  - **E2E (Playwright `_electron`, optional this phase):** app boots, window visible (README §9 L407).
- **Pattern:** README §9 (L396–409); phase doc §7.
- **Gotcha:** Main tests must run under node/vitest **without** the Electron runtime — so DB tests open
  `better-sqlite3` directly at a temp path (inject the path; don't call `app.getPath`). Renderer tests
  mock `window.api` (don't boot Electron). Keep the fake harness out of scope (that's Phase 2's
  `MockHarness`).
- **Validate:** `npm run test` green (main + renderer); optionally `npm run test:e2e`.

---

## Execution Strategy
*How `/harness-implement` should build this. Read verbatim.*

- **Task shape:** Greenfield, **cross-cutting scaffolding** with a hard **sequential spine** (project must
  exist → contracts must be frozen) followed by a fan-out of **independent module directories**, then a
  **convergence** wiring step, then verification. Medium complexity, **elevated risk** (native-module ABI
  + renderer security hardening are get-it-right-once and hard to retrofit).
- **Pattern:** **prompt-chaining (spine) → parallelization/sectioning (module fan-out) →
  prompt-chaining (convergence) → evaluator-optimizer (review + mandatory verify).** Not a single agent:
  the phase is large and the module dirs are genuinely independent once the contracts are frozen.
- **Agents:** `coder` (spine: Tasks 1→2) · then parallel `coder`s — `coder`(db, Task 4) ·
  `coder`(stubs+AppContext, Task 5) · `coder`(settings, Task 7) · `coder`(app-shell, Task 8) ·
  `coder`(main-utils, Task 3) · then `coder`(ipc, Task 6) · then `coder`(convergence, Task 9) ·
  `test-author` (Task 10, after its targets exist) · **`code-review` + `verifier` (mandatory)** at the
  end. Restate in every agent prompt: obey README §5.2 (shared files are append-only), README §7.6
  (renderer hardening is non-negotiable), and the frozen-contract rule (Task 2 gotcha).
- **Orchestration:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` **is set** in `.claude/settings.json`, so
  prefer the **team** path (each teammate owns a directory via the shared task list); if the `TeamCreate`
  capability is unavailable at runtime, fall back to **parallel subagents** issued in one message.
- **Parallel decomposition + file-ownership (no two agents touch the same file):**
  - **Spine (sequential, blocks all):** Task 1 owns all root config (`package.json`, `tsconfig*`,
    `electron.vite.config.ts`, `electron-builder.yml`, eslint/prettier, `.github/`, `ci/`). Task 2 owns
    `src/shared/**`. **Nothing else starts until Tasks 1–2 land** — they are the seams.
  - **Parallel group (after Task 2 — disjoint dirs):** Task 3 owns `src/main/{paths,logging,error}.ts`;
    Task 4 owns `src/main/db/**`; Task 5 owns `src/main/{git,workspace,harness,pty,process,diff,
    checkpoint,checks,integrations}/**` + `src/main/context.ts`; Task 7 owns `src/main/settings/**`;
    Task 8 owns `src/renderer/**`. **These never touch each other's files.**
  - **Serialized after the group:** Task 5 (`context.ts`) type-only-imports Task 4's `Database` type +
    Task 7's `SettingsService` → schedule 5's AppContext assembly after 4+7. Task 6 (`src/main/ipc/**`
    + `src/preload/**` + `src/renderer/ipc/**`) needs the `AppContext` type → after Task 5.
  - **Convergence (sequential):** Task 9 owns `src/main/index.ts` only, and **wires** the outputs of
    3/4/5/6/7/8 — the one place that constructs the real `AppContext`. Runs after all of the above.
  - **Tests:** Task 10 owns `**/*.test.ts(x)` + `e2e/**`; runs after its targets exist (main-db tests
    after 4, settings after 7, renderer after 8, everything else after 9).
- **Rationale:** The contracts (Task 2) are the parallelization seam the whole plan (and Phases 1–7)
  depends on, so they're frozen first by one agent; the module dirs are disjoint and independent, so
  they fan out; convergence and security hardening are single-owner and serialized; and because native
  modules + renderer sandboxing are hard-to-retrofit, `verifier` is **mandatory**, not optional.

---

## Validation Gate
Run after all tasks (from repo root). **This project's gate is `npm run check` (README §8); the
`ci/harness-gates.sh` shim created in Task 1 wraps it so the PIV Stop hook / `/verify` line up.**
```
bash ci/harness-gates.sh typecheck        # fast inner loop: tsc -b (main/preload/renderer/shared)
bash ci/harness-gates.sh format lint      # prettier -c + eslint
npm run check                             # full gate: tsc -b && eslint && vitest run && electron-vite build
npx @electron/rebuild                     # native ABI: better-sqlite3 + node-pty for Electron (CI runs this)
```
Manual smoke (DoD L154): `npm run dev` → window shows the 3-pane shell + green **"IPC OK"** + working
`app:echoStream`; devtools confirms `window.ipcRenderer` / Node globals are `undefined`.

## Acceptance Criteria
*(Phase 0 Definition of Done — phase doc §6, L153–162.)*
- [ ] `npm run dev` launches the app; window shows the 3-pane shell and a green "IPC OK" from `app:ping`.
- [ ] `npm run check` fully green (`tsc -b`, eslint, vitest, `electron-vite build`).
- [ ] Renderer hardened: **no** Node globals / `ipcRenderer` reachable from the page; only `window.api`
      (contextIsolation + nodeIntegration:false + sandbox + strict CSP).
- [ ] Fresh-DB migration creates `projects` + `workspaces` (+ indexes); round-trip test inserts+reads a
      `Project` and a `Workspace`.
- [ ] `AppContext` exposes a stub for **every** subsystem in README §3; project type-checks with all
      registered.
- [ ] `Harness` interface + `AgentEvent` union present **verbatim per README §6.3** in
      `src/shared/harness.ts` (push-based `sink`; reconciliation noted).
- [ ] `paths`, `AppError`, `SettingsService.get()`, and `electron-log` to `logs/` all functional.
- [ ] `app:echoStream` demonstrates the `createStream()` helper end-to-end (proves the `Channel<T>`
      analogue, incl. backpressure + teardown).
- [ ] `@electron/rebuild` builds `better-sqlite3` + `node-pty` for the Electron ABI locally **and in CI**.
- [ ] All Validation Gate commands pass (run `/verify` for the evidence write-up).

## Open Decisions (flagged, not blocking)
- **App name / branding (README §11 open question):** planned working name **`harness`** (product
  "Harness", `appId com.serolo.harness`, protocol `harness://`). Chosen because the spec already
  hardcodes `harness://` deep links (§5.8) and the safeStorage service name derives from it. **Confirm
  before v1 release** — changing the protocol/appId later means migrating deep links + Keychain entries.
  If a different name is wanted, it changes exactly: `electron-builder.yml` (appId/productName), the
  `setAsDefaultProtocolClient` call (Task 9), and the safeStorage service key (Phase 5).
```
```

---

## Handoff
`/harness-implement plans/phase-0-foundation-plan.md`
