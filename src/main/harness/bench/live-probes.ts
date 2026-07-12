// Harness Conformance Bench — Layer 2 (live CLI probes). Phase 8, plan Task 6.
//
// These probes drive a REAL harness `startTurn` against a REAL CLI and grade observable
// behaviour. They are env-gated (never run in the default gate — see the Layer-2 test) and
// each returns a `BenchProbeResult` instead of throwing, so a single probe failure is a
// recorded FINDING, not a crashed run.
//
// SECURITY (heightened-scrutiny — process execution). Three load-bearing invariants:
//   1. SCRATCH-REPO ISOLATION. The turn's `workspaceDir` comes ONLY from `fs.mkdtemp`
//      (a fresh, unique tmp dir) — NEVER a project/workspace path. A live agent can write,
//      delete, and run commands, so it must be confined to a throwaway repo we own.
//   2. ARG-ARRAY SPAWNING. Every external command (`git init`, `pgrep`) is run via `execa`
//      with an ARGUMENT ARRAY (never a shell string) — no workspace-derived value is ever
//      interpolated into a shell.
//   3. NO SECRET/OUTPUT LEAKAGE. A thrown error maps to `{ verdict:'drift', detail }` where
//      `detail` is a SANITIZED reason (execa `shortMessage` — command + exit code, NEVER the
//      captured stdout/stderr, which can carry prompt/secret fragments) or a plain message.
//
// TEARDOWN. Every probe interrupts the turn and `rm -rf`s the scratch dir in `finally`, so a
// timeout or thrown error never leaks a running agent or a tmp directory.

import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BenchProbeResult } from '@shared/bench';
import type {
  AgentEvent,
  Harness,
  StartTurnOpts,
  TurnHandle,
} from '@shared/harness';
import type { StreamSink } from '@shared/ipc';

/** Prefix for every scratch repo (so an orphaned dir is recognizable if teardown fails). */
const SCRATCH_PREFIX = 'harness-bench-';

/** Bound for a full basic/policy turn — generous; a real CLI turn can be slow. */
const TURN_TIMEOUT_MS = 120_000;
/** Bound for the terminal event after an immediate interrupt (should be prompt). */
const INTERRUPT_TERMINAL_TIMEOUT_MS = 30_000;
/** How long to keep polling for an orphaned process after an interrupt. */
const ORPHAN_POLL_TIMEOUT_MS = 10_000;
/** Gap between orphan polls. */
const ORPHAN_POLL_INTERVAL_MS = 500;

/**
 * basic-turn: a trivial prompt must reach a terminal (`turn_end`/`error`) event within the
 * timeout. Proves the adapter can drive a real turn end-to-end and always closes it.
 */
export async function runBasicTurn(
  harness: Harness,
): Promise<BenchProbeResult> {
  const name = 'live:basicTurn';
  let dir: string | undefined;
  let handle: TurnHandle | undefined;
  try {
    dir = await createScratchRepo();
    const cap = capturingSink();
    handle = await harness.startTurn(
      turnOpts(dir, 'Reply with the word ready, then stop.'),
      cap.sink,
    );

    const terminal = await waitForTerminal(cap.terminal, TURN_TIMEOUT_MS);
    if (terminal === undefined) {
      return drift(name, 'no terminal event within timeout');
    }
    return pass(name, `terminal event observed (${terminal.kind})`);
  } catch (err) {
    return drift(name, safeErrDetail(err));
  } finally {
    await teardown(handle, dir);
  }
}

/**
 * policy-turn: with a deny-everything policy, the agent must NOT actually run a tool. If any
 * `tool_result`/`file_edit` event appears, a tool executed despite the policy → `drift`.
 */
export async function runPolicyTurn(
  harness: Harness,
): Promise<BenchProbeResult> {
  const name = 'live:policyTurn';
  let dir: string | undefined;
  let handle: TurnHandle | undefined;
  try {
    dir = await createScratchRepo();
    const cap = capturingSink();
    const opts: StartTurnOpts = {
      ...turnOpts(
        dir,
        'Create a file named probe.txt containing the word blocked.',
      ),
      // Deny every command and expose no native tools: nothing should be able to run.
      permissionPolicy: { deny: ['*'], allowedTools: [] },
    };
    handle = await harness.startTurn(opts, cap.sink);

    const terminal = await waitForTerminal(cap.terminal, TURN_TIMEOUT_MS);
    if (terminal === undefined) {
      return drift(name, 'no terminal event within timeout');
    }
    // A tool_result or file_edit under deny-all means a tool actually executed → drift.
    const ranTool = cap.events.some(
      (e) => e.kind === 'tool_result' || e.kind === 'file_edit',
    );
    if (ranTool) {
      return drift(
        name,
        'a tool executed under a deny-all policy (tool_result/file_edit seen)',
      );
    }
    return pass(name, 'no tool executed under deny-all policy');
  } catch (err) {
    return drift(name, safeErrDetail(err));
  } finally {
    await teardown(handle, dir);
  }
}

/**
 * interrupt: an immediate interrupt must (a) still produce a terminal event and (b) leave no
 * orphaned process referencing the (unique) scratch dir. A surviving match → `drift`.
 */
export async function runInterrupt(
  harness: Harness,
): Promise<BenchProbeResult> {
  const name = 'live:interrupt';
  let dir: string | undefined;
  let handle: TurnHandle | undefined;
  try {
    dir = await createScratchRepo();
    const cap = capturingSink();
    handle = await harness.startTurn(
      turnOpts(dir, 'Count slowly from one to one hundred.'),
      cap.sink,
    );

    // Interrupt right away — the turn must still finalize.
    await handle.interrupt();

    const terminal = await waitForTerminal(
      cap.terminal,
      INTERRUPT_TERMINAL_TIMEOUT_MS,
    );
    if (terminal === undefined) {
      return drift(name, 'no terminal event after interrupt within timeout');
    }
    if (await orphanSurvives(dir)) {
      return drift(
        name,
        'a process referencing the scratch dir survived the interrupt',
      );
    }
    return pass(name, 'interrupt produced a terminal event and left no orphan');
  } catch (err) {
    return drift(name, safeErrDetail(err));
  } finally {
    await teardown(handle, dir);
  }
}

// ---------------------------------------------------------------------------
// Scratch repo lifecycle (isolation is load-bearing — see the file header)
// ---------------------------------------------------------------------------

/** Create a fresh, isolated git repo in a unique tmp dir. `git init` via an arg array. */
async function createScratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX));
  // Arg array, never a shell string; cwd is the scratch dir we just minted.
  await execa('git', ['init'], { cwd: dir });
  return dir;
}

/** Interrupt the turn (best-effort) and remove the scratch dir. Never throws. */
async function teardown(
  handle: TurnHandle | undefined,
  dir: string | undefined,
): Promise<void> {
  if (handle) {
    await handle.interrupt().catch(() => {});
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * True if a process whose command line references the (unique) scratch dir still exists.
 * Polls `pgrep -f <dir>` (arg array) until the match clears or the timeout elapses. pgrep
 * exits nonzero when there is no match, which `reject: false` surfaces as an empty stdout.
 */
async function orphanSurvives(dir: string): Promise<boolean> {
  const deadline = Date.now() + ORPHAN_POLL_TIMEOUT_MS;
  for (;;) {
    const { stdout } = await execa('pgrep', ['-f', dir], { reject: false });
    if (stdout.trim() === '') {
      return false;
    }
    if (Date.now() >= deadline) {
      return true;
    }
    await delay(ORPHAN_POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Sink + turn helpers
// ---------------------------------------------------------------------------

/** Base turn options for a live probe: the scratch dir is the ONLY workspace path used. */
function turnOpts(workspaceDir: string, prompt: string): StartTurnOpts {
  return {
    workspaceDir,
    prompt,
    attachments: [],
    mcpConfig: [],
    permissionPolicy: {},
  };
}

/**
 * A capturing sink that records every event and resolves `terminal` with the first terminal
 * event (`turn_end`/`error`), or `null` if the stream ends/errors without one.
 */
function capturingSink(): {
  sink: StreamSink<AgentEvent>;
  events: AgentEvent[];
  terminal: Promise<AgentEvent | null>;
} {
  const events: AgentEvent[] = [];
  let resolveTerminal: (e: AgentEvent | null) => void = () => {};
  let settled = false;
  const terminal = new Promise<AgentEvent | null>((resolve) => {
    resolveTerminal = (e) => {
      if (settled) return;
      settled = true;
      resolve(e);
    };
  });
  return {
    events,
    terminal,
    sink: {
      push: (e) => {
        events.push(e);
        if (e.kind === 'turn_end' || e.kind === 'error') {
          resolveTerminal(e);
        }
      },
      end: () => resolveTerminal(null),
      error: () => resolveTerminal(null),
    },
  };
}

/**
 * Await the terminal event or the timeout. Returns the terminal `AgentEvent`, or `undefined`
 * if the timeout elapsed OR the stream closed without a terminal event.
 */
async function waitForTerminal(
  terminal: Promise<AgentEvent | null>,
  timeoutMs: number,
): Promise<AgentEvent | undefined> {
  // Wrap the terminal result so the timeout (a bare `null`) is unambiguously distinct from
  // a stream that closed without a terminal event (also surfaced as `undefined` below).
  const raced = await Promise.race([
    terminal.then((event) => ({ event })),
    delay(timeoutMs).then(() => null),
  ]);
  if (raced === null || raced.event === null) {
    return undefined;
  }
  return raced.event;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function pass(name: string, detail: string): BenchProbeResult {
  return { name, verdict: 'pass', detail };
}

function drift(name: string, detail: string): BenchProbeResult {
  return { name, verdict: 'drift', detail };
}

/**
 * Sanitized failure reason. For an execa error, prefer `shortMessage` (command + exit code)
 * over `message`, which embeds captured stdout/stderr — those can carry prompt/secret
 * fragments and must never reach a report. Other errors surface only their `.message`.
 */
function safeErrDetail(err: unknown): string {
  if (
    err !== null &&
    typeof err === 'object' &&
    'shortMessage' in err &&
    typeof (err as { shortMessage: unknown }).shortMessage === 'string'
  ) {
    return (err as { shortMessage: string }).shortMessage;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
