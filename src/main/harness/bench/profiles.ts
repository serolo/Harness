// Bench profiles (Phase 8, plan Task 2) — the DECLARED, expected behaviour of each
// harness adapter, which the Layer-1 fixture-replay bench (`./runner`) asserts reality
// against. There is intentionally NO codegen and NO import of the adapters here: each
// field below is a hand-transcribed snapshot of the adapter's real `capabilities()` +
// its normalization-table emit surface, taken at implementation time. If an adapter's
// `capabilities()` changes, this profile drifts from it and the bench + a human reviewer
// are the tripwire — that is the whole point.
//
// PROFILE ↔ TICKET RECONCILIATION (Phase 8 finding). The ticket §3.2 sketch listed
// ILLUSTRATIVE capability values that are WRONG for two adapters; these profiles use the
// REAL values read off the adapter source (the ticket itself instructs this reconciliation):
//   - claude_code (claude-code.ts:52-59): ALL FOUR flags `true`. Ticket sketch wrongly said
//     `rawTerminalFallback: false`.
//   - codex (codex.ts:73-78): supportsResume:true, supportsMcp:true, supportsPlanMode:false,
//     rawTerminalFallback:true. Ticket sketch wrongly said all four `false`.
//   - cursor (cursor.ts:79-84): supportsResume:false, supportsMcp:false, supportsPlanMode:false,
//     rawTerminalFallback:true — matches the sketch.
//
// EXPECTED-EVENT-KINDS reconciliation (verified against the recorded fixtures, not copied
// from the ticket): each list is the UNION of `AgentEvent` kinds the adapter's real
// normalization path emits across its fixture set (`../fixtures/**`).
//   - claude_code: all 7 kinds — text/tool_use/tool_result/file_edit/todo_update/turn_end/error
//     are each witnessed by an existing `.jsonl` fixture (todo_update by resume.jsonl's
//     TodoWrite; tool_result by tool_use.jsonl's user tool_result). `normalize()` (parser.ts)
//     is the source of truth.
//   - codex: `normalizeCodex()` (codex.ts) NEVER emits tool_result or todo_update — its table
//     has no path to either — so the ticket sketch's `tool_result` is DROPPED. The union is
//     text/tool_use/file_edit/turn_end/error.
//   - cursor: the raw-terminal transport only ever emits `text` per output chunk plus one
//     terminal `turn_end` (clean exit) or `error` (nonzero exit) — see RawTerminalTranscript.

import type { BenchProfile } from '@shared/bench';
import type { HarnessId } from '@shared/harness';

/**
 * The declared conformance profile for each registered harness id.
 *
 * NOTE: `MockHarness.id` is the frozen `'claude_code'` id (Open Decision D2, mock.ts:71),
 * so the mock cannot be a fourth key here — its profile is the separate
 * {@link MOCK_BENCH_PROFILE} used only by tests.
 */
export const BENCH_PROFILES: Record<HarnessId, BenchProfile> = {
  claude_code: {
    harnessId: 'claude_code',
    transport: 'json_stream',
    capabilities: {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: true,
      rawTerminalFallback: true,
      supportsMidTurnSteer: false,
    },
    expectedEventKinds: [
      'text',
      'tool_use',
      'tool_result',
      'file_edit',
      'todo_update',
      'turn_end',
      'error',
    ],
  },
  codex: {
    harnessId: 'codex',
    transport: 'json_stream',
    capabilities: {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: false,
      rawTerminalFallback: true,
      supportsMidTurnSteer: false,
    },
    // No tool_result / todo_update: normalizeCodex() has no path that emits them.
    expectedEventKinds: ['text', 'tool_use', 'file_edit', 'turn_end', 'error'],
  },
  cursor: {
    harnessId: 'cursor',
    transport: 'raw_terminal',
    capabilities: {
      supportsResume: false,
      supportsMcp: false,
      supportsPlanMode: false,
      rawTerminalFallback: true,
      supportsMidTurnSteer: false,
    },
    // Raw terminal: text per chunk + one terminal turn_end (exit 0) or error (nonzero exit).
    expectedEventKinds: ['text', 'turn_end', 'error'],
  },
};

/**
 * Profile for the deterministic {@link MockHarness} (finding 3). It reuses the frozen
 * `claude_code` id, so it lives OUTSIDE {@link BENCH_PROFILES} (which is keyed by
 * `HarnessId`) and is consumed only by tests. Capabilities are all `true` (mock.ts:84-91);
 * `expectedEventKinds` are exactly what the mock's default script emits (mock.ts:42-68):
 * text deltas, one todo_update, and a terminal turn_end.
 */
export const MOCK_BENCH_PROFILE: BenchProfile = {
  harnessId: 'claude_code',
  transport: 'json_stream',
  capabilities: {
    supportsResume: true,
    supportsMcp: true,
    supportsPlanMode: true,
    rawTerminalFallback: true,
    supportsMidTurnSteer: false,
  },
  expectedEventKinds: ['text', 'todo_update', 'turn_end'],
};
