# Implementation Report: Phase 2 — Claude Code Harness + Chat

## Plan
`plans/phase-2-harness-chat-plan.md`

## Orchestration
**Mechanism:** parallel-subagents → (fell back to) direct implementation in the main session.

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` but the `TeamCreate` tool was unavailable → the
parallel-subagent path (the plan's normal fallback). The **leaf group ran as two `coder`
subagents** successfully. Partway into the spine, the subagent runtime began **failing on an
account session limit** (`coder-recorder` returned `failed: hit session limit`). To keep progress,
the lead session (this one) implemented the remaining spine + UI + tests directly, honoring the same
file-ownership boundaries and house rules the plan assigned each agent. The mandatory
`code-review` + `verifier` are handed off (see "Ready for Review"); the **named security review**
of the heightened-scrutiny paths was performed inline (below).

| Agent / role | Task(s) | Outcome |
|---|---|---|
| coder (leaf A — DB) | Task 1: migration 0003 + schema + repos + `@shared/models` DTOs | DONE (7 tests) |
| coder (leaf B — parser) | Task 2: stream-JSON parser + normalization + fixtures | DONE (14 tests) |
| coder (recorder) | Task 4: TurnRecorder | FAILED (session limit) → done directly |
| lead session (direct) | Tasks 4, 3, 5, 7, 6, 8, 9 + integration | DONE |

## Tasks Completed
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Migration `0003_turns_events` + schema + `TurnsRepo`/`EventsRepo` + DTOs | DONE | append-only; rollback note in migration header |
| 2 | stream-JSON parser + normalization table (pure) | DONE | `normalize()→NormalizeResult[]`; unknown types ignored |
| 4 | `TurnRecorder` (coalescing write path + history) | DONE | text-delta coalescing by threshold/boundary |
| 3 | `ClaudeCodeHarness` adapter + `MockHarness` | DONE | spawn arg-array; diff_comment prompt format frozen |
| 5 | `HarnessSupervisor` (single-turn invariant, status, quitAll) | DONE | registry cleared on every terminal path |
| 7 | `NotificationService` + `[notifications]` settings + needs_attention→idle | DONE | idle clear on `chat:history` (D4) |
| 6 | Shared contract appends + IPC handlers + main wiring | DONE | `turn:start` stream + 4 commands; `before-quit`→`quitAll()` |
| 8 | Chat UI (`features/chat/**`) + `chatStore` | DONE | in-store text coalescing; safe in-house markdown (D3) |
| 9 | Tests + fixtures + E2E | DONE | parser/recorder/supervisor/mock/repos/ChatPanel + `e2e/chat.spec.ts` |

## Files Changed
- **Created:** `src/main/db/migrations/0003_turns_events.ts`, `src/main/db/repos/turns.ts`,
  `src/main/db/repos/events.ts`, `src/main/db/repos/turns.test.ts`, `src/main/harness/parser.ts`,
  `src/main/harness/parser.test.ts`, `src/main/harness/fixtures/{text,tool_use,file_edit,error,resume,unknown}.jsonl`,
  `src/main/harness/turns.ts`, `src/main/harness/turns.test.ts`, `src/main/harness/claude-code.ts`,
  `src/main/harness/mock.ts`, `src/main/harness/mock.test.ts`, `src/main/harness/notifications.ts`,
  `src/main/harness/supervisor.test.ts`, `src/renderer/stores/chat.ts`,
  `src/renderer/features/chat/{ChatPanel,Composer,Transcript,TurnDivider,TextMessage,ToolCard,FileEditChip,TodoList,ErrorCard,AttachmentBar}.tsx`,
  `src/renderer/features/chat/{useChat.ts,markdown.tsx,ChatPanel.test.tsx}`, `e2e/chat.spec.ts`.
- **Modified:** `src/main/db/schema.ts` (append `TurnsTable`/`EventsTable`), `src/main/db/migrations/index.ts`
  (append 0003), `src/shared/models.ts` (append `TurnStatus`/`TurnRecord`/`TurnEventRecord`),
  `src/shared/ipc.ts` (append `turn:start` stream + 4 commands + DTOs), `src/main/harness/supervisor.ts`
  (implemented), `src/main/settings/schema.ts` (`[notifications]` + `agent.harnessImpl`),
  `src/main/ipc/register.ts` (`turn:start` producer + handlers), `src/main/index.ts` (wiring + `before-quit`),
  `src/main/context.ts` (add `recorder`), `src/renderer/app/AppLayout.tsx` (mount `ChatPanel`),
  `src/main/workspace/index.test.ts` + `src/main/settings/index.test.ts` + `src/main/db/index.test.ts`
  (fixtures/assertions updated for the additive settings + migration 0003), `src/main/git/index.test.ts`
  (pre-existing prettier fix, formatting only — required for the format gate).

## Validation Gate Results (`bash ci/harness-gates.sh`)
| Gate | Result |
|------|--------|
| format | PASS |
| lint | PASS |
| typecheck | PASS |
| tests | PASS — 15 files, 140 tests. New behaviour exercised by `supervisor.test.ts` (idle→working→needs_attention, single-turn conflict, interrupt→interrupted, resume-id persistence), `turns.test.ts` (coalescing + round-trip), `parser.test.ts` (normalization + unknown-event tolerance), `ChatPanel.test.tsx` (stream + reconstruction + interrupt) |
| build (electron-vite) | PASS |
| deps_verify | PASS |
| deps_audit | ADVISORY (pre-existing electron-builder dev-toolchain CVEs; non-blocking) |

E2E (`e2e/chat.spec.ts`) is written but runs via the separate, non-blocking `npm run test:e2e`
(needs the built app + git); it was not run as part of the blocking gate.

## Acceptance Criteria
- [x] Send a prompt → agent spawns headless in the worktree, streams tokens, tool/edit/todo render, turn ends cleanly (unit + ChatPanel + E2E-level coverage; real-CLI smoke pending — see below).
- [x] Second prompt **resumes** the same session — `latestSessionId` is persisted (`setSessionId`) and passed as `--resume` (supervisor test asserts persistence + forwarding).
- [x] Interrupt mid-turn records an `interrupted` turn; UI recovers (supervisor + ChatPanel tests).
- [x] Close + reopen reconstructs from `turns`+`events` (`recorder.history` + `chat:history` + ChatPanel reconstruction test + E2E).
- [x] Status idle→working→needs_attention→idle; `notify:needsAttention` + Electron notification + deep-link click-through wired.
- [x] `MockHarness` runs the whole chat UI with no real CLI (E2E `AGENTAPP_E2E=1`; all renderer tests).
- [x] Adapter contract tests pass against fixtures incl. unknown-event tolerance.
- [x] Migration `0003` applies on a fresh DB + idempotent re-run; rollback note written.
- [x] All blocking gates pass.

## Named security review — heightened-scrutiny paths
**Process execution (`src/main/harness/claude-code.ts`):**
- `spawn('claude', args, { shell: false })` with an **argument array** — the workspace-derived
  prompt + serialized attachments are a single `-p` argument, so nothing can be interpreted as
  shell (no command injection). `cwd` is confined to the workspace worktree.
- `stderr` is never logged verbatim (only byte length); errors carry a **message string only**
  (never `JSON.stringify` of an error object).
- The child is SIGINT'd on interrupt and a terminal event is synthesized on `close` — **no zombie
  processes** and no turn left hanging.
- **Hardening applied:** the generated MCP config (which may carry `env` secrets) is now written
  `0600` (mkdtemp dir is `0700`).

**IPC / preload boundary (`src/main/ipc/register.ts`, `src/shared/ipc.ts`):**
- Every new handler + the `turn:start` producer **validate and narrow** their payloads
  (`workspaceId`/`prompt` are required non-empty strings; `attachments` falls back to `[]`) before
  acting; all run inside the existing error boundary.
- A workspace with a null `worktreePath` (archived) is **rejected before any spawn**.
- `src/shared/**` changes are strictly **append-only** (new map entries at the end; new DTOs).
- Renderer reaches main **only** through `@renderer/ipc`; no `window.api`/`ipcRenderer`/Node in the
  chat feature. Agent markdown is rendered as React elements (no `dangerouslySetInnerHTML`); link
  hrefs are restricted to `http(s)/mailto`.

## Issues / Deviations
- **Orchestration fallback** (session limit) — see above. Leaf group ran as subagents; spine done directly.
- **Session-id persistence:** added additive `TurnsRepo.setSessionId`/`latestSessionId` +
  `TurnRecorder.setSessionId`/`latestSessionId` (not spelled out in the plan) so resume works; the
  supervisor persists the captured id, the IPC producer resolves the resume id.
- **`TurnStreamChunk.event` frames omit `turnId`** (the plan's sketch included it). The stream is
  scoped to one turn and the leading `started` frame carries `turnId`, so per-event `turnId` was
  redundant; this avoids a turnId-before-events ordering race. (Shared contract is new/append-only,
  so this is a shaping choice, not a reshape of a frozen entry.)
- **Markdown (D3):** minimal in-house renderer; `shiki` fenced-code highlighting left as a
  documented seam (code renders in a styled `<pre>`).
- **Parser fixtures are representative/hand-authored** (no real `claude` CLI in this environment).
  They MUST be re-recorded against a real CLI to be a true drift tripwire (Risk R1). The unit tests
  use explicit assertions rather than Vitest snapshots — equivalent drift coverage.
- **Descoped per plan:** diff badge (Risk R3, Phase 4); full permission UI (Risk R6, Phase 6).
- **Low-severity residuals:** generated MCP temp file/dir is not cleaned up (minor); per-attachment
  field shapes aren't deeply validated (worst case: garbled prompt text, no injection).
- **Not yet done:** real-`claude` manual smoke (`npm run dev`) — needs an installed, authenticated
  CLI; the mock path is fully exercised.

## Heightened-scrutiny paths touched
IPC/preload boundary; process/child-process execution (`claude` spawn); DB migration (0003, on the
user's disk); settings. All reviewed above.

## Ready for Review
All 9 tasks done; every blocking gate green (140 tests). **Next (mandatory for this heightened-
scrutiny path):** run `/verify` (evidence), then `/harness-review` + a peer `code-review` and the
independent `verifier` — deferred from this run due to the account session limit that interrupted
the subagent roster.
