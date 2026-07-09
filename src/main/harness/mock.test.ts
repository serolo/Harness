// MockHarness: deterministic scripted AgentEvent streaming (Phase 2, Task 3). Pure —
// no child process, no Electron — so it runs anywhere the suite does.

import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import { MockHarness } from './mock';

/** A recording sink that collects pushed events and end/error signals. */
function recordingSink(): {
  sink: StreamSink<AgentEvent>;
  events: AgentEvent[];
  ended: () => boolean;
} {
  const events: AgentEvent[] = [];
  let ended = false;
  return {
    events,
    ended: () => ended,
    sink: {
      push: (e) => events.push(e),
      end: () => {
        ended = true;
      },
      error: () => {
        ended = true;
      },
    },
  };
}

const baseOpts = {
  workspaceDir: '/tmp/ws',
  prompt: 'fix the bug',
  attachments: [],
  mcpConfig: [],
  permissionPolicy: {},
};

describe('MockHarness', () => {
  it('streams scripted events and ends with a terminal turn_end', async () => {
    vi.useFakeTimers();
    try {
      const harness = new MockHarness({ defaultDelayMs: 1 });
      const { sink, events, ended } = recordingSink();

      const handle = await harness.startTurn({ ...baseOpts }, sink);
      expect(handle.sessionId).toBe('mock-session-1');

      await vi.runAllTimersAsync();

      expect(ended()).toBe(true);
      const last = events[events.length - 1];
      expect(last.kind).toBe('turn_end');
      expect(events.some((e) => e.kind === 'text')).toBe(true);
      expect(events.some((e) => e.kind === 'todo_update')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('echoes the resume session id when one is provided', async () => {
    const harness = new MockHarness({ defaultDelayMs: 0 });
    const { sink } = recordingSink();
    const handle = await harness.startTurn(
      { ...baseOpts, sessionId: 'resume-me' },
      sink,
    );
    expect(handle.sessionId).toBe('resume-me');
  });

  it('interrupt emits a terminal turn_end and ends the stream', async () => {
    vi.useFakeTimers();
    try {
      // A long script so interrupt lands mid-stream.
      const harness = new MockHarness({
        defaultDelayMs: 10,
        script: () => [
          { event: { kind: 'text', delta: 'a' } },
          { event: { kind: 'text', delta: 'b' } },
          { event: { kind: 'text', delta: 'c' } },
          { event: { kind: 'turn_end' } },
        ],
      });
      const { sink, events, ended } = recordingSink();

      const handle = await harness.startTurn({ ...baseOpts }, sink);
      await vi.advanceTimersByTimeAsync(10); // let the first event fire
      await handle.interrupt();
      await vi.runAllTimersAsync();

      expect(ended()).toBe(true);
      expect(events[events.length - 1].kind).toBe('turn_end');
      // It stopped early — not all three text deltas were emitted.
      expect(events.filter((e) => e.kind === 'text').length).toBeLessThan(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detect reports installed + authenticated', async () => {
    const harness = new MockHarness();
    const result = await harness.detect();
    expect(result).toEqual({
      installed: true,
      version: 'mock-1.0.0',
      authenticated: true,
    });
  });
});
