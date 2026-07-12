# Phase 11 — Cross-Workspace Multi-Agent Dispatch (human-click only)

> **Read [`README.md`](./README.md) (esp. §4 phase map, §6.3 Harness interface) and
> [`phase-10-policy-engine.md`](./phase-10-policy-engine.md) first — this phase is a
> `PolicyEngine` client, not a new safety mechanism.**

**External reference:** [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent)
`examples/polly/config.yaml` (the "Polly" pattern: one orchestrator agent dispatches sub-tasks to
other agents, each in its own git worktree, communicating via a fire-and-forget dispatch + async
inbox, with optional cross-vendor review — human always merges).

**Estimated size:** ~2–3 weeks for 4a as scoped below. **Depends on:** Phase 1 (`WorkspaceManager`
— worktree creation), Phase 5 (`pr:*` prepare-turn pattern this reuses), Phase 10 (`PolicyEngine`
— gates `spawnBounds`/`purposeAllowlist`). **4b (see §9) is explicitly not scheduled.**

---

## 1. Required reading before implementing: the non-goal tension

`docs/parallel-agents-spec.md:30` states, as a documented non-goal: **"Building our own agent —
we orchestrate existing CLIs."** A naive reading of "let one agent dispatch work to other
agents" sounds like exactly the thing that line rules out. This phase is scoped specifically to
stay on the right side of it, via three concrete facts:

1. **Every dispatched "sub-agent" is nothing more than an ordinary workspace turn.** Same
   `Harness` interface, same `HarnessSupervisor.startTurn`, same single-turn-per-workspace
   invariant, same worktree isolation, same checkpoint/checks/policy machinery every other turn
   in this app already goes through. Dispatch is glue *between* existing per-workspace turns —
   structurally identical to how `pr:fixReviews`/`pr:fixChecks` already compose a prompt from one
   subsystem (GitHub) and hand it to an ordinary turn (spec §5.6). It is not a new agent loop,
   not a new LLM call we make ourselves, not an autonomous background process.
2. **Required task, not optional polish:** append a short "§10 Cross-workspace dispatch" section
   to `docs/parallel-agents-spec.md` when this phase is implemented, framing dispatch explicitly
   as glue-between-turns per point 1 — so a future reader of the spec doesn't read this feature
   as silently violating the documented non-goal.
3. **Required task, not optional polish:** get explicit, written sign-off from whoever owns that
   spec line before this phase's code lands in main — reinterpreting a documented non-goal
   without the owner's acknowledgment is a process risk independent of whether the technical
   design is sound.

**A human always merges.** No code introduced by this phase may call `pr:merge`; that command
stays reachable only from the renderer's own Merge button. This is enforced as a CI-checkable
invariant (§7).

---

## 2. Scope

**In scope (this document — "4a")**
- A `Dispatch` record: orchestrator workspace → target workspace, a purpose (`implement` /
  `review` / `explore` / `search`), a prompt, and status tracking.
- **Human-click dispatch only.** When an orchestrator workspace's turn output contains a
  recognizable dispatch suggestion, the renderer surfaces a one-click "Dispatch to another
  workspace" button — the human clicks, *then* a target workspace/turn is created. No running
  turn can programmatically trigger a dispatch itself.
- Roster preflight: reuse the existing `harness:detect`/`harness:list` to route dispatches only
  to vendor CLIs actually installed.
- An inbox view listing dispatches and their status/result summary per orchestrator workspace.
- Cross-vendor review pattern: a dispatch with `purpose: 'review'` hands a different-vendor agent
  only the diff/acceptance contract on its *own* worktree; it never writes to the reviewee's
  worktree, and its findings land as ordinary `diff_comments` (Phase 4) on the reviewee
  workspace.
- `PolicyEngine` gating via `spawnBounds.maxDispatchesPerTurn` and `purposeAllowlist` (Phase 10's
  forward-declared fields, used for the first time here).

**Out of scope (deferred — see §9, not designed further in this document)**
- **"4b": a live MCP tool a running turn could call mid-conversation** to dispatch/check-inbox
  itself, without a human click in the loop. Named and risk-flagged, not scheduled.
- Any autonomous multi-turn loop where a dispatched turn can itself dispatch further turns
  without a human click at each step (no recursive auto-dispatch).
- Cloud/remote execution of dispatched turns (all dispatched turns run as ordinary local
  worktrees, same as every workspace today).

---

## 3. Task breakdown

### 3.1 Shared dispatch types (`src/shared/dispatch.ts`, new file, append-only)

```ts
export type DispatchStatus = 'pending' | 'running' | 'completed' | 'failed' | 'reviewed';

export interface Dispatch {
  id: string;
  orchestratorWorkspaceId: string;
  targetWorkspaceId: string;
  purpose: 'implement' | 'review' | 'explore' | 'search';
  prompt: string;
  status: DispatchStatus;
  resultSummary?: string;
  createdAt: number;
  completedAt?: number;
}
```

### 3.2 Migration + repo (`src/main/db/migrations/NNNN_dispatches.ts`,
`src/main/db/repos/dispatches.ts` + `.test.ts`)

Confirm the next free migration number at implementation time.

```sql
CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  orchestrator_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  target_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  purpose TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_summary TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_dispatches_orchestrator ON dispatches(orchestrator_workspace_id);
```

Mirrors `checkpoints.ts`/`comments.ts`'s CRUD + state-transition repo shape.

### 3.3 `DispatchService` (`src/main/dispatch/index.ts` + `index.test.ts`)

Constructed like `PrWorkflow`/`ChecksService` (see `src/main/index.ts` around lines 330-340 for
the closest analogue), with injected dependencies:

```ts
export class DispatchService {
  constructor(private deps: {
    workspaces: WorkspaceManager;
    harness: HarnessSupervisor;
    diff: DiffService;
    checks: ChecksService;
    policy: PolicyEngine;
    repo: DispatchesRepo;
    emit: EventEmitter;
  }) {}

  async create(req: {
    orchestratorWorkspaceId: string;
    targetWorkspaceId?: string; // reuse an existing workspace, or...
    newWorkspace?: Partial<CreateWorkspaceReq>; // ...create one
    prompt: string;
    purpose: Dispatch['purpose'];
  }): Promise<Dispatch>;

  async list(orchestratorWorkspaceId: string): Promise<Dispatch[]>;
  async cancel(id: string): Promise<void>;
  async recordCompletion(dispatchId: string, workspaceId: string, turnId: string): Promise<void>;
}
```

`create()` behavior:
1. **Policy gate first**: `await this.deps.policy.evaluate('turn_start', { workspaceId: orchestratorWorkspaceId, ... })`
   equivalent check against `spawnBounds.maxDispatchesPerTurn` (count existing dispatches for
   this orchestrator's current turn) and `purposeAllowlist` (is `req.purpose` allowed for this
   orchestrator's config) — `deny` here throws before any workspace/turn is touched.
2. **Roster preflight**: call `this.deps.harness.listHarnesses()` (existing method), confirm the
   target harness is `installed && authenticated`; if not, fail with a clear `AppError` rather
   than silently routing to an unavailable CLI.
3. Resolve target workspace: reuse `targetWorkspaceId` if given, else
   `this.deps.workspaces.create(...)` (existing method — this is where the "new worktree" comes
   from; no new git/filesystem code is written here).
4. Insert a `dispatches` row (`status: 'pending'`), return it. **The actual turn start is a
   separate, explicit human-clicked step** (§3.5) — `create()` only records the dispatch and
   resolves the target workspace; it does not itself call `startTurn`.

### 3.4 Wiring into the existing turn-completion hook (`src/main/index.ts`)

Extend the existing `onTurnEnd` combinator (already composes checkpoint snapshot + diff
invalidation + comment reconciliation, around lines 360-374) with
`dispatch.recordCompletion(workspaceId, turnId)` — **zero `HarnessSupervisor` signature change
needed**, since this hook is already a multi-concern combinator by construction. This is the
mechanism that populates the inbox: when a dispatched target workspace's turn ends, the dispatch
row transitions `running → completed` (or `failed` on an `error` terminal event) and
`resultSummary` is composed from the target workspace's diff/checks state.

### 3.5 Human-click dispatch UI (`src/renderer/features/dispatch/InboxPanel.tsx`, new)

- Mirrors the checks feature's list-of-items shape (`src/renderer/features/checks/*`).
- When an orchestrator workspace's transcript contains a recognized dispatch suggestion (a
  structured pattern the existing `parser.ts`-driven normalization can already surface as a
  distinguishable `tool_use`/`text` shape — reuse, don't reinvent, the existing
  "Fix review comments"/"Fix failing checks" one-click button pattern already in the PR feature),
  render a "Dispatch to another workspace" button. Clicking it calls `dispatch:create`, then
  (still human-initiated, a second explicit action, not automatic) a "Start" button that calls
  the ordinary existing `turn:start` against the resolved target workspace with `req.prompt`.
- `InboxPanel.tsx` lists all `Dispatch` rows for the current orchestrator workspace: status,
  target workspace link (navigates to that workspace's chat), result summary once completed.

### 3.6 Cross-vendor review dispatch

A dispatch with `purpose: 'review'` is handled identically to `'implement'` at the
`DispatchService` level (same worktree-per-workspace isolation), but its prompt template (reuse
the existing `review:run` prompt-composition pattern in `register.ts`, e.g. around lines
906-932) hands the reviewer **only** the diff and an acceptance contract — never write access to
the implementer's worktree. The reviewer's findings surface as `diff_comments` on the
**reviewee's** workspace (existing Phase 4 mechanism — `comment:create` against the reviewee's
workspace id, never a direct file write in the reviewer's turn against the reviewee's worktree).

### 3.7 IPC (`src/shared/ipc.ts` append, `src/main/ipc/register.ts` modify)

- Commands: `dispatch:create`, `dispatch:list(req: { orchestratorWorkspaceId })`,
  `dispatch:get(req: { id })`, `dispatch:cancel(req: { id })`.
- Events: `dispatch:updated` (mirrors `checks:updated`'s broadcast shape).
- Handlers delegate to `DispatchService`, same input-narrowing discipline as every other handler
  in `register.ts`.

### 3.8 Doc update (`docs/parallel-agents-spec.md`)

Append the §10 framing note described in §1 above. This is a required task of this phase, not
optional documentation polish.

---

## 4. Data model owned by this phase

| Table | Columns | Notes |
|---|---|---|
| `dispatches` | `id, orchestrator_workspace_id, target_workspace_id, purpose, prompt, status, result_summary, created_at, completed_at` | New migration, see §3.2. |

---

## 5. IPC surface added

- Commands: `dispatch:create`, `dispatch:list`, `dispatch:get`, `dispatch:cancel`.
- Events: `dispatch:updated`.
- Streams: none new (dispatched turns use the existing `turn:start` stream against their target
  workspace, exactly like any other workspace turn).

---

## 6. Definition of Done

- [ ] `docs/parallel-agents-spec.md` §10 framing note is written, and written sign-off from the
      spec's owner on the non-goal reinterpretation has been obtained, **before** this phase's
      code is merged.
- [ ] An orchestrator workspace's turn output can surface a one-click "Dispatch to another
      workspace" suggestion; the human clicks it, then explicitly starts the dispatched turn.
- [ ] Dispatching creates or reuses a target workspace via roster preflight
      (`harness:detect`/`harness:list`) and starts an ordinary turn there — no new spawn/process
      code, entirely composed from existing `WorkspaceManager`/`HarnessSupervisor` methods.
- [ ] Completion populates the inbox via the existing `onTurnEnd` combinator with **zero**
      `HarnessSupervisor` signature changes.
- [ ] A `purpose: 'review'` dispatch produces `diff_comments` on the reviewee workspace without
      touching its worktree — proven by a regression test asserting the reviewee's git state
      (HEAD, working tree hash) is byte-identical before and after the review dispatch runs.
- [ ] `spawnBounds.maxDispatchesPerTurn` and `purposeAllowlist` (Phase 10's forward-declared
      `PolicyMatch` fields) are evaluated on every `dispatch:create` call and provably block a
      dispatch that exceeds them (test: create N+1 dispatches against a
      `maxDispatchesPerTurn: N` rule, assert the (N+1)th is denied before any workspace/turn is
      touched).
- [ ] `pr:merge` is provably unreachable from any code path under `src/main/dispatch/*` — enforced
      by a grep/lint-based CI check (`pr:merge` invoked only from the renderer's Merge-button IPC
      call site), not just a code-review spot-check.
- [ ] `bash ci/harness-gates.sh` green.

---

## 7. Tests

- `dispatches.test.ts` — repo CRUD + status-transition correctness.
- `dispatch/index.test.ts` — roster-preflight fallback (target harness not installed → clear
  error, no silent misrouting), `recordCompletion` wiring via a fake `onTurnEnd`,
  `spawnBounds`/`purposeAllowlist` gating via a fake `PolicyEngine` (assert `create()` throws
  before touching `workspaces`/`harness` when policy denies).
- Integration test: a `purpose: 'review'` dispatch's target workspace git state is
  byte-identical before/after (hash the worktree, run the mock reviewer turn, hash again, assert
  equality).
- A repo-wide static check (grep-based, wired into `ci/harness-gates.sh` or a dedicated script)
  asserting no `pr:merge` string/call appears under `src/main/dispatch/**`.
- Playwright smoke test: full human-click round trip — dispatch suggestion appears, click
  "Dispatch," click "Start," dispatched turn runs against `MockHarness`, inbox shows
  `completed` with a result summary.

---

## 8. Security touchpoints (heightened-scrutiny paths this phase touches)

- **Git & filesystem on workspaces:** `DispatchService.create` creates a new worktree exclusively
  via the existing, already-reviewed `WorkspaceManager.create` — this phase must not add any new
  git/filesystem code of its own; any temptation to do so is a sign the design has drifted from
  "glue between existing turns."
- **Process execution:** roster preflight and dispatched-turn start reuse
  `harness:detect`/`harness:list`/`HarnessSupervisor.startTurn` as-is — no new spawn surface.
- **IPC/preload boundary:** the four new commands validate inputs like every other handler in
  `register.ts` (non-empty ids, `purpose` restricted to the closed union, `prompt` non-empty).
- **The "human always merges" invariant** (§1) is the single most important security property of
  this phase — treat any dispatch code path that could reach `pr:merge`, directly or indirectly,
  as a blocking finding in review, not a style nit.

---

## 9. Deferred: "4b" — live in-turn MCP dispatch tool (unscheduled appendix)

Not designed further, not scheduled, and **not part of this phase's Definition of Done.**
Documented here only so the risk is on the record for whoever picks this up later.

The idea: let a *running* turn call `dispatch()`/`checkInbox()` itself, mid-conversation, via an
MCP tool server — the live-orchestration experience omnigent's `polly` example actually
demonstrates, as opposed to 4a's human-click-per-step version.

**Why it's deferred rather than built:** it requires a callback channel from a process **the
vendor CLI itself spawns** (the MCP server process, launched per the existing
`McpServerConfig`/`StartTurnOpts.mcpConfig` contract) back into our full-privilege Electron main
process, so that server can actually create workspaces / start turns on the running turn's
behalf. **This is a new trust boundary with no precedent anywhere in this codebase** — every
existing privileged capability is reached from the sandboxed renderer through the frozen
IPC/preload bridge; this would be a third-party-CLI-spawned process reaching main directly. It
also reopens the non-goal tension from §1 in a much sharper form, since a turn could then
dispatch *without* a human click at each step.

If this is ever built: scope the channel to a single ephemeral, per-turn, random-token-
authenticated socket (token delivered via `McpServerConfig.env`, which the contract already
supports without modification), expose only `dispatch`/`checkInbox` — **never** a general command
surface, and **never** anything that could reach `pr:merge` — and require the same two-reviewer
heightened-scrutiny process the IPC/preload boundary itself gets (`.claude/rules/security.md`).
Do not schedule this without: (a) 4a shipped and used in practice, (b) a dedicated new proposal
document (not an extension of this one), and (c) explicit sign-off given the trust-boundary and
non-goal implications are materially larger than everything else in Phases 8–11 combined.
