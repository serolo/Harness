// IPC input-narrowing tests for the Phase 12 `task:*` handlers (heightened-scrutiny: the
// IPC boundary). Runs under the Electron test runner: `registerIpc` is called with a
// partial AppContext (only the fields the task handlers touch), and `ipcMain.handle` is
// spied so the wrapped handlers are captured and invoked directly — the SAME error
// boundary the renderer hits (a throw is re-thrown as an Error whose message encodes the
// AppError, which we decode to assert `code`).
//
// Covers: rejects empty workspaceId/prompt, a bad `mode` enum, a `model` failing
// MODEL_PATTERN, a non-integer/negative `scheduledAt`, and a bad `origin`; `task:create`
// verifies the workspace exists; and `task:runNow`/`task:markDone` state-gate to a
// runnable state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';

// The test runner is Electron-run-as-Node (ELECTRON_RUN_AS_NODE=1), where the real
// `electron` main modules (ipcMain/BrowserWindow/app) are absent. Mock them: a capturing
// `ipcMain.handle` stores each wrapped handler so the test can invoke it directly, and a
// Proxy-backed `app` returns a benign function for anything electron-log touches at import.
const capturedHandlers = new Map<string, unknown>();
vi.mock('electron', () => {
  const noop = (): void => {};
  const app = new Proxy(
    {
      isPackaged: false,
      getName: () => 'test',
      getVersion: () => '0.0.0',
      getPath: () => '/tmp',
    } as Record<string, unknown>,
    { get: (t, p) => (typeof p === 'string' && p in t ? t[p] : noop) },
  );
  return {
    app,
    dialog: {},
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    ipcMain: {
      handle: (ch: string, fn: unknown) => capturedHandlers.set(ch, fn),
      on: noop,
      removeHandler: noop,
      removeAllListeners: noop,
    },
    MessageChannelMain: class {},
  };
});

import { openDb, type AppDatabase } from '../db';
import { ProjectsRepo } from '../db/repos/projects';
import { WorkspacesRepo } from '../db/repos/workspaces';
import { ScheduledTasksRepo } from '../db/repos/tasks';
import { registerIpc } from './register';
import { decodeAppErrorMessage } from '@shared/errors';
import type { AppContext } from '../context';
import type { CommandChannel, CommandReq } from '@shared/ipc';

type Handler = (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>;

let tmpDir: string;
let db: AppDatabase;
let repo: ScheduledTasksRepo;
let workspaceId: string;

const FAKE_EVENT = { sender: {} } as unknown as IpcMainInvokeEvent;

/** Invoke a captured handler; return the decoded AppError code (or 'OK' on success). */
async function invokeCode<C extends CommandChannel>(
  channel: C,
  req: CommandReq<C>,
): Promise<string> {
  const fn = capturedHandlers.get(channel) as Handler | undefined;
  if (!fn) throw new Error(`no handler for ${channel}`);
  try {
    await fn(FAKE_EVENT, req);
    return 'OK';
  } catch (e) {
    const decoded = decodeAppErrorMessage(e instanceof Error ? e.message : '');
    return decoded?.code ?? 'UNKNOWN';
  }
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-ipc-tasks-'));
  db = openDb(join(tmpDir, 'test.db'));
  repo = new ScheduledTasksRepo(db);

  const project = await new ProjectsRepo(db).create({
    name: 'demo',
    originUrl: 'git@github.com:acme/demo.git',
    defaultBranch: 'main',
    repoPath: '/tmp/repo/demo',
  });
  const workspace = await new WorkspacesRepo(db).create({
    projectId: project.id,
    name: 'paris',
    branch: 'agent/paris',
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'idle',
  });
  workspaceId = workspace.id;

  capturedHandlers.clear();

  const ctx = {
    tasks: repo,
    workspaces: {
      get: async (id: string) => (id === workspaceId ? workspace : null),
    },
    scheduler: {
      runNow: async (id: string) => repo.setState(id, 'running'),
    },
  } as unknown as AppContext;

  registerIpc(ctx);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('task:create — input narrowing', () => {
  it('rejects an empty workspaceId', async () => {
    expect(
      await invokeCode('task:create', { workspaceId: '', prompt: 'go' }),
    ).toBe('invalid_input');
  });

  it('rejects an empty/whitespace prompt', async () => {
    expect(
      await invokeCode('task:create', { workspaceId, prompt: '   ' }),
    ).toBe('invalid_input');
  });

  it('rejects a bad mode enum', async () => {
    expect(
      await invokeCode('task:create', {
        workspaceId,
        prompt: 'go',
        mode: 'sudo' as never,
      }),
    ).toBe('invalid_input');
  });

  it('rejects a model failing MODEL_PATTERN (shell metacharacters)', async () => {
    expect(
      await invokeCode('task:create', {
        workspaceId,
        prompt: 'go',
        model: 'sonnet; rm -rf /',
      }),
    ).toBe('invalid_input');
  });

  it('rejects a non-integer scheduledAt', async () => {
    expect(
      await invokeCode('task:create', {
        workspaceId,
        prompt: 'go',
        scheduledAt: 1.5,
      }),
    ).toBe('invalid_input');
  });

  it('rejects a non-positive scheduledAt', async () => {
    expect(
      await invokeCode('task:create', {
        workspaceId,
        prompt: 'go',
        scheduledAt: 0,
      }),
    ).toBe('invalid_input');
  });

  it('rejects a bad origin', async () => {
    expect(
      await invokeCode('task:create', {
        workspaceId,
        prompt: 'go',
        origin: 'admin' as never,
      }),
    ).toBe('invalid_input');
  });

  it('rejects a create for a non-existent workspace with not_found', async () => {
    expect(
      await invokeCode('task:create', { workspaceId: 'nope', prompt: 'go' }),
    ).toBe('not_found');
  });

  it('accepts a valid create (a past scheduledAt is allowed)', async () => {
    expect(
      await invokeCode('task:create', {
        workspaceId,
        prompt: 'go',
        model: 'sonnet',
        mode: 'plan',
        scheduledAt: 1, // a past time is deliberately allowed
      }),
    ).toBe('OK');
    const list = await repo.list(workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ model: 'sonnet', mode: 'plan' });
  });
});

describe('task:runNow / task:markDone — state gating', () => {
  it('rejects runNow on a running task with conflict', async () => {
    const task = await repo.create({ workspaceId, prompt: 'go' });
    await repo.setState(task.id, 'running');
    expect(await invokeCode('task:runNow', { id: task.id })).toBe('conflict');
  });

  it('rejects markDone on a done task with conflict', async () => {
    const task = await repo.create({ workspaceId, prompt: 'go' });
    await repo.setState(task.id, 'done');
    expect(await invokeCode('task:markDone', { id: task.id })).toBe('conflict');
  });

  it('allows runNow from a pending task', async () => {
    const task = await repo.create({ workspaceId, prompt: 'go' });
    expect(await invokeCode('task:runNow', { id: task.id })).toBe('OK');
  });

  it('marks a pending task done', async () => {
    const task = await repo.create({ workspaceId, prompt: 'go' });
    expect(await invokeCode('task:markDone', { id: task.id })).toBe('OK');
    expect((await repo.get(task.id)).state).toBe('done');
  });
});
