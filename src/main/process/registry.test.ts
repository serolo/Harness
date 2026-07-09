// ProcessRegistry + treeKillEscalate (Phase 3, Tasks 2/3). The registry is handle-based,
// idempotent, and best-effort (a throwing `stop()` must not abort siblings — allSettled);
// `treeKillEscalate` actually kills a REAL child process tree (SIGTERM→SIGKILL). Spawns
// real `sleep` children; no Electron runtime needed.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

import { ProcessRegistry, type ProcessHandle } from './index';
import { treeKillEscalate } from './kill';

/** Whether `pid` still exists (probe-only; EPERM ⇒ exists but not ours). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Poll `pred` until true or the timeout elapses (keeps process-tree tests deterministic). */
async function until(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs)
      throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A no-op handle with a recording `stop()`. */
function handle(
  id: string,
  workspaceId: string,
  onStop: () => void = () => {},
): ProcessHandle {
  return {
    id,
    workspaceId,
    kind: 'run',
    stop: async () => onStop(),
  };
}

describe('ProcessRegistry', () => {
  it('tracks handles and filters list() by workspace', () => {
    const reg = new ProcessRegistry();
    reg.register(handle('a', 'w1'));
    reg.register(handle('b', 'w1'));
    reg.register(handle('c', 'w2'));

    expect(reg.list()).toHaveLength(3);
    expect(
      reg
        .list('w1')
        .map((h) => h.id)
        .sort(),
    ).toEqual(['a', 'b']);
    reg.unregister('a');
    expect(reg.list('w1').map((h) => h.id)).toEqual(['b']);
  });

  it('stop(id) invokes the handle stop() then unregisters, and is idempotent', async () => {
    const reg = new ProcessRegistry();
    let stopped = false;
    reg.register(handle('x', 'w', () => (stopped = true)));

    await reg.stop('x');
    expect(stopped).toBe(true);
    expect(reg.list()).toEqual([]);
    // stopping an unknown / already-stopped id is a no-op
    await expect(reg.stop('x')).resolves.toBeUndefined();
  });

  it('stopWorkspace is best-effort: a throwing stop() does not abort siblings', async () => {
    const reg = new ProcessRegistry();
    const stopped: string[] = [];
    reg.register(handle('ok1', 'w', () => stopped.push('ok1')));
    reg.register({
      id: 'boom',
      workspaceId: 'w',
      kind: 'run',
      stop: async () => {
        throw new Error('stop failed');
      },
    });
    reg.register(handle('ok2', 'w', () => stopped.push('ok2')));
    reg.register(handle('other', 'w2', () => stopped.push('other')));

    await expect(reg.stopWorkspace('w')).resolves.toBeUndefined();
    expect(stopped.sort()).toEqual(['ok1', 'ok2']); // both non-throwing siblings ran
    expect(reg.list('w')).toEqual([]); // workspace cleared despite the throw
    expect(reg.list('w2').map((h) => h.id)).toEqual(['other']); // other ws untouched
  });

  it('killAll stops every tracked handle across workspaces', async () => {
    const reg = new ProcessRegistry();
    const stopped: string[] = [];
    reg.register(handle('a', 'w1', () => stopped.push('a')));
    reg.register(handle('b', 'w2', () => stopped.push('b')));

    await reg.killAll();
    expect(stopped.sort()).toEqual(['a', 'b']);
    expect(reg.list()).toEqual([]);
  });
});

describe('treeKillEscalate', () => {
  it('kills a real child process TREE when stopWorkspace runs', async () => {
    // A parent shell that also spawns a backgrounded child → a 2-level tree.
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30'], {
      stdio: 'ignore',
    });
    const pid = child.pid;
    expect(pid).toBeDefined();
    expect(isAlive(pid as number)).toBe(true);

    const reg = new ProcessRegistry();
    reg.register({
      id: 'run1',
      workspaceId: 'w',
      kind: 'run',
      pid,
      stop: () => treeKillEscalate(pid as number, 200),
    });

    await reg.stopWorkspace('w');
    await until(() => !isAlive(pid as number));
    expect(isAlive(pid as number)).toBe(false);
  });

  it('resolves (never rejects) for an already-dead pid', async () => {
    const child = spawn('/bin/sh', ['-c', 'true'], { stdio: 'ignore' });
    const pid = child.pid as number;
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    await expect(treeKillEscalate(pid, 100)).resolves.toBeUndefined();
  });
});
