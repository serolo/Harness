# Plan: Phase 2 — Claude Code Harness + Chat (Electron)

## Ticket / Feature
Phase 2 of the Parallel Coding Agents app (`docs/implementation-plan/phase-2-harness-chat.md`, spec
§2.2/§3/§4/§4.2/§5.1/§5.8/§8-M2): drive a real turn loop against the user's installed `claude` CLI —
spawn headless with stream-JSON, normalize into the frozen `AgentEvent` stream, persist turns+events,
own agent-process lifecycle via `HarnessSupervisor`, render a first-class chat UI (attachments,
tool/edit/todo rendering, interrupt, resume), wire the status machine + `needs_attention`
notifications, and ship a `MockHarness` so the whole app runs in CI without a real CLI.

## Context: what earlier phases already froze (build against these, don't re-litigate)
- **`src/shared/**` is append-only** (README §5.2). The **entire harness contract is already frozen**
  in `src/shared/harness.ts`: `Harness`, `StartTurnOpts`, `TurnHandle`, `AgentEvent`, `Attachment`,
  `HarnessCapabilities`, `DetectResult`, `AgentMode`, `McpServerConfig`, `PermissionPolicy`, `Todo`,
  `Usage`. **Do not modify or re-shape these** — the adapter/supervisor implement them verbatim.
  Note the header: README §6.3 WINS over spec §4.1 — `startTurn` is **push-based** (takes a
  `StreamSink<AgentEvent>`), `TurnHandle` is only `{ sessionId; interrupt() }` (no `AsyncIterable`).
- **The `HarnessSupervisor` stub already has the exact method signatures** (`src/main/harness/supervisor.ts`):
  `register`, `detect(id)`, `startTurn(workspaceId, opts, sink)`, `interrupt(workspaceId)`,
  `isActive(workspaceId)`, `quitAll()`. Fill the bodies; **do not change the signatures** (frozen for
  Phase 7's other adapters).
- **Streaming infra is done.** `createStream()` (WebContents.send, microtask-batched soft-backpressure)
  and `createMessageChannelStream()` (MessagePort, real backpressure — "for PTY bytes and agent token
  deltas") both in `src/main/ipc/stream.ts`; the `streamProducers` registry is a **mapped type over every
  `StreamChannel`** (`src/main/ipc/register.ts:118`) so adding a `StreamChannels` entry forces a producer
  (tsc-enforced). The preload `stream()` + renderer `subscribeStream()` funnel already handle the
  `createStream` transport end-to-end (`src/preload/index.ts:117`, `src/renderer/ipc/index.ts:76`).
- **`turn:event` Event and `notify:needsAttention` Event are already typed + reserved** in
  `src/shared/ipc.ts:117,129`. `notify:needsAttention` is emitted for real this phase. See Open Decision
  D1 on `turn:event` (broadcast) vs a scoped stream for the token deltas.
- **DB layer + migration runner are done.** `openDb()` (`src/main/db/index.ts:39`), the append-only
  migration array (`src/main/db/migrations/index.ts:31`, currently `[migration0001Core]`), and the repo
  pattern (`WorkspacesRepo` `src/main/db/repos/workspaces.ts:74`, explicit row↔DTO mapping). **New tables
  = a new migration `0003` + schema types + a repo; never write SQL outside a repo** (architecture rule).
- **Status machine has one owner.** `WorkspaceManager.setStatus(id, status)` is the SOLE path that writes
  status + emits `workspace:status` (`src/main/workspace/index.ts:318`, README §6.4). Turn lifecycle drives
  status **only through it** — the supervisor must call `setStatus`, never write status directly.
- **Settings are read-only + merged** via `ctx.settings.get()`; the `[agent]` section
  (`src/main/settings/schema.ts:111`) already carries `defaultHarness`/`mode`/`permissionPolicy`, and the
  top-level `mcp` array carries `McpServerConfig[]`. The zod mirrors are guarded against drift from
  `@shared/harness`. **A new `[notifications]` section is additive** (schema is not `src/shared`, but keep
  it additive + defaulted so `{}` still parses).
- **execa is v9 (ESM-only)** — `import { execa }`, used for `detect()`'s `claude --version`. Long-lived
  agent spawn uses **`child_process.spawn`** (need a live stdout stream + SIGINT), per phase-doc §3.1.
- **`ProcessRegistry` is a Phase-0 stub that THROWS** (`src/main/process/index.ts:47`, implemented in
  Phase 3). Phase-2 §3.2 asks to register agent processes there — see Risk R2 for the reconciliation
  (supervisor owns its own registry now; `before-quit` calls `ctx.harness.quitAll()`; leave a
  `// INTEGRATION(phase-3)` seam to fold into `ProcessRegistry`).
- **Tests run under the Electron ABI** via `node scripts/vitest-electron.mjs run <file>` (node env by
  default; `src/renderer/**/*.test.tsx` → jsdom). Renderer tests mock `window.api` (see
  `src/renderer/app/AppLayout.test.tsx`). `shiki` is already a dep (code highlighting). There is **no
  markdown renderer dep** — see Open Decision D3.
- **This checkout's git link is broken** ([[broken-git-link]]): don't rely on `git diff/status` at the
  repo root to inspect changes; tests that shell out to git use fresh `os.tmpdir()` repos and are
  unaffected. The Stop-hook cleanliness gate is a no-op here ([[harness-enforcement-degraded]]) — run
  `bash ci/harness-gates.sh` explicitly.

---

## Affected Files

### Read before implementing (context — do not modify)
- `docs/implementation-plan/phase-2-harness-chat.md` — the per-task detail this plan operationalizes.
- `docs/implementation-plan/README.md` — §6.2 IPC/stream contract, §6.3 Harness interface (authoritative),
  §5.1 status machine, §5.8 notifications/deep-link, §9 CLI-drift risk.
- `src/shared/harness.ts` — the FROZEN harness contract the adapter/supervisor implement verbatim.
- `src/shared/ipc.ts` (`Commands` :70, `Events` :109, `StreamChannels` :140) + `src/shared/models.ts`
  — the append points.
- `src/main/harness/supervisor.ts` — the stub to fill (signatures frozen).
- `src/main/ipc/register.ts` (:70 `handle`, :118 `streamProducers`, :234 `registerIpc`),
  `src/main/ipc/stream.ts` (:101 `createStream`, :257 `createMessageChannelStream`),
  `src/main/ipc/events.ts` (:19 `emit`) + `src/main/ipc/CLAUDE.md`.
- `src/main/db/index.ts`, `src/main/db/schema.ts`, `src/main/db/migrations/{index,0001_core}.ts`,
  `src/main/db/repos/workspaces.ts` — migration + repo patterns to mirror.
- `src/main/workspace/index.ts:318` (`setStatus`) — the only status writer; `src/main/index.ts:177`
  (`createAppContext`, the ONE construction site) + `:363` (`before-quit` scaffold).
- `src/main/settings/schema.ts:111` (`agentSchema`) + `src/main/settings/index.ts` (`get()`).
- `src/renderer/ipc/index.ts` (funnel), `src/renderer/stores/workspaces.ts`,
  `src/renderer/features/sidebar/{hooks.ts,Sidebar.tsx,WorkspaceItem.tsx,StatusBadge.tsx}`,
  `src/renderer/app/AppLayout.test.tsx` (renderer test style + `window.api` stub).
- `src/main/git/index.ts` (`GitService` — note `status()` :632 THROWS, Phase 4; see Task 6/Risk R3).

### Modify (append-only where under `src/shared/`)
- `src/shared/ipc.ts` — APPEND to `Commands` (`turn:interrupt`, `chat:history`, `harness:detect`,
  `harness:list`), to `StreamChannels` (`turn:start`), and the payload DTOs (`TurnStartArg`,
  `TurnStreamChunk`, `ChatHistory`, `HarnessInfo`). Emit the already-reserved `notify:needsAttention`.
  **Never touch existing entries.**
- `src/shared/models.ts` — APPEND `TurnRecord` / `TurnEventRecord` DTOs (chat-history reconstruction)
  and `TurnStatus` (`'streaming' | 'completed' | 'interrupted' | 'error'`).
- `src/main/harness/supervisor.ts` — implement all bodies (registry, spawn/resume/interrupt, status
  wiring, quitAll); grow the constructor to inject deps (adapters, repos, `setStatus`, `emit`,
  notifications) — the stub is currently no-arg.
- `src/main/db/schema.ts` — APPEND `TurnsTable`, `EventsTable` + add them to the `Database` interface.
- `src/main/db/migrations/index.ts` — APPEND `migration0003TurnsEvents` to the ordered array.
- `src/main/settings/schema.ts` — APPEND a `[notifications]` section (defaulted) + optional
  `agent.harnessImpl` (`'auto' | 'mock'`) selector, keeping the zod-vs-frozen-type guards intact.
- `src/main/ipc/register.ts` — APPEND the `turn:start` stream producer + the four command handlers.
- `src/main/index.ts` — wire the real `HarnessSupervisor` (register the Claude adapter or MockHarness per
  settings/env; inject repos + `workspaces.setStatus` + `emit` + notifications) and make `before-quit`
  `await ctx.harness.quitAll()` before the (Phase-3) process teardown.
- `src/renderer/stores/workspaces.ts` — no change required; chat state lives in a new `chatStore`.

### Create
- `src/main/harness/claude-code.ts` — the Claude Code `Harness` adapter (detect, startTurn, interrupt,
  the stream-JSON→`AgentEvent` normalization table, attachment serialization incl. the frozen
  `diff_comment` block format).
- `src/main/harness/parser.ts` — pure line-delimited-JSON split + per-object normalization (extracted so
  it is unit/contract-testable with **no** child process). `claude-code.ts` composes it.
- `src/main/harness/mock.ts` — `MockHarness`: config-driven scripted `AgentEvent` sequences with timing.
- `src/main/harness/turns.ts` — `TurnRecorder`: the streaming write path (insert `turns` row on start;
  per-event insert into `events` with **text-delta coalescing**; finalize status/`endedAt`; rebuild
  `ChatHistory`). Thin orchestration over the two repos; the supervisor calls it.
- `src/main/harness/notifications.ts` — `NotificationService`: Electron `Notification` on
  `needs_attention` / (configurable) turn completion; deep-link click-through `harness://workspace/<id>`;
  respects the `[notifications]` settings toggle. (Notification is a main-only API.)
- `src/main/db/repos/turns.ts`, `src/main/db/repos/events.ts` — typed CRUD over the two new tables
  (row↔DTO mapping explicit, mirroring `workspaces.ts`).
- `src/main/harness/fixtures/*.jsonl` — recorded `claude --output-format stream-json` fixtures
  (simple-text, tool-use, file-edit, error, resume).
- `src/renderer/features/chat/` — `ChatPanel.tsx`, `Composer.tsx`, `Transcript.tsx`, `TurnDivider.tsx`,
  the per-`AgentEvent` renderers (`TextMessage.tsx`, `ToolCard.tsx`, `FileEditChip.tsx`, `TodoList.tsx`,
  `ErrorCard.tsx`), `AttachmentBar.tsx`, `useChat.ts` (subscribe/reconstruct), `markdown.tsx` (see D3).
- `src/renderer/stores/chat.ts` — Zustand `chatStore` (per-workspace transcript, busy flag, auto-scroll).
- Tests (Task 9): `src/main/harness/parser.test.ts` (contract, snapshot fixtures — primary CLI-drift
  defense), `src/main/harness/supervisor.test.ts`, `src/main/harness/turns.test.ts`,
  `src/main/harness/mock.test.ts`, `src/main/db/repos/turns.test.ts`,
  `src/renderer/features/chat/ChatPanel.test.tsx`, and an E2E `e2e/chat.spec.ts` (MockHarness-driven).

---

## Ordered Tasks

### Task 1 — Migration `0003_turns_events` + schema types + repos
- **What:** Add tables per spec §3 (confirm exact column set against README/spec §3 DDL before writing):
  - `turns(id TEXT PK, workspace_id TEXT NOT NULL REFERENCES workspaces(id), idx INTEGER NOT NULL,
    status TEXT NOT NULL, session_id TEXT, mode TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER)`.
  - `events(id TEXT PK, turn_id TEXT NOT NULL REFERENCES turns(id), kind TEXT NOT NULL,
    payload_json TEXT NOT NULL, ts INTEGER NOT NULL)`.
  - Indexes: `CREATE INDEX idx_events_turn_id ON events(turn_id)`;
    `CREATE UNIQUE INDEX uidx_turns_workspace_idx ON turns(workspace_id, idx)` (per-workspace ordering).
  - APPEND `TurnsTable`/`EventsTable` to `schema.ts` + the `Database` interface; APPEND
    `migration0003TurnsEvents` (version 3) to the `migrations` array. Add `TurnRecord`/`TurnEventRecord`/
    `TurnStatus` DTOs to `@shared/models`. Write `TurnsRepo`/`EventsRepo` with explicit row↔DTO mapping
    (`payload_json` (de)serialized to/from the typed `AgentEvent`).
- **Pattern:** `0001_core.ts:17` (raw-SQL `up`), `migrations/index.ts:31` (append), `schema.ts:35`,
  `repos/workspaces.ts:74`.
- **Gotcha (heightened-scrutiny — db/migrations):** migration is append-only + numbered strictly
  increasing; ship a **rollback/back-compat note** (SQLite is on the user's disk — no server redo). The
  two tables are new/additive, so rollback = drop `events` then `turns`; forward-compat: unknown future
  event `kind`s must round-trip as opaque JSON (don't enum-narrow the stored `kind` destructively).
- **Validate:** `node scripts/vitest-electron.mjs run src/main/db/repos/turns.test.ts` and the existing
  `src/main/db/index.test.ts` (fresh-DB apply + idempotent re-run still green).

### Task 2 — stream-JSON parser + normalization table (pure, contract-tested)
- **What:** `src/main/harness/parser.ts`:
  - A line-buffering split: accumulate stdout chunks, split on `\n`, **hold a partial trailing line**
    across chunks (large tool outputs exceed one chunk — phase-doc §8), `JSON.parse` each complete line.
  - `normalize(obj: unknown): AgentEvent | null` — the **normalization table** mapping each Claude
    stream-JSON object (`type: 'system'|'assistant'|'user'|'result'|...`, content blocks
    `text`/`tool_use`/`tool_result`, todo updates, usage) → the frozen `AgentEvent` union
    (`text`/`tool_use`/`tool_result`/`file_edit`/`todo_update`/`turn_end`/`error`). **Unknown types →
    return null (log + ignore)** for forward-compat (spec §9). Capture the session id from the
    init/system event and surface it (return via a small tagged result so the adapter can set it on the
    `TurnHandle`). Document the table in-file.
  - Map `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool_use (or the result's file list) → `file_edit`
    events with `op: 'create'|'modify'|'delete'`.
- **Pattern:** phase-doc §3.1 "Normalization table"; `AgentEvent` in `src/shared/harness.ts:39`.
- **Gotcha:** keep this a **pure function/transform** — no `child_process`, no Electron — so the contract
  test drives it from recorded fixtures with zero spawn. Never `JSON.stringify` an error object; carry
  `error.message` only. Coalescing is NOT done here (that is the recorder's job, Task 4) — the parser
  emits one `AgentEvent` per source object.
- **Validate:** `node scripts/vitest-electron.mjs run src/main/harness/parser.test.ts` (snapshot each
  fixture → normalized `AgentEvent[]`).

### Task 3 — Claude Code adapter (`claude-code.ts`) + MockHarness (`mock.ts`)
- **What:**
  - `claude-code.ts` implements `Harness` (id `'claude_code'`):
    - `capabilities()` → `{ supportsResume:true, supportsMcp:true, supportsPlanMode:true,
      rawTerminalFallback:true }`.
    - `detect()` → `execa('claude', ['--version'])`; parse version; probe auth cheaply
      (`--help`/status); pin a **minimum version**, warn (don't hard-block) on older; degrade to
      `authenticated:false`/"unknown" rather than failing (phase-doc §8, Risk R4). Return
      `{ installed, version?, authenticated }`.
    - `startTurn(opts, sink)` → `child_process.spawn('claude', ['-p', opts.prompt, '--output-format',
      'stream-json', '--verbose'], { cwd: opts.workspaceDir, env })`. Append `--resume <sessionId>` when
      set; map `opts.mode` (plan/default/auto_accept) + `opts.permissionPolicy` to CLI flags; write
      `opts.mcpConfig` to a generated `.mcp.json` (or the CLI flag). Wire stdout → parser (Task 2) →
      `sink.push(agentEvent)`; capture session id → resolve `TurnHandle.sessionId`. `interrupt()` sends
      **SIGINT** and guarantees a terminal `turn_end`/`error` is still emitted (synthesize one on exit if
      the CLI didn't). On non-zero exit without a terminal event → `sink`-visible `error` event.
    - **Attachment serialization** (frozen contract for Phase 4): files/images via prompt refs or
      supported flags; **`diff_comment` → a structured text block appended to the prompt** — define the
      EXACT format (file, `lineStart`–`lineEnd`, `side`, `excerpt`, `body`) and document it in-file as
      "THE Phase-4 contract".
  - `mock.ts` — `MockHarness` (id `'claude_code'` or a distinct id per D2): config-driven scripted
    `AgentEvent` sequences with per-event timing/delays, deterministic session ids, resume echo, and an
    interrupt that emits a terminal `turn_end`. Drives all renderer/E2E tests + dev with no real CLI.
- **Pattern:** phase-doc §3.1/§3.9; `execa` usage in `src/main/git/index.ts:246`; the frozen `Harness`
  shape in `src/shared/harness.ts:14`.
- **Gotcha (heightened-scrutiny — process execution):** **`spawn` with an argument array, never a shell
  string**; the prompt/attachments/cwd are workspace-derived → treat as untrusted, do not interpolate
  into a shell. Confine `cwd` to the workspace worktree. No secrets/tokens in logs or error messages.
  Buffer partial stdout lines (Task 2). Ensure the child is killed + deregistered on every terminal path
  (no zombie `claude` processes across turns).
- **Validate:** `node scripts/vitest-electron.mjs run src/main/harness/mock.test.ts`; adapter exercised
  by the supervisor test (Task 5) + a smoke run.

### Task 4 — TurnRecorder: the persistence & streaming write path (`turns.ts`)
- **What:** `TurnRecorder` over `TurnsRepo`/`EventsRepo`:
  - `beginTurn(workspaceId, {sessionId?, mode})` → insert a `turns` row (`idx` = next per workspace via a
    `MAX(idx)+1` read, `status='streaming'`, `started_at`); returns the `turnId`.
  - `record(turnId, event: AgentEvent)` → for each event: forward to the renderer sink AND persist an
    `events` row — but **coalesce consecutive `text` deltas** in memory and flush the accumulated text as
    a single `events` row periodically (timer/size threshold), not per-token (better-sqlite3 is
    synchronous — per-delta writes block the event loop, phase-doc §8/Risk). Non-text events flush the
    pending text buffer first (ordering), then persist immediately.
  - `endTurn(turnId, status, usage?)` → flush the text buffer, set `turns.status` + `ended_at` (+ usage).
  - `history(workspaceId): ChatHistory` → read `turns` + their `events` (ordered) and rebuild the
    transcript. Round-trips: replaying the persisted events equals the streamed sequence.
- **Pattern:** repos from Task 1; coalescing rationale in phase-doc §3.3/§8; sink shape
  `StreamSink<AgentEvent>` (`@shared/ipc:18`).
- **Gotcha:** the sink `push` and the DB write must preserve ordering; on `sink.error`/interrupt still
  finalize the turn row (no dangling `streaming` rows). Text coalescing must not drop the final partial
  buffer on abrupt end.
- **Validate:** `node scripts/vitest-electron.mjs run src/main/harness/turns.test.ts` (event write +
  `history` round-trip equals the streamed sequence; interrupt leaves an `interrupted` turn).

### Task 5 — HarnessSupervisor: lifecycle, single-turn invariant, status + notifications
- **What:** implement the frozen stub (`supervisor.ts`); grow the constructor to inject
  `{ adapters: Map<HarnessId,Harness>, recorder: TurnRecorder, setStatus, emit, notifications }`:
  - `register(harness)` → add to the adapter map.
  - `detect(id)` → delegate to the adapter's `detect()`.
  - `startTurn(workspaceId, opts, sink)` → **reject with `AppError('conflict')` if a turn is already
    active** for the workspace (at-most-one invariant). Resolve the workspace's harness adapter,
    `recorder.beginTurn`, wrap `sink` so each pushed `AgentEvent` is also `recorder.record`-ed, call
    `adapter.startTurn`, store a `LiveTurn { turnId, handle, abort }` in the registry. On start →
    `setStatus(workspaceId,'working')`. On clean `turn_end` → `recorder.endTurn('completed')`,
    `setStatus('needs_attention')` + `notifications.turnDone(...)` + `emit('notify:needsAttention', …)`;
    on `error`/permission-request → `endTurn('error')`, `setStatus('needs_attention')` with reason +
    notify. Clear the registry entry + guarantee `sink.end()`/`sink.error()`.
  - `interrupt(workspaceId)` → call the live `TurnHandle.interrupt()` (SIGINT); ensure the terminal event
    records an `interrupted` turn; no-op if none active.
  - `isActive(workspaceId)` → registry membership.
  - `quitAll()` → interrupt every live turn + tear down every child (called from `before-quit`).
- **Pattern:** stub `supervisor.ts:26`; status writer `workspace/index.ts:318`; conflict error
  `new AppError('conflict', …)` (see `register.ts:301`).
- **Gotcha (heightened-scrutiny — process lifecycle):** status changes go **only** through the injected
  `setStatus` (never write the DB directly). The single-turn invariant is load-bearing — the registry
  must be cleared on EVERY terminal path (end/error/interrupt/child-exit/crash) or the workspace wedges
  "busy" forever. See Risk R2: register children in the supervisor's own map now, `// INTEGRATION(phase-3)`
  to fold into `ProcessRegistry`.
- **Validate:** `node scripts/vitest-electron.mjs run src/main/harness/supervisor.test.ts` (rejects
  concurrent turns; interrupt emits a terminal event + `interrupted` turn; status transitions fire;
  registry cleared on exit — driven by `MockHarness`).

### Task 6 — Shared contract additions (append-only) + IPC handlers + main wiring
- **What:**
  - APPEND to `src/shared/ipc.ts`:
    - `StreamChannels`: `'turn:start': { arg: TurnStartArg; chunk: TurnStreamChunk }` where
      ```ts
      export interface TurnStartArg {
        workspaceId: string; prompt: string; attachments: Attachment[]; mode?: AgentMode;
      }
      export type TurnStreamChunk =
        | { kind: 'started'; turnId: string; sessionId: string }
        | { kind: 'event'; turnId: string; event: AgentEvent };
      ```
      (progress + terminal frame over ONE scoped stream — mirrors `workspace:create`; the stream `end`s
      after the `turn_end`/`error` `AgentEvent`).
    - `Commands`: `'turn:interrupt': { req:{workspaceId}; res:void }`,
      `'chat:history': { req:{workspaceId}; res: ChatHistory }`,
      `'harness:detect': { req:{id:HarnessId}; res: DetectResult }`,
      `'harness:list': { req:void; res: HarnessInfo[] }` (id + capabilities + detect summary).
    - DTOs `ChatHistory` (`{ turns: TurnRecord[] }`, each turn carrying its `TurnEventRecord[]`) +
      `HarnessInfo`.
  - `src/main/ipc/register.ts`: add the `turn:start` **stream producer** (mirror `workspace:create`
    `register.ts:159`: async IIFE, `ctx.harness.startTurn(arg.workspaceId, opts, sinkAdapter)`, map each
    `AgentEvent` → `{kind:'event',turnId,event}` frame, push the initial `{kind:'started',...}`, route
    failures to `sink.error`). Add the four command handlers delegating to `ctx.harness` /
    `ctx.recorder.history`. Build `StartTurnOpts` from `arg` + `ctx.settings.get()` (mcp,
    permissionPolicy, default mode) + the workspace's resolved `sessionId` (from the latest turn) +
    `workspaceDir` (worktree path).
  - `src/main/index.ts` (`createAppContext` :177): construct `TurnsRepo`/`EventsRepo` → `TurnRecorder` →
    `NotificationService` → build the adapter set (register `ClaudeCodeHarness`, or `MockHarness` when
    `settings.agent.harnessImpl==='mock'` **or** `process.env['AGENTAPP_MOCK_HARNESS']==='1'` — always
    mock under `AGENTAPP_E2E`), inject all into the real `HarnessSupervisor`. Make `before-quit`
    `await ctx.harness.quitAll()` **before** the Phase-3 process-teardown log.
- **Pattern:** append points `ipc.ts:70/109/140`; producer `register.ts:159`; wiring `index.ts:177`.
- **Gotcha (heightened-scrutiny — IPC boundary):** every handler **validates + narrows** its payload
  (`workspaceId` exists; `attachments` well-formed; `prompt` a string) before acting — treat channel
  payloads as untrusted. Append-only: add at the END of each map, never reorder. The `streamProducers`
  mapped type won't compile until the `turn:start` producer exists (intended forcing function).
- **Validate:** `bash ci/harness-gates.sh typecheck` (tsc -b clean across refs).

### Task 7 — Notifications + settings + status→idle-on-view
- **What:**
  - `src/main/harness/notifications.ts`: `NotificationService.notify({workspaceId, title, body, reason})`
    → Electron `new Notification(...)`; on click, route the `harness://workspace/<id>` deep link
    (reuse `handleDeepLink` in `index.ts:290` — log-only nav is fine for Phase 2). Fire on
    `needs_attention` always; on turn completion / errors only when the `[notifications]` toggle allows.
  - APPEND `[notifications]` to `settings/schema.ts` (`{ enabled: bool=true, onTurnComplete: bool=true,
    onError: bool=true, onNeedsAttention: bool=true }`, all defaulted) + optional
    `agent.harnessImpl: z.enum(['auto','mock']).default('auto')`. Keep the drift guards compiling.
  - **`needs_attention` → `idle` on view:** when the renderer opens/focuses a workspace whose status is
    `needs_attention`, flip it back to `idle`. Simplest Phase-2 path: on `chat:history` fetch for a
    `needs_attention` workspace, call `workspaces.setStatus(id,'idle')` (or a dedicated
    `workspace:markSeen` command — see D4). Sending the next turn also clears it (goes `working`).
- **Pattern:** `Notification` (Electron main API); deep-link `index.ts:283`; settings defaults
  `schema.ts:79`.
- **Gotcha (heightened-scrutiny — secrets):** notification body must not leak prompt/tool output secrets;
  keep it to a workspace name + reason. Notifications are best-effort — a platform without notification
  permission must not throw into the turn path.
- **Validate:** covered by the supervisor test (status transitions) + a settings test that `{}` still
  parses with the new section; manual smoke for the native toast + click-through.

### Task 8 — Chat UI (`src/renderer/features/chat/`) + chatStore
- **What:**
  - `stores/chat.ts` (Zustand): per-workspace transcript (`turns: RenderedTurn[]`), `isBusy`,
    append-event reducer, `reset(workspaceId)`, auto-scroll/pause state.
  - `useChat(workspaceId)`: on open, `invoke('chat:history', {workspaceId})` → hydrate the store; expose
    `sendTurn(prompt, attachments, mode)` → `subscribeStream('turn:start', arg, onChunk)` appending each
    `{kind:'event'}` to the store and resolving on stream end; `interrupt()` →
    `invoke('turn:interrupt', {workspaceId})`. Unsubscribe/abort on unmount (leak discipline from
    `hooks.ts:159`).
  - `Composer.tsx`: multiline prompt, attach files/images (→ `Attachment[]`), mode selector
    (plan/default/auto-accept, gated by `harness:list` capabilities), send/interrupt button tied to
    `isBusy`. (Diff-comment attachments arrive from Phase 4 via a shared store — leave the seam.)
  - `Transcript.tsx` + renderers: streaming **text** (markdown — D3 — + `shiki` fenced code), collapsible
    `ToolCard` (tool_use/tool_result), `FileEditChip` (link to diff once Phase 4 lands), `TodoList`
    (todo_update), `ErrorCard`, `TurnDivider` (status + usage). Auto-scroll with pause-on-scroll-up.
- **Pattern:** funnel `renderer/ipc/index.ts:76`; effect+cleanup `hooks.ts`; test stub
  `AppLayout.test.tsx`; existing feature layout under `features/sidebar/`.
- **Gotcha:** all main access **only** via `@renderer/ipc` — never `window.api`/`ipcRenderer` (README
  §10). Render markdown safely — **no `dangerouslySetInnerHTML` on unsanitized agent output** (renderer
  is sandboxed but XSS-in-transcript is still real). Coalesce rapid text deltas in the store so React
  doesn't re-render per token.
- **Validate:** `node scripts/vitest-electron.mjs run src/renderer/features/chat/ChatPanel.test.tsx`
  (MockHarness-driven: streaming render, tool/todo cards, interrupt, reconstruction from history).

### Task 9 — Tests + fixtures (author with `test-author`, independent of the code author)
- **What (phase-doc §7):**
  - **Contract (primary CLI-drift defense):** record real `claude --output-format stream-json` output to
    `src/main/harness/fixtures/{text,tool_use,file_edit,error,resume}.jsonl`; `parser.test.ts` feeds each
    → asserts the normalized `AgentEvent[]` via **Vitest snapshots**. Include a fixture with an unknown
    event type → asserts it is ignored (forward-compat).
  - **Supervisor** (`supervisor.test.ts`, MockHarness): rejects concurrent turns; interrupt emits a
    terminal event + records `interrupted`; registry cleared on exit; status idle→working→
    needs_attention fires via a spy on `setStatus`.
  - **Persistence** (`turns.test.ts` + `db/repos/turns.test.ts`): event write + `chat:history`
    round-trip equals the streamed sequence; text coalescing produces fewer rows than deltas; a fresh-DB
    migration apply + idempotent re-run (extend `db/index.test.ts` coverage).
  - **Renderer** (`ChatPanel.test.tsx`, jsdom, mocked `window.api`): streaming render, tool/todo cards,
    interrupt button, reconstruction from a seeded `chat:history`.
  - **E2E** (`e2e/chat.spec.ts`, Playwright, `AGENTAPP_E2E=1` → MockHarness): send a prompt → tokens
    stream → turn ends → close+reopen → transcript reconstructs.
- **Gotcha:** main tests run under the Electron ABI but with **no Electron runtime** — inject temp DB
  paths (`openDb(tmpPath)`), never spawn a real `claude` (use `MockHarness`/fixtures). Fixtures are
  committed data — **no secrets/tokens in them** (security rule; scrub before commit).
- **Validate:** `node scripts/vitest-electron.mjs run` (the new suites) then `bash ci/harness-gates.sh`.

---

## Execution Strategy
*How `/harness-implement` should build this. `/harness-implement` reads this verbatim.*
- **Task shape:** A **large, multi-layer, heightened-scrutiny** feature — process/child-process execution
  (`claude` spawn), the IPC/preload boundary, and a DB migration all in one phase. A short parallel leaf
  group (migration+repos ∥ pure parser) then a hard sequential spine (recorder → adapter/mock →
  supervisor → shared contracts+IPC+wiring → chat UI), with a security-sensitive core. **High** complexity,
  **moderate-high** risk (process exec + migration + CLI drift; no auth/PII/payment).
- **Pattern:** **parallelization (leaf group) → prompt-chaining (spine) → evaluator-optimizer + voting
  (mandatory `code-review` + `verifier`)** — the heightened-scrutiny row of the step-4 table.
- **Agents:** parallel leaf group — `coder`(migration + schema + repos, Task 1) ∥ `coder`(parser +
  normalization, Task 2); then spine — `coder`(TurnRecorder, Task 4) → `coder`(adapter + MockHarness,
  Task 3) → `coder`(supervisor + notifications + settings, Tasks 5/7) → `coder`(shared contracts + IPC +
  main wiring, Task 6) → `frontend-designer`(chat UI, Task 8) → `test-author`(Task 9) → **`code-review` +
  `verifier` (mandatory) + a named security review** of the spawn path + IPC boundary. Restate in every
  prompt: `src/shared/**` is **append-only** and the harness contract is **already frozen — implement, do
  not reshape**; status changes go **only** through `WorkspaceManager.setStatus`; `spawn` with an arg
  array only; renderer reaches main **only** via `@renderer/ipc`.
- **Orchestration:** prefer the **team** path if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled (the
  leaf group's two owners hold disjoint files); else parallel subagents in one message. The spine is
  sequential regardless (real data dependencies). `verifier` is **mandatory** (heightened-scrutiny path).
- **Parallel decomposition + file-ownership (no two agents touch the same file):**
  - **Leaf group (parallel):** owner A → `src/main/db/migrations/0003_turns_events.ts` +
    `src/main/db/schema.ts` + `src/main/db/repos/{turns,events}.ts` + `@shared/models` DTO append; owner
    B → `src/main/harness/parser.ts` (+ fixtures dir). Disjoint; both build only on frozen contracts.
    *(The `@shared/models` append is owned by A alone to avoid concatenation conflicts.)*
  - **Spine (sequential):** recorder owner → `src/main/harness/turns.ts`; adapter owner →
    `src/main/harness/{claude-code,mock}.ts`; supervisor owner → `src/main/harness/supervisor.ts` +
    `src/main/harness/notifications.ts` + `src/main/settings/schema.ts`; IPC/wiring owner →
    `src/shared/ipc.ts` + `src/main/ipc/register.ts` + `src/main/index.ts`; UI owner →
    `src/renderer/features/chat/**` + `src/renderer/stores/chat.ts`; tests owner → all `*.test.ts(x)` +
    `e2e/`.
  - **Append-only shared files** (`src/shared/ipc.ts`, `src/shared/models.ts`) are each touched by exactly
    **one** owner (IPC/wiring owner for `ipc.ts`; leaf-owner A for `models.ts`).
- **Rationale:** the migration/repos and the pure parser are genuinely independent and both gate the
  recorder/adapter, so they fan out; recorder→adapter→supervisor→IPC→UI is a real dependency chain, so it
  chains; and because the phase spawns a child process and adds a user-disk migration (both easy to get
  subtly wrong — zombie processes, wedged "busy" status, per-token DB churn, CLI-format drift),
  `verifier` + a named security review are **mandatory**, not optional.

---

## Validation Gate
Run after all tasks (from repo root):
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: +vitest +build)
```
Manual smoke (DoD): `npm run dev` (real `claude` on PATH) → open a workspace → send a prompt → `claude`
spawns headless in the worktree, tokens stream live, tool_use/tool_result/file_edit/todo render, turn
ends cleanly → send a 2nd prompt → it **resumes** (`--resume`) and preserves context → interrupt
mid-turn → agent stops, turn recorded `interrupted`, UI recovers → close + reopen the workspace →
transcript reconstructs from `turns`+`events` → status idle→working→needs_attention→idle with a native
notification + working deep-link click-through. Then `AGENTAPP_MOCK_HARNESS=1 npm run dev` → the whole
chat UI runs with no real CLI.

## Acceptance Criteria (DoD, phase-doc §6)
- [ ] Send a prompt → `claude` spawns headless in the worktree, streams tokens live, tool/edit/todo
      render, turn ends cleanly.
- [ ] A second prompt **resumes** the same session (`--resume`) and preserves context.
- [ ] Interrupt mid-turn stops the agent and records an `interrupted` turn; UI recovers.
- [ ] Close + reopen the workspace → full chat reconstructs from `turns`+`events`.
- [ ] Status transitions idle→working→needs_attention→idle; sidebar badge + Electron notification fire
      with working deep-link click-through.
- [ ] `MockHarness` runs the whole chat UI with no real CLI (used in CI).
- [ ] Adapter **contract tests** pass against recorded stream-JSON fixtures (incl. unknown-event
      tolerance).
- [ ] Migration `0003` applies on a fresh DB and is idempotent on re-run; rollback note written.
- [ ] All Validation Gate blocking gates pass (run `/verify`).

## Open Decisions (flagged, not blocking)
- **D1 — token transport (RECOMMENDED: scoped `createStream` via a `turn:start` StreamChannel).** The
  supervisor's `startTurn` takes a `StreamSink`, and `createStream` already has microtask-batched
  soft-backpressure; with text-delta **coalescing** at the DB layer the per-frame volume is modest, and
  the existing preload/`subscribeStream` funnel supports this transport with **zero new plumbing** (mirror
  `workspace:create`). `stream.ts` notes `createMessageChannelStream` is the "right" transport for agent
  token deltas, but the preload does **not** yet receive transferred MessagePorts — using it is a separate
  preload lift. **Recommend shipping `createStream` now**; upgrade to MessageChannelMain only if profiling
  shows token throughput dominates (add the preload port-receive path then). The reserved `turn:event`
  **Event** (broadcast, `ipc.ts:117`) is left unused (it can't be removed — append-only) since a scoped
  stream gives per-turn framing, a terminal frame, backpressure, and cancel that a broadcast event does
  not. Flag if a reviewer prefers the broadcast event or the MessagePort transport up front.
- **D2 — MockHarness id.** Reuse `'claude_code'` (so a `claude_code` workspace transparently runs the mock
  in CI/dev) vs a distinct id. `HarnessId` is frozen to `'claude_code'|'codex'|'cursor'` (can't add a
  `'mock'` id without touching the frozen union). **Recommend reusing `'claude_code'`** and selecting the
  mock via `settings.agent.harnessImpl`/`AGENTAPP_MOCK_HARNESS`/`AGENTAPP_E2E`, not via a new id.
- **D3 — markdown rendering in the transcript.** No markdown dep exists; `shiki` (code) is present.
  Options: add `react-markdown`+`remark-gfm` (2 new renderer deps — conventions rule wants justification,
  and it widens the sandboxed-renderer supply chain) vs a **minimal in-house renderer** (bold/italic/
  inline-code/links/lists + `shiki` for fenced code). **Recommend the minimal in-house renderer** for
  Phase 2 (smaller attack surface, no new deps); revisit if rich markdown is needed. Either way: never
  inject unsanitized agent output as HTML.
- **D4 — needs_attention→idle mechanism.** Clearing on the `chat:history` fetch (implicit "viewed") vs a
  dedicated `workspace:markSeen` command. **Recommend the implicit clear on history fetch** for Phase 2
  simplicity; promote to an explicit command if Phase 5 needs finer "seen" semantics.

## Risks / notes
- **R1 — CLI output-format drift** (spec §9): mitigated by committed fixtures + a pinned minimum version +
  **unknown-event tolerance** (parser returns null → ignore). The contract snapshot test is the tripwire.
- **R2 — `ProcessRegistry` throws (Phase-3-owned).** Phase-2 §3.2 wants agent processes in the shared
  registry, but `src/main/process/index.ts:47` is a throwing stub until Phase 3. **Reconciliation:** the
  supervisor tracks its own `Map<workspaceId, LiveTurn>` and `quitAll()` (wired into `before-quit`) now;
  leave a `// INTEGRATION(phase-3): register agent children in the shared ProcessRegistry` seam. Do **not**
  call the throwing `ProcessRegistry` this phase.
- **R3 — diff badge (§3.6) depends on `GitService.status()` which THROWS (Phase-4 stub, `git/index.ts:632`).**
  Phase-2 §3.6 is **descoped from the DoD** (not in §6). **Recommend deferring the diff-badge count to
  Phase 4** (when the diff engine + `diff:changed` event land) rather than adding a throwaway
  `git status --porcelain` path + a new event now. If a reviewer wants it in Phase 2, add a narrow
  `GitService.changedFileCount(worktreePath)` (execa `git status --porcelain`, additive) + an append-only
  `workspace:diffBadge` event — flagged, not built by default.
- **R4 — auth detection is fuzzy across `claude` versions** (phase-doc §8): degrade to "installed, auth
  unknown; try a turn" rather than hard-blocking.
- **R5 — DB write volume from token streaming**: coalesce text deltas (better-sqlite3 is synchronous;
  per-delta writes block the event loop). Flush accumulated text periodically, non-text events flush-then-
  write. Covered by the coalescing assertion in Task 9.
- **R6 — permission requests must surface as `needs_attention`** (not silently block): map Claude Code's
  permission-prompt events to an attention state with a resumable action (full UI is Phase 6 — pass-through
  plumbing only here).

---

## Handoff
`/harness-implement plans/phase-2-harness-chat-plan.md`
