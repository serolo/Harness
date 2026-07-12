// Layer-1 conformance bench tests (Phase 8, plan Task 5). Runs INSIDE the default gate,
// so this suite stays OFFLINE and FAST: no spawn, no network, a tiny idle timer for the
// raw-terminal replay (`runLayer1` itself picks `RAW_REPLAY_IDLE_MS` — see `./runner`).
//
// Four required groups (plan Task 5):
//   1. Pass case per registered harness — real fixtures, no `drift` (skips allowed).
//   2. MockHarness coverage — deterministic in-process script, no fixtures.
//   3. Fail-closed regression — THE core invariant (DoD bullet 3): a profile that claims
//      a kind the real replay provably never produces must `drift`, never `skip`/`pass`.
//   4. No-fixtures case — `{ files: [] }` yields a single `skip`, never `pass`.
// Plus a `BenchReportStore` set/get round-trip.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

import type { BenchProfile } from '@shared/bench';
import type { AgentEvent, StartTurnOpts } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';

import { MockHarness } from '../mock';
import { BENCH_PROFILES, MOCK_BENCH_PROFILE } from './profiles';
import { runLayer1, BenchReportStore } from './runner';

/**
 * Absolute paths of every file directly under `../fixtures/<subdir>` whose name ends
 * `ext`, sorted for deterministic ordering. `subdir` is `''` for the top-level
 * claude_code fixtures. Mirrors `codex.test.ts`'s `fileURLToPath(new URL(...))` pattern.
 */
function fixtureFiles(subdir: string, ext: string): string[] {
  const dir = fileURLToPath(new URL(`../fixtures/${subdir}`, import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith(ext))
    .sort()
    .map((name) => join(dir, name));
}

const claudeCodeFixtures = fixtureFiles('', '.jsonl');
const codexFixtures = fixtureFiles('codex', '.jsonl');
const cursorFixtures = fixtureFiles('cursor', '.txt');

// ---------------------------------------------------------------------------
// Group 1 — pass case per registered harness (no drift; skips allowed)
// ---------------------------------------------------------------------------

describe('runLayer1 — pass case per registered harness', () => {
  /** No result may be `drift`; render any offender's name+detail into the failure message. */
  function expectNoDrift(
    results: { name: string; verdict: string; detail?: string }[],
  ): void {
    const drifted = results.filter((r) => r.verdict === 'drift');
    expect(
      drifted,
      `unexpected drift: ${drifted.map((d) => `${d.name} (${d.detail ?? 'no detail'})`).join('; ')}`,
    ).toEqual([]);
  }

  it('claude_code: real fixtures produce no drift against BENCH_PROFILES.claude_code', async () => {
    expect(claudeCodeFixtures.length).toBeGreaterThan(0); // sanity: fixtures were found
    const report = await runLayer1(BENCH_PROFILES.claude_code, {
      files: claudeCodeFixtures,
    });
    expect(report.harnessId).toBe('claude_code');
    expect(report.layer).toBe(1);
    expectNoDrift(report.results);
  });

  it('codex: real fixtures produce no drift against BENCH_PROFILES.codex', async () => {
    expect(codexFixtures.length).toBeGreaterThan(0);
    const report = await runLayer1(BENCH_PROFILES.codex, {
      files: codexFixtures,
    });
    expect(report.harnessId).toBe('codex');
    expectNoDrift(report.results);
  });

  it('cursor: real fixtures produce no drift against BENCH_PROFILES.cursor', async () => {
    expect(cursorFixtures.length).toBeGreaterThan(0);
    const report = await runLayer1(BENCH_PROFILES.cursor, {
      files: cursorFixtures,
    });
    expect(report.harnessId).toBe('cursor');
    expectNoDrift(report.results);
    // Cursor declares three capability flags false and one (rawTerminalFallback) true;
    // the true one is a spawn/argv affordance, so it must SKIP, never silently pass.
    const rawFallback = report.results.find(
      (r) => r.name === 'capability:rawTerminalFallback',
    );
    expect(rawFallback?.verdict).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// Group 2 — MockHarness coverage (deterministic, in-process — no fixtures)
// ---------------------------------------------------------------------------

describe('MockHarness coverage against MOCK_BENCH_PROFILE', () => {
  it('emits every kind declared in MOCK_BENCH_PROFILE.expectedEventKinds', async () => {
    vi.useFakeTimers();
    try {
      const harness = new MockHarness({ defaultDelayMs: 1 });
      const events: AgentEvent[] = [];
      const sink: StreamSink<AgentEvent> = {
        push: (e) => events.push(e),
        end: () => {},
        error: () => {},
      };
      const opts: StartTurnOpts = {
        workspaceDir: '/bench/mock',
        prompt: 'say hi and track a todo',
        attachments: [],
        mcpConfig: [],
        permissionPolicy: {},
      };

      await harness.startTurn(opts, sink);
      await vi.runAllTimersAsync();

      const seenKinds = new Set(events.map((e) => e.kind));
      const missing = MOCK_BENCH_PROFILE.expectedEventKinds.filter(
        (kind) => !seenKinds.has(kind),
      );
      expect(missing, `missing kinds: ${missing.join(', ')}`).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Group 3 — fail-closed regression (THE core invariant, DoD bullet 3)
// ---------------------------------------------------------------------------

describe('runLayer1 — fail-closed regression', () => {
  it('a claimed kind the real raw-terminal replay never produces yields drift, never skip/pass', async () => {
    // The raw-terminal transport (cursor) only ever emits text/turn_end/error (see
    // BENCH_PROFILES.cursor's comment + RawTerminalTranscript) — there is no code path
    // that produces a structured todo_update from a PTY byte stream. Claim it anyway.
    const mismatchedProfile: BenchProfile = {
      ...BENCH_PROFILES.cursor,
      expectedEventKinds: [
        ...BENCH_PROFILES.cursor.expectedEventKinds,
        'todo_update',
      ],
    };

    const report = await runLayer1(mismatchedProfile, {
      files: cursorFixtures,
    });

    const kindsResult = report.results.find(
      (r) => r.name === 'expectedEventKinds',
    );
    expect(kindsResult).toBeDefined();
    // The core invariant: a mismatch is NEVER silently tolerated. Assert the exact verdict
    // AND explicitly rule out the two ways a bench could quietly swallow the drift.
    expect(kindsResult!.verdict).toBe('drift');
    expect(kindsResult!.verdict).not.toBe('skip');
    expect(kindsResult!.verdict).not.toBe('pass');
    expect(kindsResult!.detail).toContain('todo_update');
  });
});

// ---------------------------------------------------------------------------
// Group 4 — no-fixtures case
// ---------------------------------------------------------------------------

describe('runLayer1 — no fixtures provided', () => {
  it('yields exactly one skip result with a non-empty detail, never pass', async () => {
    const report = await runLayer1(BENCH_PROFILES.claude_code, { files: [] });

    expect(report.results).toHaveLength(1);
    expect(report.results[0].verdict).toBe('skip');
    expect(report.results[0].verdict).not.toBe('pass');
    expect(report.results[0].detail).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// BenchReportStore — set/get round trip
// ---------------------------------------------------------------------------

describe('BenchReportStore', () => {
  it('round-trips the latest report per harness id and defaults to undefined', async () => {
    const store = new BenchReportStore();
    expect(store.get('claude_code')).toBeUndefined();

    const report = await runLayer1(BENCH_PROFILES.claude_code, {
      files: claudeCodeFixtures,
    });
    store.set(report);

    expect(store.get('claude_code')).toBe(report);
    expect(store.get('codex')).toBeUndefined();

    // A second `set` for the same id replaces (not appends) the stored report.
    const secondReport = await runLayer1(BENCH_PROFILES.claude_code, {
      files: [],
    });
    store.set(secondReport);
    expect(store.get('claude_code')).toBe(secondReport);
  });
});
