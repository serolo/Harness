# Phase 8 — Harness Conformance Test Bench

> **Read [`README.md`](./README.md) (esp. §6.3 Harness interface, §9 testing strategy) first.**

**External reference:** [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent)
`docs/harness-bench-design.md` (Layer 0/1/2 conformance-bench design). This phase and the three
that follow (9, 10, 11) port ideas from omnigent's "meta-harness" concept into our own
`src/main/harness/*` subsystem; omnigent's server-side pieces are explicitly out of scope
throughout.

**Estimated size:** ~1 week. **Depends on:** Phase 2 (harness pattern, adapter contract tests),
Phase 7 (Codex/Cursor adapters + their fixtures). **Parallelizable with:** none required, but
should land before Phase 9 so Phase 9's new `supportsMidTurnSteer` capability flag has bench
coverage from day one instead of being asserted only by convention.

---

## 1. Goal

Catch the specific failure mode omnigent's bench design targets: a harness adapter's declared
`HarnessCapabilities` (or, more generally, its behavior) silently drifting from what it actually
does. We already have a live, named instance of this exact risk in this codebase: the header of
`src/main/harness/codex.ts` states its JSON-stream shape is an **unverified assumption** (the
real `codex` CLI isn't available to test against in this environment). The bench turns "we think
this adapter behaves like X" into an executable, CI-checked claim, and gives every future
adapter (Phase 7 already added two; more may come later) a required conformance profile instead
of relying on hand-written contract tests alone.

Because every adapter already implements the same frozen `Harness` interface
(`src/shared/harness.ts:14-22`) regardless of transport (JSON-stream vs. raw-terminal), we do
**not** need omnigent's per-transport "driver" abstraction — a single generic probe layer plus a
self-declared `BenchProfile` per adapter is sufficient.

---

## 2. Scope

**In scope**
- `BenchProfile`/`BenchReport`/`BenchVerdict` shared types.
- Layer 1: an offline, fixture-replay conformance runner that runs in the default gate
  (`ci/harness-gates.sh`) on every change.
- Layer 2: live behavioral probes against real installed CLIs, env-gated, run nightly — never in
  the default gate (no credentials assumed in CI).
- A `BenchProfile` for every currently-registered harness (`claude_code`, `codex`, `cursor`) plus
  `MockHarness`.
- A minimal, optional diagnostics IPC command to inspect the last bench report per harness.

**Out of scope**
- Changing any adapter's actual runtime behavior — this phase only *observes and asserts*, it
  never alters `claude-code.ts`/`codex.ts`/`cursor.ts` logic.
- Any change to `ci/harness-gates.sh` beyond what's needed to run Layer 1 (it's ordinary Vitest,
  picked up automatically); Layer 2 is a **separate** CI workflow, not a gate change.
- Fuzzing, load testing, or general security pentesting of the CLIs — Layer 2's probes are
  narrow, deterministic conformance checks, not a security test suite.
- Persisting bench history to the database — v1 keeps the last report per harness in memory only.

---

## 3. Task breakdown

### 3.1 Shared bench types (`src/shared/bench.ts`, new file, append-only)

```ts
import type { AgentEvent, HarnessCapabilities, HarnessId } from './harness';

export type BenchVerdict = 'pass' | 'drift' | 'skip';

export interface BenchProbeResult {
  probe: string; // e.g. "expectedEventKinds", "capability:supportsMcp", "runBasicTurn"
  verdict: BenchVerdict;
  detail?: string; // human-readable explanation, never raw CLI stdout/secrets
}

export interface BenchProfile {
  harnessId: HarnessId;
  transport: 'json_stream' | 'raw_terminal';
  expectedEventKinds: AgentEvent['kind'][];
  capabilities: HarnessCapabilities;
  minVersion?: string;
}

export interface BenchReport {
  harnessId: HarnessId;
  layer: 1 | 2; // Layer 0 (static profile) has no report of its own — it's the input, not output
  ranAt: number; // epoch millis
  results: BenchProbeResult[];
}
```

### 3.2 Bench profiles (`src/main/harness/bench/profile.ts`, new file)

Colocated with, but not inside, the adapter files — keeps the frozen adapters untouched.

```ts
import type { BenchProfile } from '@shared/bench';
import type { HarnessId } from '@shared/harness';

export const BENCH_PROFILES: Record<HarnessId, BenchProfile> = {
  claude_code: {
    harnessId: 'claude_code',
    transport: 'json_stream',
    expectedEventKinds: ['text', 'tool_use', 'tool_result', 'file_edit', 'todo_update', 'turn_end', 'error'],
    capabilities: { supportsResume: true, supportsMcp: true, supportsPlanMode: true, rawTerminalFallback: false },
  },
  codex: {
    harnessId: 'codex',
    transport: 'json_stream',
    expectedEventKinds: ['text', 'tool_use', 'tool_result', 'turn_end', 'error'],
    capabilities: { supportsResume: false, supportsMcp: false, supportsPlanMode: false, rawTerminalFallback: false },
  },
  cursor: {
    harnessId: 'cursor',
    transport: 'raw_terminal',
    expectedEventKinds: ['text', 'turn_end', 'error'],
    capabilities: { supportsResume: false, supportsMcp: false, supportsPlanMode: false, rawTerminalFallback: true },
  },
};
```

**Task:** reconcile every field above against each adapter's *actual* `capabilities()` return
value at implementation time — do not assume the illustrative values here are correct; a
mismatch discovered during this reconciliation is itself a Phase-8 finding worth a code comment
or a linked follow-up, not something to silently paper over.

### 3.3 Layer 1 runner (`src/main/harness/bench/runner.ts` + `runner.test.ts`)

```ts
export interface FixtureSet {
  files: string[]; // paths under src/main/harness/fixtures/**
}

export function runLayer1(profile: BenchProfile, fixtures: FixtureSet): BenchReport;
```

Behavior:
- Replays each fixture file through the **same** parsing path the real adapter uses
  (`parser.ts`'s `createJsonLineSplitter`/`normalize` for `json_stream`; the raw-terminal
  text-chunking logic in `raw-terminal.ts` for `raw_terminal`) — never a bench-specific
  reimplementation of parsing, or the bench stops proving anything about the real code path.
- Collects the union of `AgentEvent['kind']` values actually observed across all fixtures for
  that harness.
- Verdict rules (each a distinct `BenchProbeResult`):
  - `expectedEventKinds`: every kind the profile declares must appear in at least one fixture →
    else `drift`.
  - `capability:<flagName>` (one per boolean flag): a capability declared `true` must have
    corroborating fixture evidence (e.g. `supportsMcp: true` requires at least one MCP-shaped
    `tool_use`); no evidence → `drift`. A capability declared `false` is trivially `pass` (no
    evidence required, absence isn't drift).
  - No fixtures found at all for a harness → `skip` (not `pass` — a bench that can't run is not
    proof of conformance) with a detail explaining why.
- **`runner.test.ts` must include a regression case that constructs a deliberately mismatched
  profile/fixture pair (a profile claiming an event kind that provably never appears in the
  fixture set) and asserts the result is `drift`**, not `skip` or a silent `pass` — this is the
  bench's own fail-closed guarantee, and needs its own test the same way any other
  security/correctness invariant in this codebase does.

### 3.4 Layer 2 live probes (`src/main/harness/bench/live-probes.ts` + `live-probes.test.ts`)

Gated identically to the existing `AGENTAPP_MOCK_HARNESS`/`AGENTAPP_E2E` convention:
`describe.skipIf(process.env.AGENTAPP_BENCH_LIVE !== '1')`.

```ts
export async function runBasicTurn(harness: Harness): Promise<BenchProbeResult>;
export async function runPolicyTurn(harness: Harness): Promise<BenchProbeResult>;
export async function runInterrupt(harness: Harness): Promise<BenchProbeResult>;
```

- `runBasicTurn` — spawns a real turn (`harness.startTurn`) against a **disposable scratch git
  repo** created fresh per test run (`fs.mkdtemp` + `git init`, never a real project worktree),
  asserts a `turn_end` event arrives within a bounded timeout.
- `runPolicyTurn` — starts a turn with a `permissionPolicy.deny` covering all tools, asserts no
  tool actually executes (regression coverage for today's CLI-flag-pass-through
  `PermissionPolicy`; becomes a stronger check once Phase 10's `PolicyEngine` lands upstream of
  `startTurn`, but is worth having now on its own).
- `runInterrupt` — starts a turn, calls `handle.interrupt()`, asserts the spawned child process
  tree is fully torn down (no orphan, check via the same `tree-kill`-adjacent mechanism the
  supervisor already uses) and a terminal event fires.
- Every probe is wrapped in try/catch; a thrown error maps to verdict `drift` with
  `detail = err.message` — **never** include raw CLI stdout/stderr or environment values in the
  detail string (matches the existing "stderr length only" logging convention in
  `claude-code.ts`).

### 3.5 Nightly CI workflow (`.github/workflows/harness-bench-nightly.yml`, new file)

- Triggers: `schedule` (nightly cron) + `workflow_dispatch` (manual).
- `AGENTAPP_BENCH_LIVE=1` env for the job.
- Runs `node scripts/vitest-electron.mjs run src/main/harness/bench/live-probes.test.ts`.
- Uploads the resulting `BenchReport`s as a build artifact (JSON only — never raw CLI logs).
- **Explicitly not referenced from `ci/harness-gates.sh`** — this workflow is separate so a
  missing/unauthenticated CLI in a contributor's environment never blocks the standard PR gate.

### 3.6 Optional diagnostics IPC

- `src/shared/ipc.ts` (append): `harness:benchReport` command,
  `req: { harnessId: HarnessId }`, `res: BenchReport | null`.
- `src/main/ipc/register.ts` (append): one handler reading from an in-memory
  `Map<HarnessId, BenchReport>` populated whenever Layer 1 or Layer 2 runs are triggered
  in-process (dev/test convenience — not wired to any user-facing UI in this phase).

---

## 4. Data model owned by this phase

None. No migration. Bench reports are in-memory only for v1 — persisting bench history to SQLite
is a named, explicit non-goal for this phase (revisit only if a future diagnostics UI needs
historical trend data).

---

## 5. IPC surface added

- Commands: `harness:benchReport(req: { harnessId }): BenchReport | null`.
- Events: none new.
- Streams: none new.

---

## 6. Definition of Done

- [ ] `claude_code`, `codex`, `cursor` (and `MockHarness`, for its own test coverage) each have a
      `BenchProfile` in `BENCH_PROFILES`, reconciled against each adapter's real `capabilities()`.
- [ ] Layer 1 (`runner.ts`) runs inside `bash ci/harness-gates.sh` / `npm run check` and passes
      for every registered harness's existing fixtures.
- [ ] A dedicated regression test proves Layer 1 fails closed: a deliberately mismatched
      profile/fixture pair yields `drift`, never `skip` or a silent `pass`.
- [ ] `harness-bench-nightly.yml` exists and has been manually dispatched at least once to
      confirm it actually runs Layer 2 end-to-end.
- [ ] Layer 2 produces at least one real, **expected** `drift` or `skip` verdict tied to the
      Codex adapter's documented "ASSUMED stream shape" risk (`src/main/harness/codex.ts` header)
      — this is proof the mechanism works, not a build blocker.
- [ ] `bash ci/harness-gates.sh` green.

---

## 7. Tests

- `src/main/harness/bench/runner.test.ts` — fixture replay against real profiles (pass cases) +
  the deliberate-mismatch fail-closed regression case (§3.3).
- `src/main/harness/bench/live-probes.test.ts` — env-gated (`AGENTAPP_BENCH_LIVE=1`), exercises
  `runBasicTurn`/`runPolicyTurn`/`runInterrupt` against whichever real CLIs are actually
  installed in the CI runner; must not fail the default gate when CLIs are absent (`skip`, not a
  thrown error, in that case).
- No renderer-facing tests required for v1 (no user-facing surface beyond the optional
  diagnostics command).

---

## 8. Risks / notes

- **False confidence risk:** a Layer 1 `pass` only means "the recorded fixtures are consistent
  with the declared profile" — it does **not** prove the real CLI still behaves that way today.
  Layer 2 is the only layer that checks against live reality, and it's necessarily gated/nightly
  because it needs installed, authenticated CLIs. Don't let a green Layer 1 be read as "fully
  conformant."
- **Fixture staleness:** as CLI vendors change their output formats (the exact risk the Codex
  adapter's header already calls out), Layer 1 will happily keep passing against stale fixtures
  forever unless Layer 2 catches the drift. Treat a Layer 2 `drift` verdict as a signal to
  re-record fixtures, not just patch the profile.
- **Scratch-repo isolation is load-bearing:** Layer 2 probes must never run against a real
  project workspace — a bug here would mean bench runs mutate user data. Use a fresh `mkdtemp`
  directory per probe, never a path derived from any real project.
