// Harness Conformance Bench — Layer 1 (offline fixture replay). Phase 8, plan Task 4.
//
// WHAT THIS PROVES (and, crucially, what it does NOT): Layer 1 asserts that each
// adapter's DECLARED profile (`./profiles`) is CONSISTENT with the `AgentEvent` stream
// its REAL normalization path produces from recorded fixtures. It is a fixtures↔profile
// tripwire, NOT a live-CLI conformance check — the fixtures are hand-authored samples
// (see the adapters' headers), so a green Layer 1 does not prove fidelity to the current
// CLI output. Live-CLI conformance is Layer 2 (`./live-probes`, env-gated, nightly).
//
// NO BENCH-LOCAL PARSING: replay funnels through the adapters' OWN exported functions —
// `createJsonLineSplitter()` + `normalize()` (claude_code), `normalizeCodex()` (codex),
// and the real `RawTerminalTranscript` (cursor). The bench never re-implements a parser;
// if an adapter changes how it maps a stream, this module sees the change automatically.
//
// SECURITY / SCOPE: this module READS the files it is handed and SPAWNS NOTHING. Its
// callers (the Layer-1 tests) only ever hand it paths under `../fixtures/**`. It is
// deliberately native-free (no `better-sqlite3` / `node-pty` in its import graph, like
// `raw-terminal.ts`) — the only PTY it touches is a FAKE in-process spawner used to drive
// the real transcript driver. `detail` strings carry only kind/flag NAMES and COUNTS —
// never fixture content (mirrors the "length only" convention in `parser.ts`).

import { readFileSync } from 'node:fs';

import type {
  BenchProbeResult,
  BenchProfile,
  BenchReport,
  BenchVerdict,
} from '@shared/bench';
import type { AgentEvent, HarnessId, StartTurnOpts } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';

import { normalize } from '../parser';
import { createJsonLineSplitter } from '../parser';
import { normalizeCodex } from '../codex';
import {
  RawTerminalTranscript,
  type RawPtyHandle,
  type RawPtySpawner,
} from '../raw-terminal';

/** A set of fixture files to replay, as ABSOLUTE paths (resolved by the caller). */
export interface FixtureSet {
  files: string[];
}

/**
 * The aggregated evidence gathered from replaying a fixture union: which `AgentEvent`
 * kinds were seen, whether a session id was captured (resume evidence), and whether an
 * MCP-shaped `tool_use` (`name` starting `mcp__`) was seen (MCP evidence).
 */
interface ReplayEvidence {
  seenKinds: Set<AgentEvent['kind']>;
  sawSession: boolean;
  sawMcpToolUse: boolean;
}

/** Idle timeout for the fake raw replay — tiny; the explicit exit drives finalization. */
const RAW_REPLAY_IDLE_MS = 10;

/** Dummy turn options for the raw replay: the fake spawner ignores everything but shape. */
const RAW_REPLAY_OPTS: StartTurnOpts = {
  workspaceDir: '/bench/replay',
  prompt: '',
  attachments: [],
  mcpConfig: [],
  permissionPolicy: {},
};

/**
 * Replay a fixture set through the harness's REAL normalization path and grade the
 * declared `profile` against the observed evidence. Async because the `raw_terminal`
 * transport replays through the timer-driven `RawTerminalTranscript` (plan finding 5).
 *
 * Empty `fixtures.files` yields a single `skip` result (never `pass`): there is nothing
 * to assert, and silently passing would be false confidence.
 */
export async function runLayer1(
  profile: BenchProfile,
  fixtures: FixtureSet,
): Promise<BenchReport> {
  const ranAt = new Date().toISOString();

  if (fixtures.files.length === 0) {
    return {
      harnessId: profile.harnessId,
      layer: 1,
      ranAt,
      results: [
        {
          name: 'fixtures',
          verdict: 'skip',
          detail: 'no fixture files provided — nothing to replay',
        },
      ],
    };
  }

  const evidence =
    profile.transport === 'raw_terminal'
      ? await replayRawFixtures(fixtures.files)
      : replayJsonFixtures(profile.harnessId, fixtures.files);

  const results: BenchProbeResult[] = [
    gradeExpectedKinds(profile, evidence),
    gradeCapability('supportsResume', profile, evidence),
    gradeCapability('supportsMcp', profile, evidence),
    gradeCapability('supportsPlanMode', profile, evidence),
    gradeCapability('rawTerminalFallback', profile, evidence),
  ];

  return { harnessId: profile.harnessId, layer: 1, ranAt, results };
}

// ---------------------------------------------------------------------------
// JSON-stream replay (claude_code / codex) — through the adapters' own functions
// ---------------------------------------------------------------------------

/**
 * Replay newline-delimited-JSON fixtures through the SAME funnel the adapter uses:
 * `createJsonLineSplitter()` → `normalize()` (claude_code) or `normalizeCodex()` (codex).
 * Dispatch is on `harnessId`; there is no bench-local parsing.
 */
function replayJsonFixtures(
  harnessId: HarnessId,
  files: string[],
): ReplayEvidence {
  const evidence = emptyEvidence();
  // Pick the adapter's real normalizer. `normalize` and `normalizeCodex` share a shape:
  // each maps one object to zero-or-more results (`normalize`'s union also carries a `null`
  // placeholder that it never actually returns — guarded below for total safety).
  const normalizeOne: (
    obj: unknown,
  ) => ReadonlyArray<
    | { type: 'event'; event: AgentEvent }
    | { type: 'session'; sessionId: string }
    | null
  > = harnessId === 'codex' ? normalizeCodex : normalize;

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const splitter = createJsonLineSplitter();
    const objects = [...splitter.push(raw), ...splitter.flush()];
    for (const obj of objects) {
      for (const result of normalizeOne(obj)) {
        if (result === null) {
          continue;
        }
        if (result.type === 'session') {
          evidence.sawSession = true;
        } else {
          recordEvent(evidence, result.event);
        }
      }
    }
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Raw-terminal replay (cursor) — through the REAL RawTerminalTranscript driver
// ---------------------------------------------------------------------------

/**
 * Replay raw transcript fixtures through the real `RawTerminalTranscript` using a FAKE
 * in-process spawner (no native PTY). Each file is replayed once with a clean exit (0) →
 * `text` chunks + a terminal `turn_end`. One additional synthetic replay uses a nonzero
 * exit so the `error` kind is evidenced (a recorded transcript can't carry an exit code).
 */
async function replayRawFixtures(files: string[]): Promise<ReplayEvidence> {
  const evidence = emptyEvidence();

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    recordEvents(evidence, await replayRawOnce(text, 0));
  }

  // Synthetic nonzero-exit replay: the only way to witness the `error` terminal kind, which
  // depends on the PTY exit CODE (absent from any recorded transcript). Reuse the first
  // fixture's text so the run still streams `text` before erroring.
  const errorText = files.length > 0 ? readFileSync(files[0], 'utf8') : '';
  recordEvents(evidence, await replayRawOnce(errorText, 1));

  return evidence;
}

/**
 * Drive one raw-terminal turn to completion against a fake spawner: register the driver's
 * listeners (via `startTurn`), then replay the transcript as a single `onData` chunk and
 * fire `onExit` with `exitCode`. Returns the events the driver pushed to the sink.
 */
async function replayRawOnce(
  text: string,
  exitCode: number,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const sink: StreamSink<AgentEvent> = {
    push: (e) => events.push(e),
    end: () => {},
    error: () => {},
  };

  let dataCb: ((chunk: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  const handle: RawPtyHandle = {
    ptyId: 'bench-raw-replay',
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    // No-op: the terminal event is driven by the explicit `exitCb` call below, before the
    // (10ms) idle timer can fire, so `kill()` is never the finalizer in this replay.
    kill: () => {},
  };
  const spawner: RawPtySpawner = { spawn: () => Promise.resolve(handle) };

  const transcript = new RawTerminalTranscript({
    spawner,
    command: () => ({ shell: 'bench-raw', args: [] }),
    idleTimeoutMs: RAW_REPLAY_IDLE_MS,
  });

  // startTurn resolves once listeners are registered; then we replay deterministically.
  await transcript.startTurn(RAW_REPLAY_OPTS, sink);
  if (text !== '') {
    dataCb?.(text);
  }
  exitCb?.({ exitCode });

  return events;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * Grade `expectedEventKinds`: every declared kind must be witnessed across the fixture
 * union, else `drift` naming the missing kinds (names + counts only — never content).
 */
function gradeExpectedKinds(
  profile: BenchProfile,
  evidence: ReplayEvidence,
): BenchProbeResult {
  const missing = profile.expectedEventKinds.filter(
    (kind) => !evidence.seenKinds.has(kind),
  );
  if (missing.length === 0) {
    return {
      name: 'expectedEventKinds',
      verdict: 'pass',
      detail: `all ${profile.expectedEventKinds.length} declared kinds observed`,
    };
  }
  return {
    name: 'expectedEventKinds',
    verdict: 'drift',
    detail: `missing ${missing.length} of ${profile.expectedEventKinds.length} declared kinds: ${missing.join(', ')}`,
  };
}

/**
 * Grade one capability flag against finding 6's evidence table:
 *   - flag `false`            → `pass` (absence isn't drift).
 *   - supportsResume `true`   → `pass` iff a session was captured, else `drift`.
 *   - supportsMcp `true`      → `pass` iff an `mcp__`-prefixed tool_use was seen, else `drift`.
 *   - supportsPlanMode `true` → `skip` (spawn/argv affordance, not observable from fixtures).
 *   - rawTerminalFallback `true` → `skip` (spawn affordance, not observable from fixtures).
 */
function gradeCapability(
  flag: keyof BenchProfile['capabilities'],
  profile: BenchProfile,
  evidence: ReplayEvidence,
): BenchProbeResult {
  const name = `capability:${flag}`;
  const declared = profile.capabilities[flag];

  if (!declared) {
    return {
      name,
      verdict: 'pass',
      detail: 'declared false — no evidence required (absence is not drift)',
    };
  }

  switch (flag) {
    case 'supportsResume':
      return verdictFromEvidence(
        name,
        evidence.sawSession,
        'session capture observed during replay',
        'declared true but no session capture observed in any fixture',
      );
    case 'supportsMcp':
      return verdictFromEvidence(
        name,
        evidence.sawMcpToolUse,
        'mcp__ tool_use observed during replay',
        'declared true but no mcp__ tool_use observed in any fixture',
      );
    case 'supportsPlanMode':
      return {
        name,
        verdict: 'skip',
        detail:
          'spawn/argv affordance — not observable from recorded fixtures (no false pass)',
      };
    case 'rawTerminalFallback':
      return {
        name,
        verdict: 'skip',
        detail:
          'spawn affordance — not observable from recorded fixtures (no false pass)',
      };
    default:
      // Exhaustive over the four HarnessCapabilities flags; keeps tsc honest if one is added.
      return { name, verdict: 'skip', detail: 'unknown capability flag' };
  }
}

/** pass/drift from a boolean evidence check, with fixed detail strings (names only). */
function verdictFromEvidence(
  name: string,
  hasEvidence: boolean,
  passDetail: string,
  driftDetail: string,
): BenchProbeResult {
  const verdict: BenchVerdict = hasEvidence ? 'pass' : 'drift';
  return { name, verdict, detail: hasEvidence ? passDetail : driftDetail };
}

// ---------------------------------------------------------------------------
// Evidence accumulation
// ---------------------------------------------------------------------------

function emptyEvidence(): ReplayEvidence {
  return {
    seenKinds: new Set<AgentEvent['kind']>(),
    sawSession: false,
    sawMcpToolUse: false,
  };
}

function recordEvents(evidence: ReplayEvidence, events: AgentEvent[]): void {
  for (const event of events) {
    recordEvent(evidence, event);
  }
}

function recordEvent(evidence: ReplayEvidence, event: AgentEvent): void {
  evidence.seenKinds.add(event.kind);
  if (event.kind === 'tool_use' && event.name.startsWith('mcp__')) {
    evidence.sawMcpToolUse = true;
  }
}

// ---------------------------------------------------------------------------
// In-memory report store (read by the `harness:benchReport` IPC handler)
// ---------------------------------------------------------------------------

/**
 * A tiny in-memory store of the latest `BenchReport` per harness id. The Layer-2 live
 * suite writes reports here; the `harness:benchReport` diagnostics command reads them.
 * Keyed by `HarnessId`, so at most one report per harness (the newest wins).
 */
export class BenchReportStore {
  private readonly reports = new Map<HarnessId, BenchReport>();

  /** Record (or replace) the report for a harness. */
  set(report: BenchReport): void {
    this.reports.set(report.harnessId, report);
  }

  /** The latest report for a harness, or `undefined` if none has been recorded. */
  get(id: HarnessId): BenchReport | undefined {
    return this.reports.get(id);
  }
}
