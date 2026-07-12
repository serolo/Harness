# Phase 9 — Mid-Turn Steer & Message Queue

> **Read [`README.md`](./README.md) (esp. §6.2 IPC contract, §6.3 Harness interface) first.**

**External reference:** [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent)
`docs/QUEUE_STEER_DESIGN.md`.

**Estimated size:** ~1–1.5 weeks. **Depends on:** Phase 2 (chat/turn plumbing), Phase 8
(conformance bench — lands the discipline of asserting capability flags against real evidence,
so this phase's new `supportsMidTurnSteer` flag has a bench profile from day one). **Parallelizable
with:** Phase 10 (no shared files besides `src/shared/harness.ts`, additive on both sides).

---

## 1. Goal

Let a user keep typing while an agent turn is in progress instead of being blocked until it
finishes: queue follow-up messages, edit/reorder/delete them before they're sent, have the queue
head auto-send once the workspace goes idle, and force a message through immediately ("steer
now") when they don't want to wait.

**Key architectural finding that shapes this whole phase:** none of our three current adapters
support true mid-turn message injection. `claude-code.ts` and `codex.ts` are one-shot
`child_process.spawn` calls per turn (headless `-p` / `exec --json`); the frozen `TurnHandle`
(`src/shared/harness.ts:34-37`) exposes only `{ sessionId; interrupt() }` — there is no
`send()`/`inject()` method, and that shape is explicitly pinned ("carries only `{ sessionId;
interrupt() }`"). So for every harness we ship today, "steer now" necessarily degrades to
**interrupt the active turn, then immediately start a new turn** using the existing
`sessionId`/resume plumbing with the queued text as the new prompt. True in-turn injection is
modeled as an **additive, optional** capability so a future adapter (or `MockHarness`, for test
coverage) can support it later without touching the frozen `TurnHandle` shape.

---

## 2. Scope

**In scope**
- A durable, per-workspace message queue (survives app restart) with edit/reorder/delete on
  still-unsent items.
- Auto-flush: when a workspace's active turn ends and the workspace goes idle, the queue head is
  automatically sent as the next turn.
- "Steer now": force-send the head immediately. Capability-aware — true injection only if the
  active `TurnHandle` supports it; otherwise interrupt + immediate resend.
- `supportsMidTurnSteer` added to `HarnessCapabilities`; every current adapter declares `false`.
- `MockHarness` gains an opt-in constructor flag so tests can exercise the true-injection path
  even though no shipped adapter uses it yet.

**Out of scope**
- Making any real adapter (`claude-code.ts`/`codex.ts`/`cursor.ts`) actually support true
  injection — that's a future adapter-specific change, gated behind its own capability-flag flip
  and bench evidence (Phase 8), not part of this phase.
- Any server-side/multi-device queue sync (omnigent's own design uses `localStorage`; ours is
  fully local/DB-backed, single device — no sync surface is being built here).
- Changing `TurnHandle`'s frozen 2-field shape.

---

## 3. Task breakdown

### 3.1 Shared queue types (`src/shared/queue.ts`, new file, append-only)

```ts
import type { AgentMode, Attachment } from './harness';

export interface QueuedMessage {
  id: string; // UUIDv7
  workspaceId: string;
  prompt: string;
  attachments: Attachment[];
  mode?: AgentMode;
  orderIdx: number; // 0-based, contiguous per workspace
  createdAt: number; // epoch millis
}
```

### 3.2 Migration + repo (`src/main/db/migrations/NNNN_turn_queue.ts`,
`src/main/db/repos/queued-messages.ts` + `.test.ts`)

Confirm the next free migration number against `src/main/db/migrations/index.ts` at
implementation time (existing: `0001, 0003, 0005, 0006, 0007`).

```sql
CREATE TABLE queued_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  prompt TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT,
  order_idx INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_queued_messages_workspace ON queued_messages(workspace_id, order_idx);
```

Repo mirrors `src/main/db/repos/todos.ts`'s row↔DTO convention:

```ts
export interface QueuedMessagesRepo {
  list(workspaceId: string): QueuedMessage[];
  enqueue(msg: Omit<QueuedMessage, 'orderIdx'>): QueuedMessage; // orderIdx = current max + 1
  update(id: string, patch: Partial<Pick<QueuedMessage, 'prompt' | 'attachments' | 'mode'>>): QueuedMessage;
  reorder(workspaceId: string, orderedIds: string[]): void; // rewrites order_idx 0..n
  remove(id: string): void;
}
```

### 3.3 Renderer store (`src/renderer/stores/queue.ts` + `.test.ts`)

Zustand store, per-workspace `QueuedMessage[]`, DB-backed via IPC — mirrors the per-workspace
`Record<string, T>` idiom already used in `stores/composer.ts`, but every mutation round-trips
through `queue:*` commands instead of being purely client-local.

```ts
interface QueueState {
  byWorkspace: Record<string, QueuedMessage[]>;
  load(workspaceId: string): Promise<void>;
  enqueue(workspaceId: string, prompt: string, attachments: Attachment[], mode?: AgentMode): Promise<void>;
  update(id: string, patch: Partial<QueuedMessage>): Promise<void>;
  reorder(workspaceId: string, orderedIds: string[]): Promise<void>;
  remove(id: string): Promise<void>;
  steerNow(workspaceId: string): Promise<void>; // pop head, call turn:steer or interrupt+resend
}
```

### 3.4 Renderer UI (`src/renderer/features/chat/QueueList.tsx` + `.test.tsx`)

Renders queued items as editable/reorderable/deletable rows above `Composer`, mirroring
`TodoList.tsx`'s minimal list-rendering style. Each row: inline edit (click to edit prompt text),
drag-or-button reorder, delete affordance, and a per-row "Steer now" action that sends *that*
item immediately (not necessarily the head) — moving it to the front and triggering the same
steer path.

### 3.5 Additive capability + steerable-handle types (`src/shared/harness.ts`, append)

```ts
export interface HarnessCapabilities {
  supportsResume: boolean;
  supportsMcp: boolean;
  supportsPlanMode: boolean;
  rawTerminalFallback: boolean;
  supportsMidTurnSteer: boolean; // NEW — every adapter must declare this
}

export type SteerResult = 'injected' | 'rejected';

/**
 * Optional — a TurnHandle MAY additionally satisfy this if the CLI supports genuine mid-turn
 * message injection. Checked via runtime duck-typing (`'steer' in handle`), never widens the
 * frozen 2-field TurnHandle contract itself.
 */
export interface SteerableTurnHandle extends TurnHandle {
  steer(text: string): Promise<SteerResult>;
}
```

**Task:** add `supportsMidTurnSteer: false` to every current adapter's `capabilities()` return
(`claude-code.ts`, `codex.ts`, `cursor.ts`). `MockHarness` gets a constructor option
(`{ steerable?: boolean }`) that, when true, returns a `SteerableTurnHandle` from `startTurn` and
reports `supportsMidTurnSteer: true` — this is how Phase 9's own tests exercise the true-injection
path without any real adapter supporting it yet.

### 3.6 Supervisor (`src/main/harness/supervisor.ts`, append method)

```ts
async steer(workspaceId: string, text: string): Promise<SteerResult>;
```

Mirrors `interrupt()`'s shape (look up the live turn keyed by `workspaceId`): throws a typed
`AppError('conflict', ...)` if no turn is active, or if the live turn's handle does not implement
`steer` (duck-typed check) — in that conflict case, the **renderer** is responsible for the
fallback (interrupt then immediately start a new turn with the same text), not the supervisor;
keeping the fallback client-side avoids adding a second "auto-start-a-turn" code path inside main.

### 3.7 IPC (`src/shared/ipc.ts` append, `src/main/ipc/register.ts` append)

| Channel | Kind | Request | Response |
|---|---|---|---|
| `queue:list` | command | `{ workspaceId }` | `QueuedMessage[]` |
| `queue:enqueue` | command | `{ workspaceId, prompt, attachments, mode? }` | `QueuedMessage` |
| `queue:update` | command | `{ id, prompt?, attachments?, mode? }` | `QueuedMessage` |
| `queue:reorder` | command | `{ workspaceId, orderedIds: string[] }` | `void` |
| `queue:remove` | command | `{ id }` | `void` |
| `turn:steer` | command | `{ workspaceId, text }` | `SteerResult` |

Handlers mirror the existing `todo:*`/`comment:*` blocks in `register.ts` for input narrowing
(non-empty ids, `orderedIds` must be a permutation of the workspace's current queue ids —
reject otherwise rather than silently truncating/duplicating).

**No new stream channel is needed.** A true-injection `steer()` call pushes events into the
**same** live sink the renderer's already-open `turn:start` stream subscription is listening to.

### 3.8 Renderer wiring (`useChat.ts` or a sibling `useQueue.ts`, `Composer.tsx`)

- Extend the turn-completion observer (already present at `useChat.ts`'s terminal-frame handling)
  to check the workspace's queue and auto-send the head via the existing `sendTurn` path once the
  workspace transitions to idle.
- `Composer.tsx`: while `isBusy`, typing + "Send" calls `queue:enqueue` instead of blocking; add a
  "Steer now" secondary action always visible next to Stop (capability drives *behavior*, not
  visibility) — if `useSelectedHarnessCapabilities().supportsMidTurnSteer`, call `turn:steer`;
  else call `turn:interrupt`, wait for the resulting terminal frame, then call `sendTurn`
  immediately with the queued text.

---

## 4. Data model owned by this phase

| Table | Columns | Notes |
|---|---|---|
| `queued_messages` | `id, workspace_id, prompt, attachments_json, mode, order_idx, created_at` | New migration, see §3.2. |

---

## 5. IPC surface added

- Commands: `queue:list`, `queue:enqueue`, `queue:update`, `queue:reorder`, `queue:remove`,
  `turn:steer` (table in §3.7).
- Events: none new — queue state changes are read back via the command responses; the renderer
  store re-fetches/updates its own cache rather than needing a broadcast (single-device, no
  cross-window sync requirement in this phase).
- Streams: none new (reuses the existing `turn:start` stream).

---

## 6. Definition of Done

- [ ] A user can enqueue N messages while a turn is streaming; each appears as an editable,
      reorderable, deletable row.
- [ ] The queue is DB-backed and survives an app restart (verify: enqueue, quit, relaunch, queue
      still present in order).
- [ ] When the workspace's active turn ends and it goes idle, the queue head auto-sends as the
      next turn, in order.
- [ ] "Steer now" degrades to interrupt+immediate-resend for every currently-shipped harness
      (`claude_code`, `codex`, `cursor`), verified by a test that the fallback path actually
      fires when `supportsMidTurnSteer` is `false`.
- [ ] "Steer now" performs true injection (no interrupt) when `MockHarness` is configured
      `steerable: true`.
- [ ] `bash ci/harness-gates.sh` green.

---

## 7. Tests

- `queued-messages.test.ts` — repo CRUD, `reorder` correctness (contiguous 0..n rewrite, rejects
  a non-permutation input).
- `supervisor.test.ts` (extended) — `steer()` against a steerable `MockHarness` (asserts
  `'injected'`), and against a non-steerable one (asserts the typed conflict error, never a
  silent no-op).
- `stores/queue.test.ts` — auto-flush-on-idle ordering (head sent first, queue advances).
- `features/chat/QueueList.test.tsx` — edit/reorder/delete interactions, steer-now button wiring
  to the capability-aware path.
- Playwright smoke test (`e2e/`): queue two messages while a mock turn streams, confirm order on
  auto-flush; separately, confirm "steer now" against the mock harness interrupts and resends
  immediately.

---

## 8. Risks / notes

- **Don't let the fallback path look broken.** Interrupt-then-resend is a real turn boundary
  (new `turnId`, possibly a visible gap in the transcript) — the UI should make this legible
  (e.g. a small "steered" marker in the transcript) rather than presenting it as seamless
  in-turn injection it isn't, for every harness that lacks `supportsMidTurnSteer`.
- **Queue vs. session resume interaction:** the resend-after-interrupt path should reuse the
  turn's `sessionId` (via existing `--resume` plumbing) so context isn't lost — verify this
  explicitly for `claude_code`, since `codex`/`cursor` don't support resume at all
  (`supportsResume: false`) and the queued text becomes a fresh, context-less turn there; this is
  an acceptable, but documented, degradation — not a bug to "fix" in this phase.
- **Reorder race:** if a user reorders the queue at the exact moment auto-flush fires, the repo's
  `reorder`/dequeue-head operations must be effectively atomic (single transaction) so the wrong
  item never gets sent — cover with a targeted test, not just manual QA.
