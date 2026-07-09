// PtyService (Phase 3, Task 4): a real node-pty round-trip — spawn a shell in a cwd,
// write input, and see it echoed back over the stream; resize is safe; kill/close ends
// the stream AND deregisters from the shared ProcessRegistry (no leaked PTY). Loads the
// native `node-pty` module, so it runs under the Electron vitest harness.

import { describe, it, expect } from 'vitest';

import type { StreamSink } from '@shared/ipc';
import { ProcessRegistry } from '../process';
import { PtyService, type PtyChunk } from './index';

/** A sink that accumulates data + records stream completion. */
function collector(): {
  sink: StreamSink<PtyChunk>;
  data: () => string;
  isEnded: () => boolean;
} {
  const chunks: string[] = [];
  let ended = false;
  return {
    sink: {
      push: (c) => chunks.push(c.data),
      end: () => (ended = true),
      error: () => {},
    },
    data: () => chunks.join(''),
    isEnded: () => ended,
  };
}

async function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs)
      throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('PtyService', () => {
  it('echoes written input back over the stream and registers the pty', async () => {
    const reg = new ProcessRegistry();
    const pty = new PtyService(reg);
    const sink = collector();

    const id = await pty.spawn(
      { workspaceId: 'w', cwd: process.cwd(), env: {} },
      sink.sink,
    );
    expect(typeof id).toBe('string');
    expect(reg.list('w').map((h) => h.id)).toEqual([id]); // registered for teardown
    expect(reg.list('w')[0].kind).toBe('pty');

    pty.write(id, 'echo pty-roundtrip\r');
    await until(() => sink.data().includes('pty-roundtrip'));
    expect(sink.data()).toContain('pty-roundtrip');

    pty.kill(id);
    await until(() => reg.list('w').length === 0);
  });

  it('resize is safe and kill ends the stream + deregisters', async () => {
    const reg = new ProcessRegistry();
    const pty = new PtyService(reg);
    const sink = collector();

    const id = await pty.spawn(
      { workspaceId: 'w', cwd: process.cwd() },
      sink.sink,
    );
    expect(() => pty.resize(id, 120, 40)).not.toThrow();
    expect(reg.list('w')).toHaveLength(1);

    pty.kill(id);
    await until(() => reg.list('w').length === 0); // onExit deregistered the handle
    expect(reg.list('w')).toEqual([]);
    await until(() => sink.isEnded());
    expect(sink.isEnded()).toBe(true); // stream ended on shell exit

    // write/resize after death are safe no-ops (id is gone from the map)
    expect(() => pty.write(id, 'noop')).not.toThrow();
    expect(() => pty.resize(id, 10, 10)).not.toThrow();
  });

  it('spawnRaw surfaces raw output + the exit CODE (raw-terminal fallback)', async () => {
    const reg = new ProcessRegistry();
    const pty = new PtyService(reg);

    // Run a shell that prints then exits with a known nonzero code — the raw-terminal
    // transcript relies on that code to choose turn_end (0) vs error (nonzero).
    const handle = await pty.spawnRaw({
      cwd: process.cwd(),
      shell: '/bin/sh',
      args: ['-c', 'printf raw-out; exit 3'],
    });
    expect(typeof handle.ptyId).toBe('string');
    // Parity with the other agent adapters: a raw agent turn is NOT registered in the
    // shared ProcessRegistry (supervisor-owned teardown), unlike a terminal-tab `spawn`.
    expect(reg.list()).toEqual([]);

    let out = '';
    let exitCode: number | undefined;
    handle.onData((chunk) => (out += chunk));
    handle.onExit((e) => (exitCode = e.exitCode));

    await until(() => exitCode !== undefined);
    expect(out).toContain('raw-out'); // raw bytes forwarded (not ANSI-stripped)
    expect(exitCode).toBe(3); // the exit CODE reached onExit

    // After exit the pty is gone from the service map — kill is a safe no-op.
    expect(() => handle.kill()).not.toThrow();
  });
});
