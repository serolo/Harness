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
import { ChatContextsRepo } from '../db/repos/chatContexts';
import { registerIpc } from './register';
import { decodeAppErrorMessage } from '@shared/errors';
import type { AppContext } from '../context';
import type { CommandChannel, CommandReq } from '@shared/ipc';

type Handler = (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>;

let tmpDir: string;
let db: AppDatabase;
let repo: ScheduledTasksRepo;
let workspaceId: string;
let recorderClear: ReturnType<typeof vi.fn>;
let pricingReady: ReturnType<typeof vi.fn>;
let activeContextIds: Set<string>;
let appContext: AppContext;

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
    worktreePath: '/tmp/repo/demo-paris',
  });
  workspaceId = workspace.id;
  recorderClear = vi.fn(async () => undefined);
  pricingReady = vi.fn(async () => null);
  activeContextIds = new Set();

  capturedHandlers.clear();

  appContext = {
    db,
    tasks: repo,
    workspaces: {
      get: async (id: string) => (id === workspaceId ? workspace : null),
    },
    scheduler: {
      runNow: async (id: string) => repo.setState(id, 'running'),
    },
    recorder: {
      clear: recorderClear,
      latestSessionId: vi.fn(async () => undefined),
    },
    pricing: {
      ready: pricingReady,
    },
    harness: {
      isActive: () => false,
      isContextActive: (_workspaceId: string, contextId: string) =>
        activeContextIds.has(contextId),
    },
    metaHarness: {
      assertWorkspaceAvailable: vi.fn(async () => undefined),
    },
    turnPreparation: {
      prepareTurn: vi.fn(async (_workspace, input) => ({
        ...input,
        mcpConfig: [],
        permissionPolicy: {},
      })),
      discard: vi.fn(),
    },
    telemetry: {
      capture: vi.fn(),
    },
  } as unknown as AppContext;

  registerIpc(appContext);
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

  it('rejects an unknown reasoning effort', async () => {
    expect(
      await invokeCode('task:create', {
        workspaceId,
        prompt: 'go',
        effort: 'extreme' as never,
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

  it('rejects an unknown harness override', async () => {
    expect(
      await invokeCode('task:create', {
        workspaceId,
        prompt: 'go',
        harnessOverride: 'unknown' as never,
      }),
    ).toBe('invalid_input');
  });

  it('rejects malformed task attachments', async () => {
    expect(
      await invokeCode('task:create', {
        workspaceId,
        prompt: 'go',
        attachments: [{ type: 'file', path: 'bad\0path' }],
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
        harnessOverride: 'codex',
        attachments: [{ type: 'file', path: '/tmp/spec.md' }],
      }),
    ).toBe('OK');
    const list = await repo.list(workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      model: 'sonnet',
      mode: 'plan',
      harnessOverride: 'codex',
      attachments: [{ type: 'file', path: '/tmp/spec.md' }],
    });
  });
});

describe('task:update — harness override', () => {
  it('validates and persists set/clear patches', async () => {
    const task = await repo.create({ workspaceId, prompt: 'go' });

    expect(
      await invokeCode('task:update', {
        id: task.id,
        harnessOverride: 'unknown' as never,
      }),
    ).toBe('invalid_input');
    expect(
      await invokeCode('task:update', {
        id: task.id,
        harnessOverride: 'codex',
      }),
    ).toBe('OK');
    expect((await repo.get(task.id)).harnessOverride).toBe('codex');

    expect(
      await invokeCode('task:update', {
        id: task.id,
        harnessOverride: null,
      }),
    ).toBe('OK');
    expect((await repo.get(task.id)).harnessOverride).toBeNull();
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

describe('chat:clear — handler registration', () => {
  it('clears the recorder for the requested workspace', async () => {
    expect(await invokeCode('chat:clear', { workspaceId })).toBe('OK');
    expect(recorderClear).toHaveBeenCalledWith(workspaceId);
  });

  it('rejects an empty workspaceId', async () => {
    expect(await invokeCode('chat:clear', { workspaceId: '' })).toBe(
      'invalid_input',
    );
    expect(recorderClear).not.toHaveBeenCalled();
  });
});

describe('chat:contexts:close — active turn gating', () => {
  it('rejects an active context but still closes an idle sibling', async () => {
    const contexts = new ChatContextsRepo(db);
    const active = await contexts.create({ workspaceId, label: 'Active' });
    const idle = await contexts.create({ workspaceId, label: 'Idle' });
    activeContextIds.add(active.id);

    const activeResult = await invokeCode('chat:contexts:close', {
      contextId: active.id,
    });
    const idleResult = await invokeCode('chat:contexts:close', {
      contextId: idle.id,
    });

    expect(activeResult).toBe('conflict');
    expect(await contexts.get(active.id)).toEqual(active);
    expect(idleResult).toBe('OK');
    expect(await contexts.get(idle.id)).toBeNull();
  });
});

describe('turn:start — instant terminal framing', () => {
  it('emits distinct nonempty started turn ids before instant terminal contexts end', async () => {
    const contexts = new ChatContextsRepo(db);
    const first = await contexts.create({ workspaceId, label: 'First' });
    const second = await contexts.create({ workspaceId, label: 'Second' });
    let turnSequence = 0;
    const allocated = new Map<string, string>();
    appContext.harness = {
      startContextTurn: vi.fn(async (_workspaceId, contextId, _opts, sink) => {
        allocated.set(contextId, `instant-turn-${++turnSequence}`);
        sink.push({ kind: 'turn_end' });
        sink.end();
        return { sessionId: `session-${contextId}`, interrupt: vi.fn() };
      }),
      getContextActiveTurnId: vi.fn((_workspaceId, contextId) =>
        allocated.get(contextId),
      ),
    } as unknown as AppContext['harness'];

    const start = capturedHandlers.get('stream:start') as Handler;
    const run = async (contextId: string, id: string) => {
      const sender = {
        send: vi.fn(),
        isDestroyed: () => false,
        once: vi.fn(),
        removeListener: vi.fn(),
      };
      await start({ sender } as unknown as IpcMainInvokeEvent, {
        channel: 'turn:start',
        id,
        arg: {
          workspaceId,
          contextId,
          prompt: 'finish instantly',
          attachments: [],
        },
      });
      await vi.waitFor(() => expect(sender.send).toHaveBeenCalled());
      return sender.send.mock.calls
        .map(([, frame]) => frame)
        .find(
          (frame) => frame?.t === 'chunk' && frame.chunk?.kind === 'started',
        )?.chunk.turnId as string | undefined;
    };

    const firstTurnId = await run(
      first.id,
      '11111111-1111-4111-8111-111111111111',
    );
    const secondTurnId = await run(
      second.id,
      '22222222-2222-4222-8222-222222222222',
    );

    expect(firstTurnId).toBeTruthy();
    expect(secondTurnId).toBeTruthy();
    expect(firstTurnId).not.toBe(secondTurnId);
  });
});

describe('pricing:getCatalog — handler registration', () => {
  it('returns the startup pricing snapshot', async () => {
    expect(await invokeCode('pricing:getCatalog', undefined)).toBe('OK');
    expect(pricingReady).toHaveBeenCalledOnce();
  });
});
