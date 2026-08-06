// IPC coverage for the Git changes menu channels. These channels are consumed by the
// renderer's CommitFilter; if they are not registered the menu falls back to "Loading…"
// and scope buttons do not actually query the worktree.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { registerIpc } from './register';
import type { AppContext } from '../context';
import type { CommandChannel, CommandReq, CommandRes } from '@shared/ipc';

type Handler = (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>;

const FAKE_EVENT = { sender: {} } as unknown as IpcMainInvokeEvent;

async function invoke<C extends CommandChannel>(
  channel: C,
  req: CommandReq<C>,
): Promise<CommandRes<C>> {
  const fn = capturedHandlers.get(channel) as Handler | undefined;
  if (!fn) throw new Error(`no handler for ${channel}`);
  return (await fn(FAKE_EVENT, req)) as CommandRes<C>;
}

beforeEach(() => {
  capturedHandlers.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('diff IPC menu/query handlers', () => {
  it('registers diff:menu, diff:query, and diff:fileQuery', async () => {
    const menu = vi.fn(async () => ({
      currentBranch: 'feature',
      targetRef: 'main',
      branches: ['feature', 'main'],
      commits: [],
      uncommittedFileCount: 2,
    }));
    const getDiffForQuery = vi.fn(async () => ({
      baseRef: 'HEAD',
      headRef: 'HEAD',
      patch: '',
      files: [
        {
          path: 'pending.ts',
          oldPath: null,
          change: 'modified' as const,
          additions: 1,
          deletions: 0,
        },
      ],
    }));
    const fileDiffForQuery = vi.fn(async () => ({
      path: 'pending.ts',
      oldContent: 'old',
      newContent: 'new',
      hunks: [],
    }));

    registerIpc({
      diff: {
        menu,
        getDiffForQuery,
        fileDiffForQuery,
      },
      workspaces: {
        get: async () => ({
          id: 'ws1',
          worktreePath: '/tmp/worktree',
        }),
      },
    } as unknown as AppContext);

    await expect(
      invoke('diff:menu', { workspaceId: 'ws1', targetRef: 'main' }),
    ).resolves.toMatchObject({ uncommittedFileCount: 2 });

    await expect(
      invoke('diff:query', {
        workspaceId: 'ws1',
        targetRef: 'main',
        scope: { kind: 'uncommitted' },
      }),
    ).resolves.toMatchObject({ files: [{ path: 'pending.ts' }] });

    await expect(
      invoke('diff:fileQuery', {
        workspaceId: 'ws1',
        targetRef: 'main',
        scope: { kind: 'uncommitted' },
        path: 'pending.ts',
      }),
    ).resolves.toMatchObject({ oldContent: 'old', newContent: 'new' });

    expect(menu).toHaveBeenCalledWith('ws1', 'main');
    expect(getDiffForQuery).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      targetRef: 'main',
      scope: { kind: 'uncommitted' },
    });
    expect(fileDiffForQuery).toHaveBeenCalledWith(
      {
        workspaceId: 'ws1',
        targetRef: 'main',
        scope: { kind: 'uncommitted' },
        path: 'pending.ts',
      },
      'pending.ts',
    );
  });
});

describe('workspace directory browser IPC', () => {
  it('lists directories first and confines traversal after following symlinks', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'harness-files-'));
    const workspaceRoot = join(fixtureRoot, 'workspace');
    const outsideRoot = join(fixtureRoot, 'outside');
    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(join(workspaceRoot, 'README.md'), '# fixture\n');
    await writeFile(join(outsideRoot, 'secret.txt'), 'not workspace data\n');
    await symlink(outsideRoot, join(workspaceRoot, 'outside-link'));

    try {
      registerIpc({
        workspaces: {
          get: async () => ({ id: 'ws1', worktreePath: workspaceRoot }),
        },
      } as unknown as AppContext);

      await expect(
        invoke('workspace:listDirectory', { workspaceId: 'ws1', path: '' }),
      ).resolves.toEqual([
        { name: 'src', path: 'src', kind: 'directory' },
        { name: 'outside-link', path: 'outside-link', kind: 'symlink' },
        { name: 'README.md', path: 'README.md', kind: 'file' },
      ]);
      await expect(
        invoke('workspace:listDirectory', {
          workspaceId: 'ws1',
          path: '../outside',
        }),
      ).rejects.toThrow('file path must stay inside workspace');
      await expect(
        invoke('workspace:listDirectory', {
          workspaceId: 'ws1',
          path: 'outside-link',
        }),
      ).rejects.toThrow('file path must stay inside workspace');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
