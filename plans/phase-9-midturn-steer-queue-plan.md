# Plan: Phase 9 — Mid-Turn Steer & Message Queue

## Ticket / Feature
Let a user queue/edit/reorder/delete follow-up messages while an agent turn is streaming, auto-send
the queue head when the workspace goes idle, and "steer now" (true injection if the harness supports
it, else interrupt + immediate resend). Source: `docs/implementation-plan/phase-9-midturn-steer-queue.md`.

**Feature type:** new capability. **Affected layers:** shared contract · db migration + repo · main
supervisor · IPC handlers · renderer store + UI + wiring. **Heightened-scrutiny paths touched:** DB &
migrations (`src/main/db`), IPC/preload boundary (`src/main/ipc`, `src/shared/ipc.ts`), process/turn
lifecycle (`src/main/harness/supervisor.ts`).

## Key architectural constraints (do not violate)
- **`TurnHandle` stays frozen at `{ sessionId; interrupt() }`** (`src/shared/harness.ts:34-37`). True
  injection is modeled as `SteerableTurnHandle extends TurnHandle`, detected by runtime duck-typing
  (`'steer' in handle`) — never widen `TurnHandle`.
- **`src/shared/**` is append-only.** New file `src/shared/queue.ts`; append entries to `Commands`
  (`src/shared/ipc.ts`) and to `HarnessCapabilities` / add `SteerResult` + `SteerableTurnHandle`
  (`src/shared/harness.ts`). No reorder/rename of existing entries.
- **No preload change needed.** `src/preload/index.ts` `invoke` is generic over `CommandChannel`; new
  `queue:*` / `turn:steer` commands flow through the existing bridge automatically. (Verify, don't edit.)
- **Adding a *required* field to `HarnessCapabilities` has a compile-time blast radius** — every object
  literal typed as `HarnessCapabilities` must gain `supportsMidTurnSteer`. See the Modify list; missing
  one is a `tsc -b` failure.
- **Fallback (interrupt + resend) lives in the renderer, not the supervisor** (§3.6) — main exposes only
  `steer()`, which throws a typed conflict when injection isn't possible; the renderer owns the second
  code path so main never grows an auto-start-a-turn path.

## Affected Files

### Read before implementing
- `docs/implementation-plan/phase-9-midturn-steer-queue.md` — the contract; §3.6 (supervisor semantics),
  §3.7 (IPC table + narrowing), §8 (risks: legible fallback, resume interaction, reorder race).
- `src/main/db/repos/todos.ts` (whole file) — row↔DTO convention, single-transaction replace, `AppError`
  usage. Mirror for the new queue repo.
- `src/main/db/migrations/0007_workspace_pr.ts` + `src/main/db/migrations/index.ts` — migration shape,
  registration in the ordered array, rollback note style, `PRAGMA user_version` runner.
- `src/main/db/schema.ts:128-167` — `TodosTable` shape + the `Database` interface to append to.
- `src/main/harness/supervisor.ts:239-256` — `interrupt()`/`isActive()`/`getActiveTurnId()`: mirror the
  registry lookup keyed by `workspaceId` for `steer()`.
- `src/main/harness/mock.ts` (whole file) — add the `{ steerable?: boolean }` constructor option +
  `SteerableTurnHandle` return; also its `capabilities()`.
- `src/main/ipc/register.ts:768-1105` — the `turn:interrupt` + `todo:*`/`comment:*` handler blocks:
  input-narrowing idiom, `AppError('invalid_input', …)`, `new TodosRepo(ctx.db)` inline construction.
- `src/renderer/stores/composer.ts` — per-workspace `Record<string, T>` Zustand idiom (queue store is
  DB-backed, so every mutation round-trips through IPC — differs from composer's client-only nature).
- `src/renderer/features/chat/TodoList.tsx` — minimal list-rendering style for `QueueList.tsx`.
- `src/renderer/features/chat/Composer.tsx:120-149,378-416` — the optimistic `HarnessCapabilities`
  literal (must gain the new field), the Send/Interrupt button cluster (where "Steer now" goes).
- `src/renderer/features/chat/useChat.ts:96-130` — `sendTurn` stream loop + the `finally setBusy(false)`
  terminal-frame point where auto-flush-on-idle hooks in.
- `src/renderer/stores/harness.ts` — `useSelectedHarnessCapabilities()` used to drive steer behavior.
- `src/main/harness/bench/profiles.ts:44-103` — the 3 `BENCH_PROFILES` + `MOCK_BENCH_PROFILE`
  capability literals (each needs the new field); confirm whether Phase-8 grades `supportsMidTurnSteer`
  (declared `false` = trivial `pass`, no fixture needed — see `src/main/harness/CLAUDE.md`).

### Modify
- `src/shared/harness.ts` — append `supportsMidTurnSteer: boolean` to `HarnessCapabilities`; add
  `SteerResult` type + `SteerableTurnHandle` interface (§3.5).
- `src/shared/ipc.ts` — append the 6 commands to `Commands` (§3.7 table). No new `Events`/`StreamChannels`.
- `src/main/db/schema.ts` — add `QueuedMessagesTable` + append `queued_messages` to `Database`.
- `src/main/db/migrations/index.ts` — import + register `migration0008TurnQueue` in the ordered array.
- `src/main/harness/supervisor.ts` — append `async steer(workspaceId, text): Promise<SteerResult>`.
- `src/main/harness/mock.ts` — constructor `{ steerable?: boolean }`; return `SteerableTurnHandle` +
  `supportsMidTurnSteer: true` when set; else `false`.
- `src/main/harness/claude-code.ts` (~L52), `codex.ts` (~L68), `cursor.ts` (~L74) — add
  `supportsMidTurnSteer: false` to each `capabilities()` return.
- `src/main/harness/bench/profiles.ts` — add `supportsMidTurnSteer: false` to all 3 profiles;
  `MOCK_BENCH_PROFILE` stays `false` (the shipped `claude_code` id it reuses declares `false`).
- `src/main/ipc/register.ts` — add 6 handlers (`queue:list/enqueue/update/reorder/remove`, `turn:steer`)
  in the `handle(...)` block, mirroring `todo:*` narrowing; `turn:steer` calls `ctx.harness.steer`.
- `src/renderer/features/chat/Composer.tsx` — add `supportsMidTurnSteer: false` to the optimistic
  fallback literal (~L134-139); enqueue-instead-of-block while busy; add always-visible "Steer now".
- `src/renderer/features/chat/useChat.ts` — auto-flush the queue head via `sendTurn` on transition to idle.
- **Test literals that must gain the field (tsc will flag each):**
  `src/renderer/features/chat/ChatPanel.test.tsx`, `src/renderer/stores/harness.test.ts`,
  `src/main/harness/cursor.test.ts`, `src/main/harness/codex.test.ts`,
  `src/main/harness/bench/runner.test.ts`.

### Create
- `src/shared/queue.ts` — `QueuedMessage` interface (§3.1), imports `AgentMode`/`Attachment` from `./harness`.
- `src/main/db/migrations/0008_turn_queue.ts` — `queued_messages` table + index (§3.2) + rollback note.
- `src/main/db/repos/queued-messages.ts` (+ `.test.ts`) — `QueuedMessagesRepo` (§3.2).
- `src/renderer/stores/queue.ts` (+ `.test.ts`) — DB-backed per-workspace queue store (§3.3).
- `src/renderer/features/chat/QueueList.tsx` (+ `.test.tsx`) — editable/reorderable/deletable rows (§3.4).
- (optional) `src/renderer/features/chat/useQueue.ts` — if the auto-flush wiring is cleaner as a sibling
  hook than folded into `useChat.ts`.

## Ordered Tasks

### Task 1 — Shared contract (types first; unblocks everything)
- What: create `src/shared/queue.ts` with `QueuedMessage`; append `supportsMidTurnSteer: boolean` to
  `HarnessCapabilities` and add `SteerResult` + `SteerableTurnHandle` in `src/shared/harness.ts`; append
  the 6 commands to `Commands` in `src/shared/ipc.ts`.
- Pattern: `src/shared/ipc.ts:315-325` (Phase 8 append block) for the append comment + entry style;
  `src/shared/harness.ts:34-37,68-73` for freeze discipline.
- Gotcha: `src/shared/**` must be import-safe from both processes — `queue.ts` imports only pure
  `@shared/*` types. Append-only: add, never reorder. `SteerableTurnHandle extends TurnHandle` (widens
  nothing).
- Validate: `bash ci/harness-gates.sh typecheck` (will now fail in every capability-literal site — that
  list *is* the Modify surface; Task 5 closes it).

### Task 2 — Migration + schema + repo
- What: create `0008_turn_queue.ts` (table + `idx_queued_messages_workspace`), register it in
  `migrations/index.ts`, add `QueuedMessagesTable` + `queued_messages` to `schema.ts`, implement
  `QueuedMessagesRepo` (`list/enqueue/update/reorder/remove`).
- Pattern: `src/main/db/repos/todos.ts` (row↔DTO, `AppError('not_found')`, single-transaction write);
  `0007_workspace_pr.ts` (migration shape + rollback note).
- Gotcha (heightened-scrutiny: DB): version = **8**. `enqueue` sets `orderIdx = max+1`. `reorder`
  MUST reject a non-permutation of the workspace's current ids (don't silently truncate/dup) and rewrite
  `order_idx` 0..n **in a single transaction**. Migration + rollback/back-compat note required.
- Validate: `node scripts/vitest-electron.mjs run src/main/db/repos/queued-messages.test.ts`

### Task 3 — Supervisor `steer()`
- What: append `async steer(workspaceId, text): Promise<SteerResult>` — look up the live turn; throw
  `AppError('conflict', …)` if none active OR if `!('steer' in live.handle)`; else call
  `(handle as SteerableTurnHandle).steer(text)` and return its result.
- Pattern: `supervisor.ts:239-256` (`interrupt`/`isActive` registry lookup).
- Gotcha (heightened-scrutiny: process/turn lifecycle): the injected `steer` pushes into the SAME live
  sink the open `turn:start` stream is on — no new stream. Do NOT implement the interrupt+resend fallback
  here (that's the renderer's job, §3.6). Keep the single-turn invariant intact.
- Validate: `node scripts/vitest-electron.mjs run src/main/harness/supervisor.test.ts`

### Task 4 — MockHarness steerable option
- What: constructor `{ steerable?: boolean }`; when true, `capabilities().supportsMidTurnSteer = true`
  and `startTurn` resolves a `SteerableTurnHandle` whose `steer(text)` pushes a scripted event into the
  sink and resolves `'injected'`. Default false.
- Pattern: `mock.ts:70-160` (existing handle construction + interrupt closure).
- Gotcha: this is the ONLY way Phase-9 tests exercise the true-injection path; no shipped adapter uses it.
- Validate: `node scripts/vitest-electron.mjs run src/main/harness/mock.test.ts`

### Task 5 — Close the capability-literal blast radius
- What: add `supportsMidTurnSteer: false` to `claude-code.ts`, `codex.ts`, `cursor.ts`, the 3
  `BENCH_PROFILES` + `MOCK_BENCH_PROFILE` in `bench/profiles.ts`, the `Composer.tsx` optimistic literal,
  and each flagged test literal (ChatPanel.test.tsx, harness.test.ts, cursor.test.ts, codex.test.ts,
  bench/runner.test.ts).
- Pattern: grep `rawTerminalFallback` across `src/` — every hit is a literal to update.
- Gotcha: Phase-8 bench grades a declared-`false` flag as a trivial `pass` (no fixture) — see
  `src/main/harness/CLAUDE.md` capability-evidence table; do not add a steer fixture.
- Validate: `bash ci/harness-gates.sh typecheck` (now green).

### Task 6 — IPC handlers
- What: add `queue:list/enqueue/update/reorder/remove` (each `new QueuedMessagesRepo(ctx.db)`) and
  `turn:steer` (→ `ctx.harness.steer`) to `register.ts`.
- Pattern: `register.ts:1077-1105` (`todo:*`) for narrowing + inline repo; `768-773` (`turn:interrupt`)
  for the workspaceId guard.
- Gotcha (heightened-scrutiny: IPC boundary): narrow every payload — non-empty `id`/`workspaceId`,
  `orderedIds` a string[] permutation of the workspace's current queue ids (reject otherwise),
  `turn:steer.text` a non-empty string. Never interpolate payloads into shell/git strings. No new
  `Events`/`StreamChannels`. Confirm the preload needs no edit (generic `invoke`).
- Validate: `bash ci/harness-gates.sh typecheck lint`

### Task 7 — Renderer queue store
- What: `src/renderer/stores/queue.ts` — `byWorkspace: Record<string, QueuedMessage[]>`, actions
  round-trip through `queue:*`; `steerNow(workspaceId)` pops head then calls `turn:steer` or the
  interrupt+resend fallback.
- Pattern: `stores/composer.ts` (per-workspace Record idiom); `stores/harness.ts` (invoke + graceful
  degrade). Differs from composer: DB-backed, so re-fetch/patch cache after each command.
- Gotcha: mutations are async and DB-authoritative — reflect the command response, don't optimistically
  diverge from `order_idx`.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/stores/queue.test.ts`

### Task 8 — Renderer UI + wiring
- What: `QueueList.tsx` (rows above `Composer` with inline edit / reorder / delete / per-row "Steer
  now"); `Composer.tsx` enqueues instead of blocking while `isBusy` and shows an always-visible "Steer
  now" next to Stop (capability drives *behavior*, not visibility); `useChat.ts` auto-flushes the queue
  head via `sendTurn` on the idle transition.
- Pattern: `TodoList.tsx` (list style); `Composer.tsx:394-416` (button cluster); `useChat.ts:125` (the
  `finally setBusy(false)` terminal point).
- Gotcha (§8): make the interrupt+resend fallback LEGIBLE (a "steered" marker / turn boundary) — don't
  present it as seamless injection. Fallback reuses the turn's `sessionId` via existing resume plumbing
  (context preserved for `claude_code`; `codex`/`cursor` are `supportsResume:false` → documented
  context-less degradation, not a bug). Steer-behavior branches on
  `useSelectedHarnessCapabilities().supportsMidTurnSteer`.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/chat/QueueList.test.tsx`

### Task 9 — E2E + full gate
- What: Playwright smoke (`e2e/`) — queue two messages during a mock turn, assert auto-flush order;
  separately assert "steer now" against the mock interrupts + resends. Optionally a steerable-mock E2E
  proving true injection (no interrupt).
- Validate: `bash ci/harness-gates.sh` (full) then `npm run test:e2e`.

## Execution Strategy
*How `/harness-implement` should build this. `/harness-implement` reads this verbatim.*
- **Task shape:** cross-cutting (shared → db → main → ipc → renderer) but coupled through the frozen
  shared contract; **medium-high complexity, high risk** — touches DB/migration, IPC boundary, and
  turn-lifecycle (three heightened-scrutiny paths).
- **Pattern:** prompt-chaining with an evaluator-optimizer tail. Not parallel module-ownership: two
  serialization points (`src/shared/harness.ts` and `src/shared/ipc.ts`) are edited by several "modules",
  so concurrent teammates would collide on the frozen contract files.
- **Agents:** `coder` (primary, Tasks 1→8 in order) → `test-author` (repo/supervisor/store/UI tests +
  the E2E, can start once Tasks 2–4 land) → `code-review` + `verifier` (**mandatory** — heightened-scrutiny).
- **Orchestration:** sequential single augmented `coder` for Tasks 1–8 (the contract edits force
  ordering); fan out `code-review` + `verifier` as parallel subagents at the end (prefer team if
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled, else parallel subagents).
- **Parallel decomposition + file-ownership:** the only safe parallelism is Task 9 E2E authoring
  (test-author owns `e2e/**`) running alongside Task 7/8 renderer work (coder owns `src/renderer/**`),
  because they share no files. Everything upstream of Task 6 must be serial through the shared contract.
- **Rationale:** the compile-time coupling introduced by a required `HarnessCapabilities` field + two
  frozen-map edits makes a single ordered builder cheaper and safer than coordinating teammates around
  shared-contract merge conflicts; the mandatory verifier covers the three heightened-scrutiny paths.

## Validation Gate
Run after all tasks (from repo root):
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: tsc -b + eslint + vitest + build)
npm run test:e2e                                  # Playwright smoke (Task 9)
```

## Acceptance Criteria
- [ ] Enqueue N messages while a turn streams; each is an editable, reorderable, deletable row.
- [ ] Queue is DB-backed and survives app restart (enqueue → quit → relaunch → present, in order).
- [ ] On idle after a turn ends, the queue head auto-sends as the next turn, in order.
- [ ] "Steer now" degrades to interrupt+immediate-resend for every shipped harness (`claude_code`,
      `codex`, `cursor`), proven by a test that the fallback fires when `supportsMidTurnSteer === false`.
- [ ] "Steer now" performs true injection (no interrupt) when `MockHarness` is `steerable: true`.
- [ ] `supervisor.steer` throws a typed `conflict` (never a silent no-op) with no active/steerable turn.
- [ ] `reorder` rejects a non-permutation input and is atomic w.r.t. dequeue-head (reorder-race test).
- [ ] `src/shared/**` changes are append-only; `TurnHandle` unchanged; renderer hardening intact; preload
      unedited.
- [ ] Migration 0008 ships with a rollback/back-compat note.
- [ ] All Validation Gate blocking gates pass (run /verify).
```

**Handoff:** `/harness-implement plans/phase-9-midturn-steer-queue-plan.md`
