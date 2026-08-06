import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';

const { capturedHandlers, showOpenDialog } = vi.hoisted(() => ({
  capturedHandlers: new Map<string, unknown>(),
  showOpenDialog: vi.fn(),
}));
vi.mock('electron', () => {
  const noop = (): void => {};
  const app = new Proxy(
    {
      isPackaged: false,
      getName: () => 'test',
      getVersion: () => '0.0.0',
      getPath: () => '/tmp',
    } as Record<string, unknown>,
    {
      get: (target, key) =>
        typeof key === 'string' && key in target ? target[key] : noop,
    },
  );
  return {
    app,
    dialog: { showOpenDialog },
    nativeImage: {},
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    ipcMain: {
      handle: (channel: string, fn: unknown) =>
        capturedHandlers.set(channel, fn),
      on: noop,
      removeHandler: noop,
      removeAllListeners: noop,
    },
    MessageChannelMain: class {},
  };
});

import { AppError, decodeAppErrorMessage } from '@shared/errors';
import type { AppContext } from '../context';
import { openDb, type AppDatabase } from '../db';
import { ProjectsRepo } from '../db/repos/projects';
import { registerIpc } from './register';

type Handler = (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>;
const EVENT = { sender: {} } as unknown as IpcMainInvokeEvent;

let tmpDir: string;
let db: AppDatabase;
let projectId: string;
let agents: {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  duplicate: ReturnType<typeof vi.fn>;
  importBundle: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  validateFile: ReturnType<typeof vi.fn>;
  saveFile: ReturnType<typeof vi.fn>;
  saveBundleFiles: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let metaHarness: {
  start: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  takeOver: ReturnType<typeof vi.fn>;
};

async function call(channel: string, req: unknown): Promise<unknown> {
  const fn = capturedHandlers.get(channel) as Handler | undefined;
  if (!fn) throw new Error(`missing handler: ${channel}`);
  return fn(EVENT, req);
}

async function code(channel: string, req: unknown): Promise<string> {
  try {
    await call(channel, req);
    return 'OK';
  } catch (error) {
    return (
      decodeAppErrorMessage(error instanceof Error ? error.message : '')
        ?.code ?? 'UNKNOWN'
    );
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  capturedHandlers.clear();
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-agent-ipc-'));
  db = openDb(join(tmpDir, 'test.db'));
  projectId = (
    await new ProjectsRepo(db).create({
      name: 'Demo',
      originUrl: '',
      defaultBranch: 'main',
      repoPath: '/tmp/demo',
    })
  ).id;
  agents = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ id: 'builtin:polly' })),
    create: vi.fn(async () => ({ id: 'project:p:new' })),
    duplicate: vi.fn(async () => ({ id: 'project:p:copy' })),
    importBundle: vi.fn(async () => ({ id: 'project:p:imported' })),
    readFile: vi.fn(async () => ({
      path: 'config.yaml',
      content: '',
      diagnostics: [],
    })),
    validateFile: vi.fn(async () => []),
    saveFile: vi.fn(async () => ({ id: 'project:p:custom' })),
    saveBundleFiles: vi.fn(async () => ({ id: 'project:p:custom' })),
    delete: vi.fn(async () => undefined),
  };
  metaHarness = {
    start: vi.fn(async (request) => ({ id: 'run-1', ...request })),
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ id: 'run-1' })),
    cancel: vi.fn(async () => ({ id: 'run-1', status: 'cancelled' })),
    takeOver: vi.fn(async () => ({ id: 'run-1', status: 'taken_over' })),
  };
  registerIpc({ db, agents, metaHarness } as unknown as AppContext);
});

afterEach(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('meta agent IPC input narrowing', () => {
  it('rejects missing projects, empty/control-character IDs, and malformed file payloads', async () => {
    expect(await code('metaAgent:list', { projectId: 'missing' })).toBe(
      'not_found',
    );
    expect(await code('metaAgent:get', { projectId, agentId: '' })).toBe(
      'invalid_input',
    );
    expect(
      await code('metaRun:get', { projectId, runId: `run\u0000secret` }),
    ).toBe('invalid_input');
    expect(
      await code('metaAgent:saveFile', {
        projectId,
        agentId: 'project:p:custom',
        path: 7,
        content: {},
      }),
    ).toBe('invalid_input');
    expect(agents.saveFile).not.toHaveBeenCalled();
  });

  it('routes validated IDs and file content without exposing parser or filesystem objects', async () => {
    await expect(
      call('metaAgent:saveFile', {
        projectId,
        agentId: 'project:p:custom',
        path: 'config.yaml',
        content: 'name: Safe',
      }),
    ).resolves.toEqual({ id: 'project:p:custom' });
    expect(agents.saveFile).toHaveBeenCalledWith(
      projectId,
      'project:p:custom',
      'config.yaml',
      'name: Safe',
    );
  });

  it('selects an import directory in main and never accepts a renderer path', async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/safe/selected'],
    });
    await call('metaAgent:import', { projectId, path: '/renderer/injected' });
    expect(agents.importBundle).toHaveBeenCalledWith(
      projectId,
      '/safe/selected',
    );

    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(call('metaAgent:import', { projectId })).resolves.toBeNull();
  });

  it('preserves AppError encoding for immutable built-in and adapter-capability failures', async () => {
    agents.saveFile.mockRejectedValue(
      new AppError('conflict', 'built-in agents are immutable'),
    );
    expect(
      await code('metaAgent:saveFile', {
        projectId,
        agentId: 'builtin:polly',
        path: 'config.yaml',
        content: 'name: changed',
      }),
    ).toBe('conflict');

    metaHarness.start.mockRejectedValue(
      new AppError('harness', 'coordinator lacks MCP control'),
    );
    expect(
      await code('metaAgent:startRun', {
        projectId,
        agentId: 'builtin:polly',
        sourceWorkspaceId: 'workspace-1',
        goal: 'Run safely',
      }),
    ).toBe('harness');
  });

  it('normalizes native bundle I/O failures without exposing managed paths', async () => {
    agents.readFile.mockRejectedValue(
      new Error('EACCES opening /Users/person/private/agent/config.yaml'),
    );
    let decoded;
    try {
      await call('metaAgent:readFile', {
        projectId,
        agentId: 'project:p:custom',
        path: 'config.yaml',
      });
    } catch (error) {
      decoded = decodeAppErrorMessage(
        error instanceof Error ? error.message : '',
      );
    }
    expect(decoded).toMatchObject({
      code: 'io',
      message: 'agent bundle operation failed',
    });
    expect(JSON.stringify(decoded)).not.toContain('/Users/person');
  });

  it('does not call domain services when the project ownership check fails', async () => {
    expect(
      await code('metaRun:cancel', {
        projectId: 'other-project',
        runId: 'run-1',
      }),
    ).toBe('not_found');
    expect(metaHarness.cancel).not.toHaveBeenCalled();
  });
});
