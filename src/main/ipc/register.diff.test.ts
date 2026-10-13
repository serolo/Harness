// IPC coverage for the Git changes menu channels. These channels are consumed by the
// renderer's CommitFilter; if they are not registered the menu falls back to "Loading…"
// and scope buttons do not actually query the worktree.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const capturedHandlers = new Map<string, unknown>();
const { openExternal, showItemInFolder, createThumbnailFromPath, writeText } =
  vi.hoisted(() => ({
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
    createThumbnailFromPath: vi.fn(),
    writeText: vi.fn(),
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
    clipboard: { writeText },
    nativeImage: { createThumbnailFromPath },
    shell: { openExternal, showItemInFolder },
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
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
  showItemInFolder.mockReset();
  createThumbnailFromPath.mockReset();
  writeText.mockReset();
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

describe('git:pull', () => {
  it('fast-forwards the persisted workspace checkout and invalidates the diff', async () => {
    const pullFastForward = vi.fn(async () => {});
    const status = vi.fn(async () => ({ clean: true, files: [] }));
    const invalidate = vi.fn();
    registerIpc({
      git: { pullFastForward, status },
      diff: { invalidate },
      workspaces: {
        get: async () => ({
          id: 'ws1',
          worktreePath: '/managed/worktree',
        }),
      },
    } as unknown as AppContext);

    await expect(
      invoke('git:pull', { workspaceId: 'ws1' }),
    ).resolves.toBeUndefined();
    expect(pullFastForward).toHaveBeenCalledWith('/managed/worktree');
    expect(invalidate).toHaveBeenCalledWith('ws1');
  });

  it('rejects pulling a workspace with uncommitted changes', async () => {
    const pullFastForward = vi.fn();
    registerIpc({
      git: {
        pullFastForward,
        status: async () => ({ clean: false, files: [{ path: 'dirty.ts' }] }),
      },
      diff: { invalidate: vi.fn() },
      workspaces: {
        get: async () => ({
          id: 'ws1',
          worktreePath: '/managed/worktree',
        }),
      },
    } as unknown as AppContext);

    await expect(invoke('git:pull', { workspaceId: 'ws1' })).rejects.toThrow(
      'commit or discard uncommitted changes before pulling',
    );
    expect(pullFastForward).not.toHaveBeenCalled();
  });

  it('rejects a workspace without an available checkout', async () => {
    registerIpc({
      git: { pullFastForward: vi.fn(), status: vi.fn() },
      diff: { invalidate: vi.fn() },
      workspaces: { get: async () => null },
    } as unknown as AppContext);

    await expect(
      invoke('git:pull', { workspaceId: 'missing' }),
    ).rejects.toThrow('workspace checkout is unavailable');
  });
});

describe('git:getUpstream', () => {
  it('returns live Git upstream state for the persisted workspace checkout', async () => {
    const upstreamBranch = vi.fn(async () => 'origin/qa/147');
    registerIpc({
      git: { upstreamBranch },
      workspaces: {
        get: async () => ({
          id: 'ws1',
          worktreePath: '/managed/worktree',
        }),
      },
    } as unknown as AppContext);

    await expect(
      invoke('git:getUpstream', { workspaceId: 'ws1' }),
    ).resolves.toEqual({ upstream: 'origin/qa/147' });
    expect(upstreamBranch).toHaveBeenCalledWith('/managed/worktree');
  });
});

describe('git:setBaseBranch', () => {
  it('routes a validated target through the workspace owner and invalidates the diff', async () => {
    const workspace = {
      id: 'ws1',
      baseBranch: 'origin/qa/150',
    };
    const setBaseBranch = vi.fn(async () => workspace);
    const invalidate = vi.fn();
    registerIpc({
      workspaces: { setBaseBranch },
      diff: { invalidate },
    } as unknown as AppContext);

    await expect(
      invoke('git:setBaseBranch', {
        workspaceId: 'ws1',
        targetRef: 'origin/qa/150',
      }),
    ).resolves.toBe(workspace);
    expect(setBaseBranch).toHaveBeenCalledWith('ws1', 'origin/qa/150');
    expect(invalidate).toHaveBeenCalledWith('ws1');
  });

  it('rejects malformed refs before calling the workspace service', async () => {
    const setBaseBranch = vi.fn();
    registerIpc({
      workspaces: { setBaseBranch },
      diff: { invalidate: vi.fn() },
    } as unknown as AppContext);

    await expect(
      invoke('git:setBaseBranch', {
        workspaceId: 'ws1',
        targetRef: 'origin/main\nunsafe',
      }),
    ).rejects.toThrow('targetRef is invalid');
    expect(setBaseBranch).not.toHaveBeenCalled();
  });
});

describe('github:openPrUrl', () => {
  it('opens a validated github.com pull request in the system browser', async () => {
    registerIpc({} as AppContext);

    await expect(
      invoke('github:openPrUrl', {
        url: 'https://github.com/acme/repo/pull/42',
      }),
    ).resolves.toBeUndefined();
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/acme/repo/pull/42',
    );
  });

  it.each([
    'http://github.com/acme/repo/pull/42',
    'https://evil.example/acme/repo/pull/42',
    'https://github.com/acme/repo/issues/42',
    'file:///tmp/pull/42',
    'not a URL',
  ])('rejects an unsafe or non-PR URL: %s', async (url) => {
    registerIpc({} as AppContext);

    await expect(invoke('github:openPrUrl', { url })).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('external:openUrl', () => {
  it.each([
    'https://example.com/docs?topic=links',
    'http://localhost:3000/help',
    'mailto:support@example.com',
  ])(
    'opens a validated external URL in the system application: %s',
    async (url) => {
      registerIpc({} as AppContext);

      await expect(
        invoke('external:openUrl', { url }),
      ).resolves.toBeUndefined();
      expect(openExternal).toHaveBeenCalledWith(url);
    },
  );

  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'file:///tmp/secret',
    'https://user:password@example.com/private',
    'https://example.com/line\nbreak',
    'not a URL',
  ])('rejects an unsafe external URL: %s', async (url) => {
    registerIpc({} as AppContext);

    await expect(invoke('external:openUrl', { url })).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
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

describe('file:revealInFinder', () => {
  it('reveals a real workspace file and rejects traversal, directories, and escaping symlinks', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'harness-reveal-'));
    const workspaceRoot = join(fixtureRoot, 'workspace');
    const outsideRoot = join(fixtureRoot, 'outside');
    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    await mkdir(outsideRoot);
    const filePath = join(workspaceRoot, 'src', 'index.ts');
    await writeFile(filePath, 'export {};\n');
    await writeFile(join(outsideRoot, 'secret.ts'), 'secret\n');
    await symlink(
      join(outsideRoot, 'secret.ts'),
      join(workspaceRoot, 'escape.ts'),
    );

    try {
      registerIpc({
        workspaces: {
          get: async () => ({ id: 'ws1', worktreePath: workspaceRoot }),
        },
      } as unknown as AppContext);

      await expect(
        invoke('file:revealInFinder', {
          source: 'workspace',
          workspaceId: 'ws1',
          path: 'src/index.ts',
        }),
      ).resolves.toBeUndefined();
      expect(showItemInFolder).toHaveBeenCalledWith(await realpath(filePath));

      for (const path of [
        '../outside/secret.ts',
        filePath,
        'src',
        'escape.ts',
      ]) {
        showItemInFolder.mockClear();
        await expect(
          invoke('file:revealInFinder', {
            source: 'workspace',
            workspaceId: 'ws1',
            path,
          }),
        ).rejects.toThrow();
        expect(showItemInFolder).not.toHaveBeenCalled();
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe('file:copyPath', () => {
  it('copies validated absolute and relative workspace paths', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'harness-copy-path-'));
    const workspaceRoot = join(fixtureRoot, 'workspace');
    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    const filePath = join(workspaceRoot, 'src', 'index.ts');
    await writeFile(filePath, 'export {};\n');

    try {
      registerIpc({
        workspaces: {
          get: async () => ({ id: 'ws1', worktreePath: workspaceRoot }),
        },
      } as unknown as AppContext);

      await invoke('file:copyPath', {
        source: 'workspace',
        workspaceId: 'ws1',
        path: 'src/index.ts',
        format: 'absolute',
      });
      expect(writeText).toHaveBeenLastCalledWith(await realpath(filePath));

      await invoke('file:copyPath', {
        source: 'workspace',
        workspaceId: 'ws1',
        path: 'src/index.ts',
        format: 'relative',
      });
      expect(writeText).toHaveBeenLastCalledWith('src/index.ts');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the workspace before writing to the clipboard', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'harness-copy-path-'));
    const workspaceRoot = join(fixtureRoot, 'workspace');
    await mkdir(workspaceRoot);

    try {
      registerIpc({
        workspaces: {
          get: async () => ({ id: 'ws1', worktreePath: workspaceRoot }),
        },
      } as unknown as AppContext);

      await expect(
        invoke('file:copyPath', {
          source: 'workspace',
          workspaceId: 'ws1',
          path: '../outside.ts',
          format: 'absolute',
        }),
      ).rejects.toThrow();
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe('attachment:imagePreview', () => {
  it('derives the path from the persisted turn and returns a re-encoded thumbnail', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'harness-attachment-'));
    const imagePath = join(fixtureRoot, 'screen.png');
    await writeFile(imagePath, 'not decoded by the mocked nativeImage');
    createThumbnailFromPath.mockResolvedValue({
      isEmpty: () => false,
      toPNG: () => Buffer.from('preview'),
    });

    try {
      registerIpc({
        recorder: {
          history: async (workspaceId: string) => [
            {
              id: 'turn-1',
              workspaceId,
              events: [
                {
                  event: {
                    kind: 'user_attachments',
                    attachments: [{ type: 'image', path: imagePath }],
                  },
                },
              ],
            },
          ],
        },
      } as unknown as AppContext);

      await expect(
        invoke('attachment:imagePreview', {
          workspaceId: 'ws1',
          turnId: 'turn-1',
          attachmentIndex: 0,
        }),
      ).resolves.toEqual({
        dataUrl: 'data:image/png;base64,cHJldmlldw==',
      });
      expect(createThumbnailFromPath).toHaveBeenCalledWith(imagePath, {
        width: 1024,
        height: 1024,
      });

      createThumbnailFromPath.mockClear();
      await expect(
        invoke('attachment:imagePreview', {
          workspaceId: 'ws1',
          turnId: 'another-turn',
          attachmentIndex: 0,
        }),
      ).rejects.toThrow('image attachment is unavailable');
      expect(createThumbnailFromPath).not.toHaveBeenCalled();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
