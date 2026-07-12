# Phase 10 — Policy Engine Upgrade

> **Read [`README.md`](./README.md) (esp. §6.3 Harness interface, §7.2 error handling, §6.5
> settings access) first.**

**External reference:** [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent)
`omnigent/runner/policy.py`, `docs/POLICIES.md`, and the `guardrails.policies` block in
`examples/polly/config.yaml` (`blast_radius`, `spawn_bounds`, purpose-allowlisting).

**Estimated size:** ~2 weeks. **Depends on:** Phase 4 (`CheckpointService`, for `turn_response`
auto-revert), Phase 5 (`ChecksService`/diff plumbing, for blast-radius evaluation), Phase 6
(settings write path — this phase adds a section, not a new mechanism). **Blocks:** Phase 11
(dispatch's one true synchronous safety mechanism is a `PolicyEngine` client).

---

## 1. Goal

Move from today's `PermissionPolicy` (`src/shared/harness.ts:98-103`) — which is pure CLI-flag
pass-through (`allowedTools`/`allow`/`deny`/`confirmBeforeRun`, mapped straight to adapter argv in
`claude-code.ts:260-270`, with **no in-app enforcement point and no ASK path**) — toward a
declarative ALLOW/DENY/ASK rule engine evaluated by *us*, not just handed to the CLI and hoped
for. This is the guardrail layer Phase 11's dispatch feature needs (`spawnBounds`,
`purposeAllowlist`) and is valuable standing on its own regardless of Phase 11.

**Honest framing of enforcement strength (state this explicitly in any doc/UI built against this
phase — it's a security-communication requirement, not just an implementation detail):**

| Enforcement point | Mechanism | Strength |
|---|---|---|
| `turn_start` | Evaluated **before** `ctx.harness.startTurn` is ever called | **True prevention** — a DENY means the adapter's `spawn`/`execa` call never happens. |
| `turn_response` | Evaluated against the finished turn's diff/blast-radius via `ChecksService`/`DiffService` | **True prevention of the *result* sticking** — a DENY auto-reverts via the existing `CheckpointService.revert`. |
| `tool_call` | Evaluated against the observed `tool_use` `AgentEvent` as it streams | **Detect-and-react only**, for every currently-shipped adapter — by the time we see the event, the CLI has already run the tool. Best-effort auto-`interrupt()` + flag. A synchronous pre-tool-use hook (unverified whether any current CLI exposes one) is an explicit fast-follow spike, **not** part of this phase's scope. |

---

## 2. Scope

**In scope**
- `PolicyEngine` service: declarative rules, ALLOW/deny short-circuit/ASK-pauses evaluation, at
  the three enforcement points above.
- `turn_start` enforcement wired into the `turn:start` IPC producer (true prevention, test-proven
  via a spawn-spy asserting zero child processes on DENY).
- `turn_response` enforcement (blast-radius against the finished diff, auto-revert on violation).
- `tool_call` enforcement in explicitly-labeled detect-and-react mode.
- A durable, user-approvable/denyable `PendingApproval` row for the ASK verdict.
- A Settings UI section for authoring rules; a chat-surface banner for pending approvals.
- `blastRadius`/`spawnBounds`/`purposeAllowlist` fields on `PolicyMatch`, forward-declared for
  Phase 11's use even though this phase only *evaluates* `blastRadius` (the other two are unused
  until dispatch exists).

**Out of scope**
- A synchronous, in-CLI pre-tool-execution hook (the only mechanism that would make `tool_call`
  true prevention rather than detect-and-react) — filed as a named fast-follow, not built here.
- Any dispatch-specific behavior — Phase 11 is the only consumer of `spawnBounds`/
  `purposeAllowlist`, and this phase ships them unused (forward-declared) rather than half-wiring
  dispatch logic early.
- A general-purpose sandboxing layer (bubblewrap/seatbelt-equivalent) — omnigent has one; it's
  explicitly not part of this port.

---

## 3. Task breakdown

### 3.1 Shared policy types (`src/shared/policy.ts`, new file, append-only)

```ts
export type PolicyVerdict = 'allow' | 'deny' | 'ask';
export type PolicyEnforcementPoint = 'turn_start' | 'tool_call' | 'turn_response';
export type PolicyScope = 'global' | 'workspace' | 'session';

export interface PolicyMatch {
  toolName?: string;
  commandPattern?: string; // user-authored regex source — see security notes §5
  blastRadius?: { maxFilesChanged?: number; maxLinesChanged?: number };
  spawnBounds?: { maxDispatchesPerTurn?: number }; // forward-declared; unused until Phase 11
  purposeAllowlist?: string[]; // forward-declared; unused until Phase 11
}

export interface PolicyRule {
  id: string;
  scope: PolicyScope;
  enforcementPoint: PolicyEnforcementPoint;
  match: PolicyMatch;
  verdict: PolicyVerdict;
  reason?: string;
}

export interface PolicyDecision {
  verdict: PolicyVerdict;
  matchedRuleId?: string;
  reason?: string;
}

export interface PendingApproval {
  id: string;
  workspaceId: string;
  turnId?: string;
  enforcementPoint: PolicyEnforcementPoint;
  toolName?: string;
  input?: unknown;
  createdAt: number;
}
```

### 3.2 `PolicyEngine` service (`src/main/policy/index.ts` + `index.test.ts`)

Constructed like `ChecksService` — an injected-dependency class registered once in
`src/main/index.ts`:

```ts
export class PolicyEngine {
  constructor(private deps: {
    settings: SettingsService;
    approvals: PolicyApprovalsRepo;
    diff: DiffService;
    checks: ChecksService;
  }) {}

  async evaluate(
    point: PolicyEnforcementPoint,
    ctx: { workspaceId: string; turnId?: string; toolName?: string; input?: unknown },
  ): Promise<PolicyDecision> {
    const rules = this.deps.settings.get().policy.rules.filter(r => r.enforcementPoint === point);
    // 1. any matching DENY short-circuits immediately
    // 2. else any matching ASK short-circuits (creates a PendingApproval row)
    // 3. else ALLOW
  }
}
```

Rule matching precedence is DENY > ASK > ALLOW regardless of rule order within a scope — this
must be a documented, tested invariant (an accidental "first match wins" implementation would
let a permissive rule shadow a stricter one authored later, which is exactly backwards for a
guardrail system).

### 3.3 Approvals persistence (`src/main/db/migrations/NNNN_policy_approvals.ts`,
`src/main/db/repos/policy-approvals.ts` + `.test.ts`)

Confirm the next free migration number at implementation time.

```sql
CREATE TABLE policy_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  turn_id TEXT,
  enforcement_point TEXT NOT NULL,
  tool_name TEXT,
  input_json TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'approved' | 'denied'
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
```

State machine mirrors `diff_comments`'s open/resolved shape: `open → approved | denied`, no other
transitions.

### 3.4 Settings schema (`src/main/settings/schema.ts`, append)

```ts
const policySchema = z.object({
  rules: z.array(policyRuleSchema).default([]),
}).default({});
```

**Explicit, documented tradeoff — flag this prominently in the schema file's own comments and in
code review:** the existing settings-merge rule states arrays are **atomic** ("a higher layer's
array replaces the lower one wholesale," same as `mcp`/`scripts.run` today). Applied to
`policy.rules`, this means a project-local settings file's `rules` array **fully replaces**, not
appends to, any project-shared or global guardrail rules — a project-local override could
silently erase a team-wide DENY rule. Ship v1 with this existing atomic-replace semantics for
consistency with every other array-valued settings section, but document the caveat loudly in
the Settings UI copy itself (not just code comments). A `policy.mode: 'replace' | 'extend'`
toggle is a named, explicit fast-follow if this proves surprising in practice — do not build it
speculatively in this phase.

### 3.5 Error code (`src/shared/errors.ts`, append)

Add `'policy_denied'` to the `AppErrorCode` union (append-only, same precedent as every other
code added since Phase 0) so the renderer can special-case a policy block distinctly from a
generic error toast.

### 3.6 IPC (`src/shared/ipc.ts` append, `src/main/ipc/register.ts` modify)

- Commands: `policy:approve(req: { approvalId })`, `policy:deny(req: { approvalId })`.
- Events: `policy:pendingApproval` broadcast (mirrors `notify:needsAttention`'s shape).
- `TurnStreamChunk` (the `turn:start` stream's chunk union) gets one additive variant:
  `{ kind: 'pendingApproval'; approvalId: string }` — same pattern as extending any other
  discriminated union in `src/shared/*` by appending a tagged variant, never touching existing
  ones.
- **`turn:start` producer** (`register.ts`, the existing block that builds `TurnStartArg` →
  `ctx.harness.startTurn`): insert `const decision = await ctx.policy.evaluate('turn_start', {...})`
  **before** the `ctx.harness.startTurn(...)` call. `deny` → throw
  `AppError('policy_denied', decision.reason)`, and **the adapter's `startTurn` must never be
  reached** in this path (this is the load-bearing guarantee — test it with a spawn-spy). `ask` →
  push the new `{ kind: 'pendingApproval' }` stream chunk and hold; `policy:approve` resumes by
  calling the deferred `startTurn`, `policy:deny` finalizes the stream with a `policy_denied`
  error instead.

### 3.7 Supervisor hook (`src/main/harness/supervisor.ts`, extend the wrapped sink)

Add an optional `onToolUse?: (workspaceId, turnId, toolName, input) => void` hook to the sink
wrapper (`supervisor.ts:154-180`), evaluated on every `tool_use` event, mirroring the existing
`onTodoUpdate` best-effort-hook discipline **exactly**: guarded try/catch, logged on failure,
never throws into and wedges the write chain. On a `deny` verdict: best-effort
`handle.interrupt()` plus emit a policy-violation marker into the transcript (labeled, per §5
below, as "detected after execution").

### 3.8 Wiring (`src/main/index.ts`)

Construct `PolicyEngine`, add it to `AppContext`, thread `onToolUse` alongside the existing
`onTodoUpdate`/`onTurnEnd` combinators (the composition point around lines 351-374). Add a
`turn_response` check inside (or immediately after) the existing `onTurnEnd` combinator: evaluate
blast-radius against the finished turn's diff (via `DiffService`), and on `deny`, call the
existing `CheckpointService.revert` path — this reuses machinery that already exists for the
"undo a turn" user action, just triggered automatically.

### 3.9 Renderer (`src/renderer/stores/policy.ts`, chat banner, Settings section)

- `stores/policy.ts` mirrors `stores/checks.ts`: subscribes to `policy:pendingApproval`, exposes
  `usePendingApprovals(workspaceId)`.
- Chat feature: an "Approval needed" banner (reuses the existing `needs_attention` visual
  treatment) with Approve/Deny buttons wired to `policy:approve`/`policy:deny`.
- Settings: a new Policy panel (mirrors `SettingsPanel.tsx`/`SettingRow.tsx`) for authoring
  rules — **no new settings IPC required**, it's just a new zod-validated section read/written
  through the existing `settings:getEffective`/`settings:getProvenance`/`settings:set` path.

---

## 4. Data model owned by this phase

| Table | Columns | Notes |
|---|---|---|
| `policy_approvals` | `id, workspace_id, turn_id, enforcement_point, tool_name, input_json, status, created_at, resolved_at` | New migration, see §3.3. |

Settings: new `policy.rules` section (no migration — settings are TOML, not SQLite).

---

## 5. IPC surface added

- Commands: `policy:approve`, `policy:deny`.
- Events: `policy:pendingApproval`.
- Streams: one additive `TurnStreamChunk` variant (`{ kind: 'pendingApproval'; approvalId }`) on
  the existing `turn:start` stream — no new stream channel.

---

## 6. Definition of Done

- [ ] A `turn_start` DENY rule provably prevents the adapter spawn — test asserts zero child
      processes created when policy denies.
- [ ] A `turn_start` or `turn_response` ASK rule creates a durable `PendingApproval` row,
      surfaces the banner, and Approve/Deny resolve it correctly (approve resumes the turn/keeps
      the diff; deny finalizes with `policy_denied` / triggers `CheckpointService.revert`).
- [ ] `turn_response` blast-radius evaluation auto-reverts a turn that exceeds
      `maxFilesChanged`/`maxLinesChanged` via the existing checkpoint-revert path.
- [ ] `tool_call` enforcement is wired and demonstrably interrupts+flags on a `MockHarness`-
      scripted `tool_use` event that matches a DENY rule — and the UI labels this path distinctly
      as "detected after execution," never presented as a block.
- [ ] The atomic-array settings caveat for `policy.rules` is documented in the Settings UI copy,
      not just code comments.
- [ ] `bash ci/harness-gates.sh` green.

---

## 7. Tests

- `src/main/policy/index.test.ts` — rule-matching precedence (DENY > ASK > ALLOW regardless of
  authoring order), scope resolution (global/workspace/session), blast-radius arithmetic against
  a fake diff.
- Integration test on the `turn:start` producer proving a DENY rule results in zero
  `child_process.spawn`/`execa` calls (spawn-spy).
- `policy-approvals.test.ts` — repo state machine (`open → approved | denied`, no other
  transitions permitted).
- A `MockHarness`-scripted `tool_use` case proving the `tool_call` degraded detect-and-react path
  actually calls `interrupt()` and flags the violation.
- Settings schema test for the new `policy` section's defaults and validation.
- Renderer: `stores/policy.test.ts`, banner component test (approve/deny wiring), Settings panel
  test (rule authoring round-trips through `settings:set`).

---

## 8. Risks / notes

- **The biggest risk in this phase is presenting `tool_call` enforcement as stronger than it
  is.** Every UI surface for a tool-level DENY must say "detected after execution" — a security
  guardrail that silently overstates its own strength is worse than no guardrail, because it
  changes user behavior based on a false guarantee. Treat this as a named review item, not a
  cosmetic nit.
- **`commandPattern` is user-authored regex evaluated against tool input — a ReDoS-adjacent
  surface.** Wrap evaluation with a bounded-time/complexity guard (e.g. a regex-complexity
  linter at rule-save time, or a hard evaluation timeout) and call this out explicitly in
  security review; don't ship unbounded `RegExp.test()` against untrusted-shaped tool input.
- **Atomic-array settings semantics are a real footgun specifically for a guardrail array** — see
  §3.4. Don't let this phase's DoD be satisfied without the caveat being visible to the *user
  authoring rules*, not just documented for developers.
- **Policy reads exclusively through `ctx.settings.get()`** (the already-validated, merged
  effective settings) — never a separate raw-TOML parse path. This keeps the policy engine from
  becoming a second source of truth for configuration.
