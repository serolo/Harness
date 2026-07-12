// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
//
// Harness Conformance Bench types (Phase 8, plan §3.1). These are the DTOs the
// offline Layer-1 fixture-replay bench (`src/main/harness/bench/runner.ts`), the
// env-gated Layer-2 live probes (`src/main/harness/bench/live-probes.ts`), and the
// `harness:benchReport` diagnostics IPC command exchange.
//
// This file is import-safe from BOTH processes: it imports ONLY type-level symbols
// from `./harness` (no `electron`, no Node-only, no DOM-only imports), like every
// other module under `src/shared/**`.
//
// A "verdict" is deliberately three-valued, NOT boolean:
//   - `pass`  — the declared behaviour was observed (or its absence is trivially
//               consistent, e.g. a capability flag declared `false`).
//   - `drift` — the profile claims something the fixtures/probes contradict. This
//               is the fail signal the bench exists to raise.
//   - `skip`  — the property is not observable through the available evidence
//               channel (e.g. spawn-time affordances that no recorded fixture can
//               witness), or there was no fixture to replay. NEVER a fabricated
//               `pass` — a `skip` records "unknown", not "fine".

import type { AgentEvent, HarnessCapabilities, HarnessId } from './harness';

/** Outcome of a single conformance probe (see the file header for the semantics). */
export type BenchVerdict = 'pass' | 'drift' | 'skip';

/**
 * The result of one named probe. `detail` carries only diagnostic NAMES and COUNTS
 * (e.g. which event kinds were missing) — never fixture content, CLI output, or any
 * secret-bearing value (mirrors the "length only" logging convention in `parser.ts`).
 */
export interface BenchProbeResult {
  name: string;
  verdict: BenchVerdict;
  detail?: string;
}

/**
 * The declared, expected behaviour of one harness adapter — the reference the bench
 * asserts reality against. `capabilities` is the adapter's own `capabilities()`
 * return value; `expectedEventKinds` is the union of `AgentEvent` kinds the adapter's
 * normalization path is expected to emit across its fixtures.
 */
export interface BenchProfile {
  harnessId: HarnessId;
  transport: 'json_stream' | 'raw_terminal';
  capabilities: HarnessCapabilities;
  expectedEventKinds: AgentEvent['kind'][];
}

/**
 * The result of running one bench layer against one harness: an ordered list of
 * probe results plus an ISO-8601 capture timestamp. `layer` is `1` (offline
 * fixture replay, default gate) or `2` (env-gated live CLI probes, nightly).
 */
export interface BenchReport {
  harnessId: HarnessId;
  layer: 1 | 2;
  results: BenchProbeResult[];
  ranAt: string;
}
