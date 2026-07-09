// ProcessRunner (Phase 3, Task 5): streams combined output, surfaces the exit code,
// drives the workspace `running`/`idle` overlay through the injected setStatus hook, and
// honours run_mode (`single` replaces the workspace's prior run; `concurrent` coexists).
// Spawns real short-lived / `sleep` children in a temp cwd; no Electron runtime needed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceStatus } from '@shared/models';
import { ProcessRegistry, ProcessRunner, type RunHandlers } from './index';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'harness-runner-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Handlers that record logs and resolve `exited` with the terminal exit tuple. */
function makeHandlers(): {
  handlers: RunHandlers;
  logs: string[];
  exited: Promise<{ code: number | null; durationMs: number }>;
} {
  const logs: string[] = [];
  let resolveExit!: (v: { code: number | null; durationMs: number }) => void;
  const exited = new Promise<{ code: number | null; durationMs: number }>(
    (resolve) => (resolveExit = resolve),
  );
  const handlers: RunHandlers = {
    onLog: (chunk) => logs.push(chunk),
    onExit: (code, durationMs) => resolveExit({ code, durationMs }),
  };
  return { handlers, logs, exited };
}

/** Let queued microtasks (finalize's overlay-clear) settle before asserting. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('ProcessRunner', () => {
  it('streams logs, surfaces the exit code, and sets/clears the running overlay', async () => {
    const status: Array<[string, WorkspaceStatus]> = [];
    const setStatus = vi.fn(async (id: string, s: WorkspaceStatus) => {
      status.push([id, s]);
    });
    const runner = new ProcessRunner(new ProcessRegistry(), setStatus);
    const { handlers, logs, exited } = makeHandlers();

    const runId = await runner.start(
      {
        workspaceId: 'w',
        name: 'hello',
        command: 'echo hello-run',
        cwd,
        mode: 'concurrent',
      },
      handlers,
    );
    expect(typeof runId).toBe('string');

    const exit = await exited;
    await flush();

    expect(exit.code).toBe(0);
    expect(logs.join('')).toContain('hello-run');
    // overlay: `running` when the first run starts, `idle` after the last one exits.
    expect(status).toContainEqual(['w', 'running']);
    expect(status[status.length - 1]).toEqual(['w', 'idle']);
    expect(runner.listRunning('w')).toEqual([]);
  });

  it('single mode stops the workspace prior run before starting the next', async () => {
    const runner = new ProcessRunner(new ProcessRegistry(), async () => {});
    const first = makeHandlers();
    const firstId = await runner.start(
      {
        workspaceId: 'w',
        name: 'dev',
        command: 'sleep 30',
        cwd,
        mode: 'single',
      },
      first.handlers,
    );
    expect(runner.listRunning('w').map((r) => r.runId)).toEqual([firstId]);

    const second = makeHandlers();
    const secondId = await runner.start(
      {
        workspaceId: 'w',
        name: 'dev-again',
        command: 'sleep 30',
        cwd,
        mode: 'single',
      },
      second.handlers,
    );

    // Starting the second (single) run tree-killed the first — its onExit has fired.
    await first.exited;
    expect(runner.listRunning('w').map((r) => r.runId)).toEqual([secondId]);

    await runner.stop(secondId);
    expect(runner.listRunning('w')).toEqual([]);
  });

  it('concurrent mode lets multiple runs coexist', async () => {
    const runner = new ProcessRunner(new ProcessRegistry(), async () => {});
    const a = makeHandlers();
    const b = makeHandlers();
    const idA = await runner.start(
      {
        workspaceId: 'w',
        name: 'a',
        command: 'sleep 30',
        cwd,
        mode: 'concurrent',
      },
      a.handlers,
    );
    const idB = await runner.start(
      {
        workspaceId: 'w',
        name: 'b',
        command: 'sleep 30',
        cwd,
        mode: 'concurrent',
      },
      b.handlers,
    );

    expect(
      runner
        .listRunning('w')
        .map((r) => r.runId)
        .sort(),
    ).toEqual([idA, idB].sort());

    await runner.stop(idA);
    await runner.stop(idB);
    expect(runner.listRunning('w')).toEqual([]);
  });

  it('does not overwrite needs_attention when a run starts and exits', async () => {
    let current: WorkspaceStatus = 'needs_attention';
    const setStatus = vi.fn(async (_id: string, s: WorkspaceStatus) => {
      current = s;
    });
    const runner = new ProcessRunner(
      new ProcessRegistry(),
      setStatus,
      async () => current,
    );
    const { handlers, exited } = makeHandlers();

    await runner.start(
      {
        workspaceId: 'w',
        name: 'noop',
        command: 'true',
        cwd,
        mode: 'concurrent',
      },
      handlers,
    );

    await exited;
    await flush();

    expect(setStatus).not.toHaveBeenCalled();
    expect(current).toBe('needs_attention');
  });

  it('does not clear a newer needs_attention status when the last run exits', async () => {
    let current: WorkspaceStatus = 'idle';
    const setStatus = vi.fn(async (_id: string, s: WorkspaceStatus) => {
      current = s === 'running' ? 'needs_attention' : s;
    });
    const runner = new ProcessRunner(
      new ProcessRegistry(),
      setStatus,
      async () => current,
    );
    const { handlers, exited } = makeHandlers();

    await runner.start(
      {
        workspaceId: 'w',
        name: 'noop',
        command: 'true',
        cwd,
        mode: 'concurrent',
      },
      handlers,
    );

    await exited;
    await flush();

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith('w', 'running');
    expect(current).toBe('needs_attention');
  });
});
