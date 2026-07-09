# Parallel Coding Agents — Implementation Plan

**Source of truth:** [`docs/parallel-agents-spec.md`](../parallel-agents-spec.md) (v0.1)
**This document:** master overview, tech decisions, shared contracts, and phase map.
**Audience:** implementing agents. Each phase file under `docs/implementation-plan/phase-*.md` is
self-contained enough to hand to one agent.

> ### Shell = **Electron**
> The spec (§2.1) and this plan agree: the app is built on **Electron**. The "core" is a **TypeScript
> Node.js main process**, not a Rust crate; the renderer is React + TypeScript. Everything downstream
> (language, DB driver, git access, PTY, IPC, packaging) follows from that and is specified below. The
> spec's *product* requirements (§1, §3 data model, §4 harness semantics, §5 subsystems, §6
> integrations, §7 security, §8 milestones, §9 risks) are the source of truth for *what* to build; this
> README is the binding decision for the *stack* used to build it.

---

## 1. How to use this plan

- **Read this README first, always.** It locks the tech stack, repo layout, and the **shared
  contracts** (data model, IPC contract, harness interface). Those contracts are the seams that let
  phases be built in parallel without stepping on each other.
- **Then read your phase file.** Each phase file lists: scope (in/out), dependencies on other phases,
  a task-by-task breakdown with file paths and key signatures, the IPC surface it adds, its
  Definition of Done, and its test plan.
- **Do not invent cross-phase interfaces.** If your phase needs to call another subsystem, use the
  contract defined here or in the dependency phase's file. If it's missing, add it to this README as
  a proposed contract change and flag it — don't silently diverge.
- **Every phase ends green.** A phase is done only when its DoD checklist passes *and* the app still
  builds, type-checks, lints, and all tests pass (`npm run check`, see §8).

---

## 2. Tech stack (locked for v1 — Electron)

Because main and renderer are **both TypeScript**, the IPC contract is expressed as **shared TS types**
— there is no cross-language codegen step (this is the big simplification vs the Tauri plan).

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Electron** (latest stable) | System Chromium + Node main process. |
| Core language | **TypeScript (Node.js)** — the **main process** | Single core process owns all state, DB, git, child processes. Services are TS classes. |
| Build / dev | **electron-vite** (Vite for `main`/`preload`/`renderer`, HMR) | One config, three targets. |
| Packaging | **electron-builder** | macOS `dmg`/`zip`, code signing + notarization. |
| Auto-update | **electron-updater** | Signed release feed. |
| DB | **better-sqlite3** (sync, transactional) + **Kysely** (typed query builder) | Numbered migrations via a small `user_version` runner. Row types shared in `src/shared`. |
| Git | **system `git` binary** via a thin typed wrapper (**execa** / **simple-git**) | Worktrees/diff/refs/commit-tree through the CLI — most reliable in Node. `nodegit`/`isomorphic-git` are documented alternatives, **not** the default (native-build / feature pain). |
| PTY | **node-pty** | Terminals + PTY-mode agent spawns. |
| Child processes | `child_process.spawn` (+ `detached` groups) + **tree-kill** | For agents, run scripts, setup scripts. SIGTERM→SIGKILL escalation. |
| FS watch | **chokidar** (debounced) | Diff recompute triggers. |
| HTTP / GitHub | **Octokit** (`@octokit/rest` + `@octokit/graphql`) | Conditional requests / ETags built in. |
| HTTP / Linear | **graphql-request** (or `undici`) | Phase 7. |
| Secrets | **Electron `safeStorage`** (Keychain-backed encryption) | Token ciphertext stored under `userData`; DB holds only a reference. `keytar` is the literal-Keychain alternative (unmaintained) — documented, not default. |
| Config | **smol-toml** (parse) + **zod** (typed schema + validation) | `zod-to-json-schema` if a published JSON Schema is needed. Replaces schemars/jsonschema. |
| IPC | `ipcMain.handle`/`ipcRenderer.invoke` + `contextBridge` preload + scoped stream channels / `MessageChannelMain` | Typed by shared TS contract in `src/shared/ipc.ts`. `electron-trpc`/`tipc` are optional typed-IPC libraries (documented, not required). |
| Logging | **electron-log** | Rolling files in `logs/`. |
| Frontend | **React 18 + TypeScript** (renderer, built by electron-vite) | Unchanged from the app UI perspective. |
| FE state | **Zustand** | Lightweight stores per feature. |
| FE data/query | **TanStack Query** | Caching/invalidation for command results. |
| Terminal UI | **xterm.js** (+ `@xterm/addon-fit`, `-webgl`) | |
| Diff/code UI | **Monaco** (diff editor) + **Shiki** (highlighted excerpts) | |
| Styling | Tailwind CSS + Radix primitives | |
| Testing (main) | **Vitest** + fixtures + temp git repos | Adapter contract tests replay recorded CLI output. |
| Testing (renderer) | Vitest + Testing Library | |
| Testing (E2E) | **Playwright** `_electron` launcher | Boots the packaged app with a seeded DB + fake harness. |

**Minimum agent CLI versions** are pinned in Phase 2/7 `detect()` implementations.

---

## 3. Repository layout

electron-vite convention: `src/main` (core), `src/preload` (bridge), `src/renderer` (React UI), plus
`src/shared` (types crossing the boundary — **the IPC contract lives here**).

```
/
├── package.json                   # scripts: dev / build / check / test / migrate / package
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json                  # + tsconfig.{main,preload,renderer,shared}.json (project refs)
├── src/
│   ├── main/                      # Electron MAIN process = "the core" (Node/TS)
│   │   ├── index.ts               # app lifecycle, BrowserWindow, IPC registration, quit handling
│   │   ├── context.ts             # AppContext: services + db handle (the old "AppState")
│   │   ├── error.ts               # AppError (shared shape re-exported from src/shared)
│   │   ├── paths.ts               # app.getPath('userData') → all on-disk locations (only place)
│   │   ├── logging.ts             # electron-log init
│   │   ├── ipc/                   # thin handlers → delegate to services; event emitters
│   │   │   ├── register.ts        # wires every ipcMain.handle + stream channels
│   │   │   └── events.ts          # typed webContents.send helpers
│   │   ├── db/                    # better-sqlite3 + kysely + migrations + repos
│   │   │   ├── index.ts           # open db, run migrations on start
│   │   │   ├── migrations/        # NNNN_name.ts (or .sql)
│   │   │   └── repos/             # one module per table/aggregate
│   │   ├── git/                   # GitService                 (Phase 1)
│   │   ├── workspace/             # WorkspaceManager, naming, ports (Phase 1)
│   │   ├── harness/               # Harness interface + adapters + supervisor (Phase 2, 7)
│   │   │   ├── supervisor.ts      # HarnessSupervisor
│   │   │   ├── claude-code.ts
│   │   │   ├── codex.ts           (Phase 7)
│   │   │   ├── cursor.ts          (Phase 7)
│   │   │   └── mock.ts            # MockHarness (Phase 2)
│   │   ├── pty/                   # PtyService (node-pty)       (Phase 3)
│   │   ├── process/               # ProcessRunner + ProcessRegistry (Phase 3)
│   │   ├── diff/                  # DiffService + chokidar watcher (Phase 4)
│   │   ├── checkpoint/            # CheckpointService           (Phase 4)
│   │   ├── checks/                # merge-readiness aggregator  (Phase 5)
│   │   ├── integrations/          # github/, linear/            (Phase 5, 7)
│   │   └── settings/              # layered TOML + zod          (Phase 0 skeleton → 6)
│   ├── preload/
│   │   └── index.ts               # contextBridge.exposeInMainWorld('api', typedApi)
│   ├── shared/                    # types used by BOTH main and renderer — the contract
│   │   ├── ipc.ts                 # command map + event map + stream channel names
│   │   ├── models.ts              # Project, Workspace, Turn, … row/DTO types
│   │   ├── harness.ts             # Harness interface, AgentEvent, StartTurnOpts, Attachment
│   │   └── errors.ts              # AppError shape
│   └── renderer/                  # React app (was `src/` in the Tauri plan)
│       ├── main.tsx
│       ├── app/                   # shell, layout, providers
│       ├── ipc/                   # thin wrapper over window.api (isolates Electron)
│       ├── stores/                # zustand
│       ├── features/              # sidebar / chat / terminal / diff / checks / settings
│       └── components/            # shared UI primitives
├── docs/
└── e2e/                           # Playwright _electron specs
```

**On-disk app data** (per spec §2.3): Electron `app.getPath('userData')` resolves to
`~/Library/Application Support/<app>/`, holding `app.db`, `settings.toml`, `logs/`, `secrets/`
(safeStorage ciphertext), and `projects/<id>/{repo,worktrees/<name>}`. `src/main/paths.ts` is the only
module that resolves these.

---

## 4. Phase map & dependency graph

| Phase | Title | Spec milestone | Depends on | Parallelizable with |
|---|---|---|---|---|
| **0** | Foundation & Scaffolding | (pre-M1) | — | — (gates everything) |
| **1** | Workspace Engine | M1 | 0 | 2 (against stubs) |
| **2** | Harness + Chat | M2 | 0, 1 | 3 |
| **3** | Terminal & Run Scripts | M3 | 0, 1 | 2, 4 |
| **4** | Diff, Review Loop, Checkpoints | M4 | 0, 1, (2 for "send to agent") | 3 |
| **5** | GitHub, Checks, PR Flow | M5 | 0, 1, 4 | 6 |
| **6** | Config, Settings UI, Polish | M6 | 0 (+ touches all) | 5 |
| **7** | v1.1: Codex/Cursor + Linear + scale | v1.1 | 2, 5 | — |

```
        ┌────────────┐
        │  Phase 0   │  (foundation — must land first)
        └─────┬──────┘
              │
        ┌─────▼──────┐
        │  Phase 1   │  (workspace engine)
        └─┬───┬───┬──┘
          │   │   │
   ┌──────▼┐ ┌▼──────┐ ┌▼─────────┐
   │Phase 2│ │Phase 3│ │ Phase 4  │   (2,3,4 run in parallel after 1;
   │harness│ │term   │ │diff/chkpt│    4 gains "send-to-agent" once 2 lands)
   └───┬───┘ └───────┘ └────┬─────┘
       │                    │
       └────────┬───────────┘
           ┌────▼─────┐
           │ Phase 5  │  (github + checks + PR)
           └────┬─────┘
           ┌────▼─────┐
           │ Phase 6  │  (config/polish, cross-cutting)
           └────┬─────┘
           ┌────▼─────┐
           │ Phase 7  │  (v1.1)
           └──────────┘
```

**MVP = Phases 0–4.** Complete-feeling product = through Phase 5. Phase 6 hardens/finishes;
Phase 7 is v1.1.

---

## 5. Parallelization strategy (for multiple agents)

The shared contracts let Phases 2/3/4 proceed **simultaneously** after Phase 1, and Phases 5/6 to
overlap. To make that safe:

1. **Phase 0 lands the contracts as compiling stubs.** Every service class named in §3 exists with its
   public method signatures and `throw new Error('not implemented')` bodies, constructed in
   `AppContext`. The `src/shared/ipc.ts` command/event maps compile, and the preload `window.api`
   type-checks, before bodies are implemented. A Phase-2 agent and a Phase-4 agent both build against a
   stable `AppContext` and a stable typed `window.api`.
2. **Ownership boundaries = directories.** An agent owns its phase's directory(ies) under
   `src/main/` and `src/renderer/features/`. Shared files (`context.ts`, `ipc/register.ts`,
   `shared/ipc.ts`, `shared/models.ts`) are **append-only** during parallel work: add your
   commands/events/types, never reorder or rewrite others'. Resolve conflicts by concatenation.
3. **Data model is additive.** Each phase adds its tables/columns via a **new numbered migration**;
   never edit a prior migration. The full schema (spec §3) is created across Phase 0 (core tables) +
   later phases (feature tables) — see each phase's "Data model" section for which migration it owns.
4. **The `AgentEvent` and `Harness` contract is frozen in Phase 0** (from spec §4.1) so Phase 4's
   review action and Phase 2's chat both target the same event shape.
5. **When a phase needs a not-yet-built dependency**, code against the Phase-0 stub and mark the
   integration point with `// INTEGRATION(phase-N): ...`. A short integration pass wires real
   implementations once both land.

---

## 6. Shared contracts

Authoritative. Phases extend them additively; they do not redefine them. Everything here lives under
`src/shared/` so main and renderer import the *same* types.

### 6.1 Data model

Full DDL is in spec §3. Ownership of each table by phase:

| Table | Created in | Notes |
|---|---|---|
| `projects` | Phase 1 | |
| `workspaces` | Phase 1 | `port`, `source_kind/ref` columns present from creation; PR/issue population lands in Phase 5. |
| `turns`, `events` | Phase 2 | Chat reconstructed from these. |
| `checkpoints` | Phase 4 | |
| `diff_comments` | Phase 4 | |
| `todos` | Phase 4 (schema) / Phase 5 (checks integration) | |
| `integrations` | Phase 5 | Token via safeStorage; row stores `token_ref` only. |
| `_migrations` (or `user_version`) | Phase 0 | Migration bookkeeping. |

Row/DTO types live in `src/shared/models.ts` as plain TS types/interfaces (Kysely infers table types
from a `Database` interface in `src/main/db`). IDs are **UUIDv7** strings (time-sortable, `uuid` pkg);
timestamps are `number` epoch-millis.

### 6.2 IPC contract

All names/types live in `src/shared/ipc.ts` and are imported by main (handlers), preload (bridge), and
renderer (calls). **No codegen — the shared types are the contract.**

- **Commands** (request/response): `ipcMain.handle(channel, handler)` in `src/main/ipc/register.ts`,
  each delegating to a service on `AppContext`. Channels named `<domain>:<verb>` (e.g.
  `workspace:create`, `diff:get`, `pr:open`). Renderer calls a typed `api.invoke('workspace:create',
  req)`. Handlers return `Promise<T>`; errors reject with a serialized `AppError` (§7.2).
- **Streaming** (agent output, PTY bytes, run-script logs, setup logs, clone progress): a **scoped
  stream channel** — the renderer calls `api.stream(channel, args, onChunk)`; main gets a
  subscription id and pushes chunks via `webContents.send('stream:<id>', chunk)` until an `end`
  marker. For high-throughput streams (PTY, agent tokens) use **`MessageChannelMain`** ports handed to
  the renderer to avoid main-thread `send` overhead. This is the Electron analogue of Tauri's
  `Channel<T>`; a single helper `createStream()` encapsulates it.
- **Broadcast events** (workspace status, checks updates, diff-changed, notifications, settings
  changed): `webContents.send('<domain>:<event>', payload)` via `src/main/ipc/events.ts`; renderer
  subscribes through `api.on('<domain>:<event>', cb)` exposed by preload.

Canonical event payloads (frozen names, extended additively):

```
workspace:status        { workspaceId, status }               // status machine (spec §5.1)
workspace:created        { workspace }
workspace:archived       { workspaceId }
turn:event               (streamed: AgentEvent chunks)         // Phase 2
pty:data                 (streamed: PtyChunk)                  // Phase 3
run:log                  (streamed: RunLogChunk)               // Phase 3
diff:changed             { workspaceId }                       // Phase 4
checks:updated           { workspaceId, checks }               // Phase 5
settings:changed         { }                                   // Phase 6
notify:needsAttention    { workspaceId, reason }               // Phase 2/5
```

### 6.3 Harness interface (frozen — spec §4.1, expressed in TS)

`src/shared/harness.ts`:

```ts
export type HarnessId = "claude_code" | "codex" | "cursor";

export interface Harness {
  id: HarnessId;
  capabilities(): HarnessCapabilities;      // supportsResume, supportsMcp, supportsPlanMode, rawTerminalFallback
  detect(): Promise<DetectResult>;          // { installed, version?, authenticated }
  startTurn(opts: StartTurnOpts, sink: StreamSink<AgentEvent>): Promise<TurnHandle>;
}

export interface StartTurnOpts {
  workspaceDir: string;
  prompt: string;
  attachments: Attachment[];                // files, images, diff comments
  sessionId?: string;                       // resume previous session
  mode?: AgentMode;                         // "plan" | "default" | "auto_accept"
  mcpConfig: McpServerConfig[];
  permissionPolicy: PermissionPolicy;
}

export interface TurnHandle { sessionId: string; interrupt(): Promise<void>; }

export type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; output: unknown }
  | { kind: "file_edit"; path: string; op: "create" | "modify" | "delete" }
  | { kind: "todo_update"; todos: Todo[] }
  | { kind: "turn_end"; usage?: Usage }
  | { kind: "error"; message: string };

// Attachment format is frozen in Phase 2 and consumed by Phase 4:
export type Attachment =
  | { type: "file"; path: string }
  | { type: "image"; path: string }
  | { type: "diff_comment"; file: string; lineStart: number; lineEnd: number;
      side: "old" | "new"; excerpt: string; body: string };
```

`StreamSink<AgentEvent>` is the main-side push handle from the stream helper (§6.2).
`HarnessSupervisor` (in `src/main/harness/supervisor.ts`) owns live agent child processes keyed by
`workspaceId`, enforces at most one active turn per workspace, and routes `interrupt`/quit. Adapters
(`claude-code.ts`, later `codex.ts`, `cursor.ts`) implement `Harness` over a spawned CLI via
`child_process`.

### 6.4 Status machine (spec §5.1)

`idle → working → needs_attention → idle`, with `running` as an orthogonal overlay while a run script
is active. Owned by `WorkspaceManager` (Phase 1 defines states + emits `workspace:status`);
transitions are *driven* by Phase 2 (turn lifecycle), Phase 3 (run overlay), Phase 5 (failing checks).
Any subsystem transitions status only via `WorkspaceManager.setStatus()`.

### 6.5 Settings access (spec §5.7)

Phase 0 ships a read-only `SettingsService` with the layered merge (defaults → user → project shared →
project local) and a typed `EffectiveSettings` (a **zod**-inferred type). Other phases **read** settings
through it (`settings.get()`), never parse TOML themselves. Phase 6 adds the write path, zod validation,
hot-reload, provenance, and the Settings UI.

---

## 7. Cross-cutting conventions

### 7.1 Naming & IDs
- TS everywhere: `camelCase` values, `PascalCase` types, `kebab-case` filenames. IPC channels
  `<domain>:<verb>`. IDs are UUIDv7 strings generated in main. Workspace **names** are unique city
  names per project (Phase 1 allocator).

### 7.2 Error handling
- One `AppError` shape in `src/shared/errors.ts`: `{ code, message, details? }` with a `code` union
  (`io | db | git | harness | integration | settings | not_found | conflict | invalid_input |
  internal`). Service code throws `AppError`; IPC handlers catch and reject with the serialized shape;
  the renderer wrapper rethrows a typed `AppError`. No swallowed errors. User-facing surfaces
  (needs_attention, toasts) get human-readable messages.

### 7.3 Concurrency & state
- `AppContext` holds the service singletons + the `better-sqlite3` handle (wrapped by Kysely). The main
  process is single-threaded: **`better-sqlite3` calls are synchronous** (fast, transactional) — keep
  individual queries small; if DB work ever blocks the event loop under load, move it to a
  `utilityProcess` (documented escape hatch). All external work (agents, PTYs, run scripts, git,
  HTTP) is async child-process / I/O and must never block. Long-running handles are stored in their
  owning service for shutdown.

### 7.4 Process lifecycle
- Agents survive UI navigation; app quit (`before-quit`) interrupts agents then stops run scripts
  (SIGTERM→SIGKILL via `tree-kill`, spec §9). Archive stops the workspace's process tree before
  `git worktree remove`. All child processes are registered in the shared `ProcessRegistry` (Phase 3).

### 7.5 Logging & telemetry
- `electron-log` to `logs/` (rolling) + console in dev. Telemetry is **opt-in only** (spec §7); no
  network calls for telemetry unless enabled.

### 7.6 Security (Electron-specific — important)
- **Renderer hardening:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` where
  feasible; the preload exposes only the typed `window.api` via `contextBridge` — **no `ipcRenderer`
  or Node globals leak to the renderer.** A strict **CSP** is set; remote content is not loaded.
- **Secrets:** tokens encrypted with `safeStorage` (Keychain-backed), ciphertext under
  `userData/secrets/`; DB stores only `token_ref` (spec §7).
- **Agent/run commands** execute with user privileges inside the worktree — no sandbox claim in v1,
  documented in onboarding (Phase 6). This is separate from renderer sandboxing above.

### 7.7 Definition of Done (applies to every phase)
1. All tasks in the phase file implemented; DoD checklist in the phase file ticked.
2. `npm run check` green: `tsc -b` (all project refs: main/preload/renderer/shared),
   `eslint`, `vitest run` (main + renderer), and `electron-vite build` succeeds.
3. New IPC channels/events added to `src/shared/ipc.ts` and documented in the phase file's "IPC
   surface" section (renderer + main type-check against the same contract — that's the guarantee).
4. New tables added via a new migration; migrations run clean on a fresh DB.
5. Manual smoke path (listed per phase) demonstrated, ideally with a short screen capture or logs.

---

## 8. Tooling: `package.json` scripts

```
npm run dev        # electron-vite dev (HMR main/preload/renderer)
npm run build      # electron-vite build (type-checked bundles)
npm run package    # electron-builder → dmg/zip
npm run check      # tsc -b && eslint && vitest run && electron-vite build   (CI gate)
npm run test       # vitest run (main + renderer)
npm run test:e2e   # playwright test (e2e/, _electron)
npm run migrate    # run migrations against a scratch db
```

CI (GitHub Actions, macOS runner) runs `npm run check` on every PR. (No bindings-staleness check is
needed — the IPC contract is shared TS, enforced by `tsc`.)

---

## 9. Testing strategy (summary; details per phase)

- **Git/worktree/checkpoint logic:** integration tests against temp repos created in `tmpdir` (drive
  the real `git` binary through GitService).
- **Harness adapters:** *contract tests against recorded fixtures* — capture real
  `claude --output-format stream-json` output once, replay through the parser, assert the normalized
  `AgentEvent` stream (spec §9 risk mitigation). No live CLI in CI.
- **Settings:** table-driven tests over layered merge + zod validation.
- **Integrations (GitHub/Linear):** mock HTTP (nock/msw or Octokit test interceptors) with recorded
  response bodies; ETag/conditional paths covered.
- **Renderer:** component tests for chat/diff/checks with Testing Library.
- **E2E:** Playwright `_electron` boots the built app with a seeded DB and a fake harness.
- **Fake harness:** Phase 2 ships a `MockHarness` (deterministic scripted `AgentEvent` stream) used by
  every later phase's UI/E2E tests so they don't need a real CLI.

---

## 10. Electron architecture notes
- **Keep the renderer runtime-agnostic.** All Electron/IPC access funnels through
  `src/renderer/ipc/`; feature code imports typed wrappers, never `window.electron`/`ipcRenderer`
  directly. This isolates the shell and keeps the UI portable.
- **`src/shared` is the single source of truth** for anything crossing the process boundary — never
  duplicate a type in main and renderer.
- **Native-module note:** `better-sqlite3` and `node-pty` are native modules — configure
  `electron-builder`/`electron-rebuild` so they build for the Electron ABI; CI must run
  `electron-rebuild` (or `@electron/rebuild`). Flagged again in Phase 0.
- Per-risk mitigations (CLI format drift, checkpoint/session mismatch, port conflicts, archive with
  live servers, GH rate limits, monorepo scale) are addressed in the owning phase files.

---

## 11. Open questions to resolve before/within phases
Carried from spec §9 — each tagged to the phase that must decide:
- **App name/branding** → Phase 0 (`electron-builder` appId + product name, deep-link scheme).
- **Raw-terminal chat fallback** for harnesses without JSON streams → Phase 7 (capability flag).
- **Multi-account GitHub** → Phase 5 (schema allows N `integrations` rows; UI decision).
- **Team-shared settings distribution** → Phase 6 (project shared layer covers v1).
- **safeStorage vs keytar** for token storage → Phase 5 (default safeStorage; revisit if literal
  Keychain entries are required).
