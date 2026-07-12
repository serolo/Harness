// Layer-2 live-CLI conformance probes (Phase 8, plan Task 7). ENV-GATED: the entire
// suite is `describe.skipIf`'d unless `AGENTAPP_BENCH_LIVE === '1'`, so it contributes
// ZERO work to the default gate (no detect, no spawn, no network) — it reports as skipped
// locally and only ever runs in the nightly workflow (`harness-bench-nightly.yml`).
//
// What it asserts (DoD bullet 5): each probe COMPLETES with a defined verdict. It does NOT
// assert `pass` — an expected codex `drift`/`skip` is a recorded FINDING, not a test
// failure. A missing CLI (`detect().installed === false`) records a single `skip` and never
// fails the run (ticket §7). Every harness's aggregate `BenchReport` is written to the
// in-memory `BenchReportStore` and, when `BENCH_REPORT_DIR` is set, to a JSON artifact file.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import type {
  BenchProbeResult,
  BenchReport,
  BenchVerdict,
} from '@shared/bench';
import type { Harness, HarnessId } from '@shared/harness';

import { ClaudeCodeHarness } from '../claude-code';
import { CodexHarness } from '../codex';
import { CursorHarness } from '../cursor';
import type { RawPtySpawner } from '../raw-terminal';
import { ProcessRegistry } from '../../process';
import { PtyService } from '../../pty';
import { runBasicTurn, runPolicyTurn, runInterrupt } from './live-probes';
import { BenchReportStore } from './runner';

/** Live turns are slow; give each harness room for detect + three full-length probes. */
const HARNESS_PROBE_TIMEOUT_MS = 600_000;

const LIVE = process.env['AGENTAPP_BENCH_LIVE'] === '1';
const VALID_VERDICTS: ReadonlySet<BenchVerdict> = new Set([
  'pass',
  'drift',
  'skip',
]);

/**
 * Build the three real adapters. Cursor has no structured stream, so it runs through the
 * raw-terminal fallback: `PtyService.spawnRaw` structurally satisfies `RawPtySpawner` (it
 * surfaces the exit code the transcript needs), mirroring `src/main/index.ts:421-423`.
 * Constructed lazily (inside the gated suite) so an unset env var spawns/allocates nothing.
 */
function buildHarnesses(): Harness[] {
  const registry = new ProcessRegistry();
  const pty = new PtyService(registry);
  const rawPtySpawner: RawPtySpawner = {
    spawn: (options) => pty.spawnRaw(options),
  };
  return [
    new ClaudeCodeHarness(),
    new CodexHarness(),
    new CursorHarness(rawPtySpawner),
  ];
}

/** Persist a report to the store and, when `BENCH_REPORT_DIR` is set, to a JSON artifact. */
function persist(store: BenchReportStore, report: BenchReport): void {
  store.set(report);
  const dir = process.env['BENCH_REPORT_DIR'];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${report.harnessId}-layer2.json`),
      JSON.stringify(report, null, 2),
    );
  }
}

describe.skipIf(!LIVE)('live-probes (Layer 2, AGENTAPP_BENCH_LIVE)', () => {
  const store = new BenchReportStore();

  for (const harness of buildHarnesses()) {
    const id: HarnessId = harness.id;

    it(
      `${id}: detect then probe (or skip on a missing CLI)`,
      async () => {
        const ranAt = new Date().toISOString();
        let results: BenchProbeResult[];

        const detect = await harness.detect();
        if (!detect.installed) {
          // A missing CLI is a `skip`, never a failure (ticket §7).
          results = [
            {
              name: 'detect',
              verdict: 'skip',
              detail: `${id} CLI not installed on this runner`,
            },
          ];
        } else {
          // Sequential (not parallel): each probe mints its own scratch repo, but running one
          // turn at a time keeps the orphan poll in `runInterrupt` unambiguous.
          results = [
            await runBasicTurn(harness),
            await runPolicyTurn(harness),
            await runInterrupt(harness),
          ];
        }

        const report: BenchReport = { harnessId: id, layer: 2, results, ranAt };
        persist(store, report);

        // The assertion is COMPLETION, not success: every probe must yield a defined verdict
        // from the three-valued set. A `drift`/`skip` is a finding to inspect, not a failure.
        expect(results.length).toBeGreaterThan(0);
        for (const result of results) {
          expect(
            VALID_VERDICTS.has(result.verdict),
            `${result.name} has an unexpected verdict: ${String(result.verdict)}`,
          ).toBe(true);
        }
        expect(store.get(id)).toBe(report);
      },
      HARNESS_PROBE_TIMEOUT_MS,
    );
  }
});
