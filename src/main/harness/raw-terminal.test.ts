// RawTerminalTranscript (phase-7 Task 2): raw PTY output → `text` AgentEvents + a
// best-effort idle turn boundary, with a terminal event guaranteed on every path. Driven
// by a FAKE injected spawner — no real PTY, no native module — so it runs anywhere the
// suite does. Idle-timeout behaviour is exercised with vitest fake timers.

import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent, StartTurnOpts } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import {
  RawTerminalTranscript,
  DEFAULT_IDLE_TIMEOUT_MS,
  type RawPtyHandle,
  type RawPtySpawner,
  type RawPtySpawnOptions,
} from './raw-terminal';

/** A recording sink that collects pushed events and end/error signals. */
function recordingSink(): {
  sink: StreamSink<AgentEvent>;
  events: AgentEvent[];
  endCount: () => number;
} {
  const events: AgentEvent[] = [];
  let ends = 0;
  return {
    events,
    endCount: () => ends,
    sink: {
      push: (e) => events.push(e),
      end: () => {
        ends += 1;
      },
      error: () => {
        ends += 1;
      },
    },
  };
}

/**
 * A controllable fake PTY: tests trigger output/exit manually. `kill()` records the call
 * and (like real node-pty) fires `onExit` unless `killFiresExit` is disabled — letting a
 * test isolate the idle-boundary finalize from the exit-driven one.
 */
function fakeSpawner(opts: { killFiresExit?: boolean } = {}): {
  spawner: RawPtySpawner;
  emit: (chunk: string) => void;
  exit: (code: number) => void;
  spawnOptions: () => RawPtySpawnOptions | undefined;
  killed: () => boolean;
} {
  const killFiresExit = opts.killFiresExit ?? true;
  let dataCb: ((chunk: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  let seen: RawPtySpawnOptions | undefined;
  let wasKilled = false;
  let exited = false;

  const fireExit = (code: number): void => {
    if (exited) return;
    exited = true;
    exitCb?.({ exitCode: code });
  };

  const handle: RawPtyHandle = {
    ptyId: 'pty-test-1',
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: () => {
      wasKilled = true;
      if (killFiresExit) fireExit(0);
    },
  };

  return {
    spawner: {
      spawn: (options) => {
        seen = options;
        return Promise.resolve(handle);
      },
    },
    emit: (chunk) => dataCb?.(chunk),
    exit: (code) => fireExit(code),
    spawnOptions: () => seen,
    killed: () => wasKilled,
  };
}

const baseOpts: StartTurnOpts = {
  workspaceDir: '/tmp/ws',
  prompt: 'fix the bug',
  attachments: [],
  mcpConfig: [],
  permissionPolicy: {},
};

const command = (): { shell: string; args: string[] } => ({
  shell: 'cursor-agent',
  args: ['--prompt', 'fix the bug'],
});

describe('RawTerminalTranscript', () => {
  it('spawns the CLI in the workspace cwd with an argument array', async () => {
    const fake = fakeSpawner();
    const driver = new RawTerminalTranscript({
      spawner: fake.spawner,
      command,
    });
    const { sink } = recordingSink();

    await driver.startTurn(baseOpts, sink);

    const spawned = fake.spawnOptions();
    expect(spawned?.cwd).toBe('/tmp/ws');
    expect(spawned?.shell).toBe('cursor-agent');
    expect(spawned?.args).toEqual(['--prompt', 'fix the bug']);
  });

  it('forwards raw output chunks as text events in order', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSpawner();
      const driver = new RawTerminalTranscript({
        spawner: fake.spawner,
        command,
      });
      const { sink, events } = recordingSink();

      await driver.startTurn(baseOpts, sink);
      fake.emit('hello ');
      fake.emit('world');

      const texts = events.filter((e) => e.kind === 'text');
      expect(texts).toEqual([
        { kind: 'text', delta: 'hello ' },
        { kind: 'text', delta: 'world' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires a single turn_end when the idle-timeout heuristic elapses', async () => {
    vi.useFakeTimers();
    try {
      // killFiresExit off so ONLY the idle-boundary finalize can emit the terminal.
      const fake = fakeSpawner({ killFiresExit: false });
      const driver = new RawTerminalTranscript({
        spawner: fake.spawner,
        command,
      });
      const { sink, events, endCount } = recordingSink();

      await driver.startTurn(baseOpts, sink);
      fake.emit('some output');

      // Not idle yet — advance just short of the boundary.
      await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS - 1);
      expect(events.some((e) => e.kind === 'turn_end')).toBe(false);

      // Cross the idle boundary.
      await vi.advanceTimersByTimeAsync(1);

      const terminals = events.filter(
        (e) => e.kind === 'turn_end' || e.kind === 'error',
      );
      expect(terminals).toEqual([{ kind: 'turn_end' }]);
      expect(fake.killed()).toBe(true); // boundary kills the PTY
      expect(endCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the idle timer on each chunk (does not finalize while streaming)', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSpawner({ killFiresExit: false });
      const driver = new RawTerminalTranscript({
        spawner: fake.spawner,
        command,
        idleTimeoutMs: 100,
      });
      const { sink, events } = recordingSink();

      await driver.startTurn(baseOpts, sink);
      // A chunk every 60ms keeps resetting the 100ms idle timer.
      for (let i = 0; i < 5; i++) {
        fake.emit(`chunk-${i}`);
        await vi.advanceTimersByTimeAsync(60);
      }
      expect(events.some((e) => e.kind === 'turn_end')).toBe(false);

      // Now go quiet past the timeout → boundary fires once.
      await vi.advanceTimersByTimeAsync(100);
      expect(events.filter((e) => e.kind === 'turn_end')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('yields a terminal error on nonzero PTY exit', async () => {
    const fake = fakeSpawner();
    const driver = new RawTerminalTranscript({
      spawner: fake.spawner,
      command,
    });
    const { sink, events, endCount } = recordingSink();

    await driver.startTurn(baseOpts, sink);
    fake.emit('partial output');
    fake.exit(1);

    const terminals = events.filter(
      (e) => e.kind === 'turn_end' || e.kind === 'error',
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ kind: 'error' });
    expect(endCount()).toBe(1);
  });

  it('finalizes with turn_end on a clean PTY exit', async () => {
    const fake = fakeSpawner();
    const driver = new RawTerminalTranscript({
      spawner: fake.spawner,
      command,
    });
    const { sink, events } = recordingSink();

    await driver.startTurn(baseOpts, sink);
    fake.exit(0);

    expect(events.filter((e) => e.kind === 'turn_end')).toHaveLength(1);
  });

  it('interrupt kills the PTY and still finalizes exactly once', async () => {
    const fake = fakeSpawner();
    const driver = new RawTerminalTranscript({
      spawner: fake.spawner,
      command,
    });
    const { sink, events, endCount } = recordingSink();

    const handle = await driver.startTurn(baseOpts, sink);
    fake.emit('working...');
    await handle.interrupt();

    expect(fake.killed()).toBe(true);
    const terminals = events.filter(
      (e) => e.kind === 'turn_end' || e.kind === 'error',
    );
    expect(terminals).toHaveLength(1);
    expect(endCount()).toBe(1);
  });

  it('emits the terminal event exactly once across overlapping paths', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSpawner();
      const driver = new RawTerminalTranscript({
        spawner: fake.spawner,
        command,
      });
      const { sink, events, endCount } = recordingSink();

      const handle = await driver.startTurn(baseOpts, sink);
      fake.emit('output');

      // Trip every terminal path: idle boundary, an explicit exit, and interrupt.
      await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS);
      fake.exit(1);
      await handle.interrupt();

      const terminals = events.filter(
        (e) => e.kind === 'turn_end' || e.kind === 'error',
      );
      expect(terminals).toHaveLength(1);
      expect(endCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
