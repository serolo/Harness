# Phase 2 — Claude Code Harness + Chat (Electron)

> **Read [`README.md`](./README.md) (esp. §6.3 Harness interface) first.**

**Spec refs:** §2.2 (process model), §3 (turns/events), §4 (harness abstraction), §4.2 (Claude Code adapter), §5.1 (status machine), §5.8 (notifications), §8 (M2).
**Estimated size:** ~2 weeks. **Depends on:** Phase 0, Phase 1. **Blocks:** Phase 4 "send to agent", Phase 5 agent-prompt actions, Phase 7 (other adapters).
**Parallelizable with:** Phase 3.

---

## 1. Goal

Drive a real turn loop against the user's installed `claude` CLI: spawn headless with stream-JSON via
`child_process`, normalize its output into the frozen `AgentEvent` stream, persist turns+events (so
chat is reconstructable and archivable), manage agent process lifecycle via `HarnessSupervisor`, and
render a first-class chat UI with attachments, tool/edit/todo rendering, interrupt, and resume. Ship a
`MockHarness` for testing. Wire the status machine and `needs_attention` notifications.

---

## 2. Scope

**In scope**
- `Harness` implementation for Claude Code (`src/main/harness/claude-code.ts`) per README §6.3 + spec §4.2.
- `HarnessSupervisor`: one active turn per workspace, spawn/resume/interrupt, process registry,
  survive UI navigation, graceful interrupt on quit.
- stream-JSON parser → `AgentEvent` normalization; **contract tests against recorded fixtures**.
- Turn/event persistence (`turns`, `events`); chat reconstruction on workspace open.
- Attachment model (files, images, **diff comments** — format frozen here for Phase 4).
- Status machine transitions driven by turn lifecycle; `needs_attention` on end/error/permission.
- Chat UI: composer (prompt + attachments + mode selector), streaming transcript, interrupt, resume.
- Native notifications (Electron `Notification`) on `needs_attention` / turn completion (configurable).
- `MockHarness` (deterministic scripted events) used by all later UI/E2E tests.

**Out of scope**
- Diff rendering (Phase 4) — but `file_edit` events + `git status` polling drive a **diff badge** count.
- Permission-policy UI depth and MCP config UI (Phase 6) — pass-through plumbing only.
- Checkpoints (Phase 4) — but emit `turn_end` cleanly so Phase 4 can snapshot on it.

---

## 3. Task breakdown

### 3.1 Claude Code adapter (`src/main/harness/claude-code.ts`)
- `detect()`: run `claude --version` (via `execa`); parse; probe auth (cheap status/`--help` or login
  state). Return `{ installed, version, authenticated }`. Pin a **minimum version**; warn on older.
- `startTurn()` (spec §4.2):
  - `child_process.spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose'], {
    cwd: workspaceDir, env })`. Add `--resume <sessionId>` when `opts.sessionId` set. Map `opts.mode`
    (plan/default/auto_accept) and `opts.permissionPolicy` to Claude Code flags/settings; write MCP
    config to a generated `.mcp.json` (or CLI flag) from `opts.mcpConfig`.
  - Attachments: serialize per §3.4 and inject (files/images via prompt refs or supported flags; diff
    comments as a structured text block appended to the prompt — **this exact format is the contract
    for Phase 4**).
  - Read stdout as line-delimited JSON (a `readline`/split transform) → parse each object → normalize
    to `AgentEvent` → push to the `StreamSink<AgentEvent>`. Capture the session id from the init/system
    event → set on `TurnHandle`.
  - `interrupt()`: send SIGINT to the child; ensure a terminal `turn_end`/`error` is still emitted.
- **Normalization table** (document in-file): map each Claude stream-JSON event type →
  `AgentEvent{ text | tool_use | tool_result | file_edit | todo_update | turn_end | error }`. Unknown
  types → log + ignore (forward-compat, spec §9 CLI-drift risk).

### 3.2 HarnessSupervisor (`src/main/harness/supervisor.ts`)
```ts
class HarnessSupervisor {
  startTurn(workspaceId: string, prompt: string, attachments: Attachment[], mode: AgentMode | undefined,
            sink: StreamSink<AgentEvent>): Promise<void>;
  interrupt(workspaceId: string): Promise<void>;
  isBusy(workspaceId: string): boolean;
  shutdownAll(): Promise<void>;   // on app quit
}
```
- Registry `Map<workspaceId, LiveTurn>` (child handle, session id, abort). Reject a new turn while one
  is active (`AppError{code:'conflict'}`). Persist the resolved `sessionId` on workspace/turn for
  resume. On process exit, finalize the turn + fire the status transition.
- Register each spawned agent process in the shared **ProcessRegistry** (Phase 1 archive hook / Phase 3
  owner) so archive/quit can stop it.

### 3.3 Persistence & the streaming write path
- On `startTurn`: insert a `turns` row (`idx` = next per workspace, `status=streaming`).
- For each `AgentEvent`: insert an `events` row (`kind`, `payloadJson`, `ts`) **and** forward to the
  renderer via the stream sink. Batch/coalesce text deltas to avoid per-token DB churn (better-sqlite3
  is sync — write coalesced chunks, e.g. accumulated text flushed periodically). On `turn_end`/`error`:
  set turn `status` + `endedAt`.
- **Chat reconstruction:** `chat:history(workspaceId)` reads `turns`+`events` and rebuilds the
  transcript (what makes archive/restore of conversations work, spec §3).

### 3.4 Attachment model (frozen contract — `src/shared/harness.ts`)
Defined in README §6.3 (`Attachment` union). This phase also defines the **prompt serialization** — the
exact textual block the agent sees for a `diff_comment` (file, line range, excerpt, body). Document it
in-file; Phase 4's "Send to agent" produces `diff_comment` attachments against this contract.

### 3.5 Status machine wiring
- Turn start → `setStatus('working')`. Clean turn end → `needs_attention` (spec §5.1) → back to `idle`
  when the user views it / sends next turn. Error or permission request → `needs_attention` with
  reason. Use `WorkspaceManager.setStatus` only.

### 3.6 Diff badge (pre-Phase-4)
- After `file_edit` events / on `turn_end`, debounced, run `git status --porcelain` (GitService) to
  compute changed-file count → sidebar diff badge. Phase 4 replaces the count with the full diff engine
  but keeps the badge.

### 3.7 Notifications
- Electron `Notification` on `needs_attention` and (configurable) turn completion / errors.
  Click-through uses the deep link `harness://workspace/<id>` (handler from Phase 0). Respect a
  settings toggle.

### 3.8 Chat UI (`src/renderer/features/chat/`)
- **Composer:** multiline prompt, attach files/images, mode selector (plan/default/auto-accept gated by
  harness capability), send/interrupt. Diff-comment attachments arrive from Phase 4 via a shared store.
- **Transcript:** render each `AgentEvent` kind — streaming text (markdown + Shiki code), collapsible
  tool_use/tool_result cards, file_edit chips (link to diff once Phase 4 lands), todo updates, errors.
  Turn dividers with status + usage.
- **State:** subscribe to the per-turn stream (`subscribeStream`); append to a Zustand `chatStore`;
  reconstruct from `chat:history` on open. Auto-scroll with pause-on-scroll-up.
- Busy/idle affordances tie to `isBusy`/status.

### 3.9 MockHarness (`src/main/harness/mock.ts`)
- Config-driven scripted `AgentEvent` sequences with timing; used by renderer/E2E tests and later
  phases. Selectable via settings/env so the whole app runs without a real CLI in CI/dev.

---

## 4. Data model owned by this phase
- Migration `0003_turns_events`: `turns`, `events` per spec §3 (+ index `events(turn_id)`,
  `turns(workspace_id, idx)`).

## 5. IPC surface added
- Commands: `turn:start(workspaceId, prompt, attachments, mode)` (streamed `AgentEvent`),
  `turn:interrupt(workspaceId)`, `chat:history(workspaceId)`, `harness:detect(id)`, `harness:list()`.
- Streams: `AgentEvent` per turn (via `createStream`/`MessageChannelMain`).
- Events: `notify:needsAttention`; `workspace:status` transitions from turn lifecycle.

## 6. Definition of Done
- [ ] Send a prompt in a workspace → `claude` spawns headless in the worktree, streams tokens live into
      the chat, tool_use/tool_result/file_edit/todo render, turn ends cleanly.
- [ ] Second prompt **resumes** the same session (`--resume`) and preserves context.
- [ ] Interrupt mid-turn stops the agent and records an `interrupted` turn; UI recovers.
- [ ] Close + reopen the workspace → full chat reconstructs from `turns`+`events`.
- [ ] Status transitions idle→working→needs_attention→idle; sidebar + Electron notification fire with
      working deep-link click-through.
- [ ] `MockHarness` runs the whole chat UI with no real CLI (used in CI).
- [ ] Adapter **contract tests** pass against recorded stream-JSON fixtures.
- [ ] `npm run check` green.

## 7. Tests
- **Contract:** recorded `claude --output-format stream-json` fixtures (simple text, tool use, file
  edits, error, resume) → parser → assert normalized `AgentEvent` snapshots (Vitest snapshots). Primary
  defense against CLI drift (spec §9).
- Supervisor: rejects concurrent turns; interrupt emits terminal event; process registered/deregistered.
- Persistence: event write + `chat:history` round-trip equals the streamed sequence.
- Renderer (MockHarness): streaming render, tool/todo cards, interrupt, reconstruction.

## 8. Risks / notes
- **CLI output format drift** — fixtures + version pin + unknown-event tolerance (spec §9).
- **Auth detection** is fuzzy across `claude` versions — degrade to "installed, auth unknown; try a
  turn" rather than hard-blocking.
- **DB write volume** from token streaming — coalesce text deltas (better-sqlite3 is synchronous;
  frequent tiny writes block the event loop). Flush accumulated text periodically, not per-delta.
- **Permission requests** must surface as `needs_attention` (not silently block) — map Claude Code's
  permission-prompt events to an attention state with a resumable action (full UI in Phase 6).
- **Line-buffering stdout:** ensure the JSON stream is split on newlines with partial-line buffering;
  large tool outputs can exceed a single chunk.
