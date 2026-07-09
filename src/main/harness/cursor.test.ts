// Contract tests for the Cursor harness adapter (plan Task 3). Cursor is a RAW-TERMINAL
// harness: it delegates `startTurn` to `RawTerminalTranscript` (Task 2), so these tests
// use the same FAKE-spawner pattern as `raw-terminal.test.ts` — no real `cursor-agent`
// process, no native PTY module. They prove: the degraded capability flags, the
// argument-array command builder (incl. the command-injection surface), attachment
// serialization, and that raw output chunks become ordered `text` events + one terminal
// event via the transcript.
//
// IMPORTANT — CLI-drift tripwire (plan §9): the fixtures under ./fixtures/cursor are
// HAND-AUTHORED raw terminal output, and the assumed `cursor-agent` argv is a re-pin
// point. These prove the adapter wiring, not fidelity to the real CLI.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import type { AgentEvent, StartTurnOpts } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import type {
  RawPtyHandle,
  RawPtySpawner,
  RawPtySpawnOptions,
} from './raw-terminal';
import { CursorHarness, CURSOR_BIN, buildCommand } from './cursor';

/** Read a raw Cursor fixture (resolved relative to this test) as a string. */
function readFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/cursor/${name}`, import.meta.url)),
    'utf8',
  );
}

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

/** A controllable fake PTY: tests trigger output/exit manually (mirrors raw-terminal.test.ts). */
function fakeSpawner(): {
  spawner: RawPtySpawner;
  emit: (chunk: string) => void;
  exit: (code: number) => void;
  spawnOptions: () => RawPtySpawnOptions | undefined;
} {
  let dataCb: ((chunk: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  let seen: RawPtySpawnOptions | undefined;
  let exited = false;

  const fireExit = (code: number): void => {
    if (exited) return;
    exited = true;
    exitCb?.({ exitCode: code });
  };

  const handle: RawPtyHandle = {
    ptyId: 'pty-cursor-test',
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: () => fireExit(0),
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
  };
}

/** Minimal valid StartTurnOpts, overridable per test. */
function opts(overrides: Partial<StartTurnOpts> = {}): StartTurnOpts {
  return {
    workspaceDir: '/tmp/ws',
    prompt: 'fix the bug',
    attachments: [],
    mcpConfig: [],
    permissionPolicy: {},
    ...overrides,
  };
}

describe('CursorHarness — capabilities & identity', () => {
  it('is the cursor harness and advertises only the raw-terminal fallback', () => {
    const harness = new CursorHarness(fakeSpawner().spawner);
    expect(harness.id).toBe('cursor');
    expect(harness.capabilities()).toEqual({
      supportsResume: false,
      supportsMcp: false,
      supportsPlanMode: false,
      rawTerminalFallback: true,
    });
  });

  it('detect() degrades to not-installed when cursor-agent is absent', async () => {
    // `cursor-agent` is not on PATH in the test environment → ENOENT → graceful degrade.
    const result = await new CursorHarness(fakeSpawner().spawner).detect();
    expect(result).toEqual({ installed: false, authenticated: false });
  });
});

describe('buildCommand — argument array (command-injection surface)', () => {
  it('runs cursor-agent -p with the prompt as the final discrete argument after `--`', () => {
    const cmd = buildCommand(opts());
    expect(cmd.shell).toBe(CURSOR_BIN);
    expect(cmd.args[0]).toBe('-p');
    // Prompt is its OWN array element, guarded by a `--` end-of-flags separator.
    expect(cmd.args[cmd.args.length - 2]).toBe('--');
    expect(cmd.args[cmd.args.length - 1]).toBe('fix the bug');
  });

  it('keeps a prompt with shell metacharacters as a single argument (no shell string)', () => {
    const nasty = 'do it; rm -rf / && echo $(whoami) `id`';
    const cmd = buildCommand(opts({ prompt: nasty }));
    // The whole malicious string is exactly one argv element — never split, never a
    // shell string — so nothing in it can be interpreted as a command.
    expect(cmd.args[cmd.args.length - 1]).toBe(nasty);
    expect(cmd.args.filter((a) => a === nasty)).toHaveLength(1);
  });

  it('maps auto_accept to --force but never emits a plan flag', () => {
    expect(buildCommand(opts({ mode: 'auto_accept' })).args).toContain(
      '--force',
    );
    const planArgs = buildCommand(opts({ mode: 'plan' })).args;
    expect(planArgs).not.toContain('--force');
    expect(planArgs.join(' ')).not.toContain('plan');
    expect(buildCommand(opts({ mode: 'default' })).args).not.toContain(
      '--force',
    );
  });

  it('serializes attachments into the single prompt argument', () => {
    const cmd = buildCommand(
      opts({ attachments: [{ type: 'file', path: '/repo/README.md' }] }),
    );
    const prompt = cmd.args[cmd.args.length - 1];
    expect(prompt).toContain('fix the bug');
    expect(prompt).toContain('[Attached file: /repo/README.md]');
  });
});

describe('CursorHarness.startTurn — raw transcript delegation', () => {
  it('spawns cursor-agent in the workspace cwd with the argument array', async () => {
    const fake = fakeSpawner();
    const { sink } = recordingSink();
    await new CursorHarness(fake.spawner).startTurn(opts(), sink);

    const spawned = fake.spawnOptions();
    expect(spawned?.cwd).toBe('/tmp/ws');
    expect(spawned?.shell).toBe(CURSOR_BIN);
    expect(spawned?.args).toEqual(buildCommand(opts()).args);
  });

  it('forwards raw fixture output as ordered text events, then one turn_end on clean exit', async () => {
    const fake = fakeSpawner();
    const { sink, events, endCount } = recordingSink();
    const harness = new CursorHarness(fake.spawner);

    const handle = await harness.startTurn(opts(), sink);
    expect(handle.sessionId).toBe(''); // raw terminal has no session (supportsResume=false)

    // Emit the fixture line-by-line to prove ordering is preserved.
    const lines = readFixture('transcript.txt').split(/(?<=\n)/);
    for (const line of lines) {
      if (line !== '') fake.emit(line);
    }
    fake.exit(0);

    const texts = events.filter((e) => e.kind === 'text');
    expect(texts).toEqual(
      lines.filter((l) => l !== '').map((delta) => ({ kind: 'text', delta })),
    );
    const terminals = events.filter(
      (e) => e.kind === 'turn_end' || e.kind === 'error',
    );
    expect(terminals).toEqual([{ kind: 'turn_end' }]);
    expect(endCount()).toBe(1);
  });

  it('forwards raw ANSI bytes without stripping them', async () => {
    const fake = fakeSpawner();
    const { sink, events } = recordingSink();
    await new CursorHarness(fake.spawner).startTurn(opts(), sink);

    const raw = readFixture('ansi.txt');
    fake.emit(raw);
    fake.exit(0);

    const texts = events.filter((e) => e.kind === 'text');
    expect(texts).toEqual([{ kind: 'text', delta: raw }]);
    // The escape byte is still present — the transcript does NOT ANSI-strip.
    expect(raw).toContain('[');
  });

  it('yields a single terminal error on nonzero exit', async () => {
    const fake = fakeSpawner();
    const { sink, events, endCount } = recordingSink();
    await new CursorHarness(fake.spawner).startTurn(opts(), sink);

    fake.emit('partial output');
    fake.exit(1);

    const terminals = events.filter(
      (e) => e.kind === 'turn_end' || e.kind === 'error',
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ kind: 'error' });
    expect(endCount()).toBe(1);
  });
});
