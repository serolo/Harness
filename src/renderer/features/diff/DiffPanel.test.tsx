// DiffPanel: the diff viewer + comments + checkpoint revert (Phase 4, Tasks 10/11).
// Runs under jsdom with a stubbed `window.api` — the ONLY main-process access point —
// mirroring `ChatPanel.test.tsx`'s harness so the real @renderer/ipc funnel + real
// components run. Monaco can't render in jsdom, so `@monaco-editor/react` is mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { DiffPanel } from './DiffPanel';
import { createQueryClient } from '@renderer/app/providers';
import { useDiffStore } from '@renderer/stores/diff';
import { useChatStore } from '@renderer/stores/chat';
import type {
  Checkpoint,
  CommitInfo,
  DiffComment,
  DiffSet,
  FileDiff,
  SendToAgentResult,
} from '@shared/review';
import type { TurnStreamChunk } from '@shared/ipc';
import type { PrSummary } from '@shared/github';

// Monaco cannot render in jsdom — stub the DiffEditor as a plain div so DiffView
// mounts without pulling in the real editor.
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: (props: { original?: string; modified?: string }) => (
    <div
      data-testid="monaco-diff"
      data-original={props.original}
      data-modified={props.modified}
    />
  ),
  default: () => null,
}));

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

const DIFF_SET: DiffSet = {
  baseRef: 'main',
  headRef: 'HEAD',
  files: [
    {
      path: 'src/foo.ts',
      oldPath: null,
      change: 'modified',
      additions: 3,
      deletions: 1,
    },
  ],
};

const UNCOMMITTED_DIFF_SET: DiffSet = {
  baseRef: 'HEAD',
  headRef: 'HEAD',
  files: [
    {
      path: 'src/pending.ts',
      oldPath: null,
      change: 'modified',
      additions: 1,
      deletions: 0,
    },
  ],
};

const FILE_DIFF: FileDiff = {
  path: 'src/foo.ts',
  oldContent: 'old line\n',
  newContent: 'new line\n',
  hunks: [],
};

const COMMITS: CommitInfo[] = [
  {
    sha: '64e053b1234567890abcdef1234567890abcdef1',
    shortSha: '64e053b',
    subject: 'More ui changes',
    author: 'Sebastian Romero',
    date: Date.now() - 60 * 60 * 1000,
  },
];

const CHECKPOINTS: Checkpoint[] = [
  {
    id: 'cp1',
    workspaceId: 'ws1',
    turnId: 't1',
    refName: 'refs/checkpoints/ws1/0',
    sha: 'abcdef1234567890',
    createdAt: 1,
  },
];

let createdComment: DiffComment | null = null;

function installApi(opts: {
  comments?: DiffComment[];
  sendToAgentResult?: SendToAgentResult;
  stream?: ApiStub['stream'];
  diffSet?: DiffSet;
  workspacePr?: PrSummary | null;
  workspacePrError?: Error;
  workspacePrOpenError?: Error;
}): ApiStub {
  const invoke = vi.fn((channel: string, req?: unknown) => {
    switch (channel) {
      case 'diff:get':
        return Promise.resolve(opts.diffSet ?? DIFF_SET);
      case 'diff:menu': {
        const targetRef =
          (req as { targetRef?: string } | undefined)?.targetRef ??
          'origin/main';
        return Promise.resolve({
          currentBranch: 'agent/montpellier',
          targetRef,
          branches: ['origin/develop', 'origin/main'],
          commits: COMMITS,
          uncommittedFileCount: 1,
        });
      }
      case 'diff:query':
        return Promise.resolve(
          (req as { scope?: { kind?: string } } | undefined)?.scope?.kind ===
            'uncommitted'
            ? UNCOMMITTED_DIFF_SET
            : DIFF_SET,
        );
      case 'diff:commits':
        return Promise.resolve(COMMITS);
      case 'diff:file':
        return Promise.resolve(FILE_DIFF);
      case 'diff:fileQuery':
        return Promise.resolve(FILE_DIFF);
      case 'workspace:listDirectory': {
        const path = (req as { path?: string } | undefined)?.path ?? '';
        return Promise.resolve(
          path === 'src'
            ? [{ name: 'foo.ts', path: 'src/foo.ts', kind: 'file' }]
            : [
                { name: 'ci', path: 'ci', kind: 'directory' },
                { name: 'src', path: 'src', kind: 'directory' },
                { name: 'package.json', path: 'package.json', kind: 'file' },
              ],
        );
      }
      case 'comment:list':
        return Promise.resolve(opts.comments ?? []);
      case 'comment:create': {
        const r = req as {
          workspaceId: string;
          filePath: string;
          lineStart: number | null;
          lineEnd: number | null;
          side: 'old' | 'new' | null;
          body: string;
        };
        createdComment = {
          id: 'c1',
          workspaceId: r.workspaceId,
          filePath: r.filePath,
          lineStart: r.lineStart,
          lineEnd: r.lineEnd,
          side: r.side,
          body: r.body,
          state: 'open',
          createdAt: Date.now(),
        };
        return Promise.resolve(createdComment);
      }
      case 'comment:resolve':
        return Promise.resolve(undefined);
      case 'comment:remove':
        return Promise.resolve(undefined);
      case 'comment:sendToAgent':
        return Promise.resolve(opts.sendToAgentResult ?? { attachments: [] });
      case 'review:run':
        return Promise.resolve({ prompt: 'Please review the diff.' });
      case 'checkpoint:list':
        return Promise.resolve(CHECKPOINTS);
      case 'checkpoint:revert':
        return Promise.resolve(undefined);
      case 'chat:history':
        return Promise.resolve({ turns: [] });
      case 'harness:list':
        return Promise.resolve([]);
      case 'github:getWorkspacePr':
        return opts.workspacePrError
          ? Promise.reject(opts.workspacePrError)
          : Promise.resolve(opts.workspacePr ?? null);
      case 'github:openPrUrl':
        return opts.workspacePrOpenError
          ? Promise.reject(opts.workspacePrOpenError)
          : Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
  const api: ApiStub = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: opts.stream ?? vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

function renderDiffPanel(
  props: React.ComponentProps<typeof DiffPanel>,
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <DiffPanel {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  createdComment = null;
  useDiffStore.setState({
    diffSetByWorkspace: {},
    selectedPathByWorkspace: {},
    fileDiffCacheByWorkspace: {},
    commitsByWorkspace: {},
    commitFilterByWorkspace: {},
    commentsByWorkspace: {},
    reviewPendingByWorkspace: {},
  });
  useChatStore.setState({ byWorkspace: {}, busyByWorkspace: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('DiffPanel file list + diff view', () => {
  it('opens a lazy workspace tree from All files and sends file selections to the inspector', async () => {
    const api = installApi({});
    const onInspectFile = vi.fn();

    renderDiffPanel({ workspaceId: 'ws1', onInspectFile });
    await screen.findByTestId('diff-file-src/pending.ts');

    fireEvent.click(screen.getByRole('tab', { name: 'All files' }));

    expect(
      await screen.findByTestId('workspace-file-tree'),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All files' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(api.invoke).toHaveBeenCalledWith('workspace:listDirectory', {
      workspaceId: 'ws1',
      path: '',
    });

    fireEvent.click(screen.getByRole('button', { name: 'src' }));
    expect(await screen.findByText('foo.ts')).toBeInTheDocument();
    expect(api.invoke).toHaveBeenCalledWith('workspace:listDirectory', {
      workspaceId: 'ws1',
      path: 'src',
    });

    fireEvent.click(screen.getByRole('button', { name: 'foo.ts' }));
    expect(onInspectFile).toHaveBeenCalledWith('src/foo.ts');
  });

  it('renders the file list from diff:get, then fetches diff:file and mounts the DiffEditor on selection', async () => {
    installApi({});

    renderDiffPanel({ workspaceId: 'ws1' });

    const fileRow = await screen.findByTestId('diff-file-src/pending.ts');
    expect(screen.getByTestId('git-changes-header')).toHaveTextContent(
      'Changes 1',
    );
    expect(screen.getByTestId('git-changes-header')).toHaveAttribute(
      'data-ui',
      'panel-tab-bar',
    );
    expect(screen.getByText('All files')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('git-more'));
    expect(screen.getByTestId('commit-filter-menu')).toHaveTextContent('main');
    expect(screen.getByText('Target branch')).toBeInTheDocument();
    expect(screen.getByTestId('commit-filter-menu')).toHaveTextContent(
      'All changes',
    );

    expect(fileRow).toBeInTheDocument();
    expect(fileRow).toHaveTextContent('+1');

    fireEvent.click(fileRow);

    const monaco = await screen.findByTestId('monaco-diff');
    expect(monaco).toHaveAttribute('data-original', 'old line\n');
    expect(monaco).toHaveAttribute('data-modified', 'new line\n');
  });

  it('passes the selected target and scope to the center file inspector', async () => {
    installApi({});
    const onInspectFile = vi.fn();
    renderDiffPanel({ workspaceId: 'ws1', onInspectFile });

    fireEvent.click(await screen.findByTestId('diff-file-src/pending.ts'));
    expect(onInspectFile).toHaveBeenLastCalledWith('src/pending.ts', {
      targetRef: 'origin/main',
      scope: { kind: 'uncommitted' },
    });

    fireEvent.click(screen.getByTestId('git-more'));
    fireEvent.click(screen.getByTestId('git-scope-all'));
    fireEvent.click(await screen.findByTestId('diff-file-src/foo.ts'));
    expect(onInspectFile).toHaveBeenLastCalledWith('src/foo.ts', {
      targetRef: 'origin/main',
      scope: { kind: 'all' },
    });
  });

  it('changes the target branch and scopes the list to uncommitted or the latest commit', async () => {
    const api = installApi({});

    renderDiffPanel({ workspaceId: 'ws1' });
    await screen.findByTestId('diff-file-src/pending.ts');

    fireEvent.click(screen.getByTestId('git-more'));
    fireEvent.click(screen.getByTestId('git-target-branch'));
    fireEvent.click(screen.getByTestId('git-target-option-origin/develop'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('diff:menu', {
        workspaceId: 'ws1',
        targetRef: 'origin/develop',
      }),
    );
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('diff:query', {
        workspaceId: 'ws1',
        targetRef: 'origin/develop',
        scope: { kind: 'uncommitted' },
      }),
    );
    fireEvent.click(screen.getByTestId('git-more'));
    fireEvent.click(screen.getByTestId('git-scope-all'));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('diff:query', {
        workspaceId: 'ws1',
        targetRef: 'origin/develop',
        scope: { kind: 'all' },
      }),
    );
    expect(
      await screen.findByTestId('diff-file-src/foo.ts'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('git-more'));
    fireEvent.click(screen.getByTestId(`git-scope-commit-${COMMITS[0].sha}`));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('diff:query', {
        workspaceId: 'ws1',
        targetRef: 'origin/develop',
        scope: { kind: 'commit', sha: COMMITS[0].sha },
      }),
    );
  });
});

describe('DiffPanel existing pull request action', () => {
  const WORKSPACE_PR: PrSummary = {
    number: 42,
    url: 'https://github.com/acme/repo/pull/42',
    title: 'Improve the Git changes toolbar',
    draft: false,
    mergeableState: 'clean',
    state: 'open',
  };

  it('opens the active workspace existing PR through the narrow IPC command without creating one', async () => {
    const api = installApi({ workspacePr: WORKSPACE_PR });

    renderDiffPanel({ workspaceId: 'ws1' });

    const openPr = await screen.findByRole('button', { name: 'Open PR' });
    expect(api.invoke).toHaveBeenCalledWith('github:getWorkspacePr', {
      workspaceId: 'ws1',
    });
    expect(screen.getByTestId('git-changes-header')).toContainElement(openPr);

    fireEvent.click(openPr);

    expect(api.invoke).toHaveBeenCalledWith('github:openPrUrl', {
      url: WORKSPACE_PR.url,
    });
    expect(api.invoke).not.toHaveBeenCalledWith('pr:open', expect.anything());
  });

  it('keeps Open PR available in the Git changes toolbar when there are no file changes', async () => {
    installApi({
      workspacePr: WORKSPACE_PR,
      diffSet: { ...DIFF_SET, files: [] },
    });

    renderDiffPanel({ workspaceId: 'ws1' });

    expect(await screen.findByTestId('diff-no-changes')).toBeInTheDocument();
    const openPr = await screen.findByRole('button', { name: 'Open PR' });
    expect(screen.getByTestId('git-changes-header')).toContainElement(openPr);
  });

  it('keeps refreshing a non-terminal PR while the Git pane is mounted', async () => {
    vi.useFakeTimers();
    const api = installApi({ workspacePr: WORKSPACE_PR });

    renderDiffPanel({ workspaceId: 'ws1' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      api.invoke.mock.calls.filter(
        ([channel]) => channel === 'github:getWorkspacePr',
      ),
    ).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      api.invoke.mock.calls.filter(
        ([channel]) => channel === 'github:getWorkspacePr',
      ).length,
    ).toBeGreaterThan(1);
  });

  it('reports a browser launch failure without exposing error details', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    installApi({
      workspacePr: WORKSPACE_PR,
      workspacePrOpenError: new Error('secret diagnostic details'),
    });

    renderDiffPanel({ workspaceId: 'ws1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open PR' }));

    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        'Failed to open the pull request in your browser.',
      ),
    );
    expect(alert).not.toHaveBeenCalledWith(
      expect.stringContaining('secret diagnostic details'),
    );
  });

  it('refetches the workspace PR when its branch or PR-number cache revision changes', async () => {
    const api = installApi({ workspacePr: WORKSPACE_PR });
    const queryClient = createQueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DiffPanel
          workspaceId="ws1"
          workspaceBranch="agent/first-branch"
          workspacePrNumber={null}
        />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        api.invoke.mock.calls.filter(
          ([channel]) => channel === 'github:getWorkspacePr',
        ),
      ).toHaveLength(1),
    );

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DiffPanel
          workspaceId="ws1"
          workspaceBranch="agent/renamed-branch"
          workspacePrNumber={null}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        api.invoke.mock.calls.filter(
          ([channel]) => channel === 'github:getWorkspacePr',
        ),
      ).toHaveLength(2),
    );

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DiffPanel
          workspaceId="ws1"
          workspaceBranch="agent/renamed-branch"
          workspacePrNumber={42}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        api.invoke.mock.calls.filter(
          ([channel]) => channel === 'github:getWorkspacePr',
        ),
      ).toHaveLength(3),
    );
  });

  it.each([
    ['the workspace has no PR', { workspacePr: null }],
    [
      'the PR lookup fails',
      { workspacePrError: new Error('GitHub unavailable') },
    ],
  ])('hides Open PR when %s', async (_case, apiOptions) => {
    const api = installApi(apiOptions);

    renderDiffPanel({ workspaceId: 'ws1' });

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('github:getWorkspacePr', {
        workspaceId: 'ws1',
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Open PR' }),
    ).not.toBeInTheDocument();
  });

  it('does not look up or show a PR action without an active workspace', () => {
    const api = installApi({ workspacePr: WORKSPACE_PR });

    renderDiffPanel({ workspaceId: null });

    expect(api.invoke).not.toHaveBeenCalledWith(
      'github:getWorkspacePr',
      expect.anything(),
    );
    expect(
      screen.queryByRole('button', { name: 'Open PR' }),
    ).not.toBeInTheDocument();
  });
});

describe('DiffPanel comments', () => {
  it('creating a comment via the popover calls comment:create', async () => {
    const api = installApi({});

    renderDiffPanel({ workspaceId: 'ws1' });

    fireEvent.click(await screen.findByTestId('diff-file-src/pending.ts'));
    await screen.findByTestId('monaco-diff');

    fireEvent.click(screen.getByTestId('diff-view-add-comment'));
    fireEvent.change(screen.getByTestId('comment-line-input'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByTestId('comment-body-input'), {
      target: { value: 'nit: rename this' },
    });
    fireEvent.click(screen.getByTestId('comment-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'comment:create',
        expect.objectContaining({
          workspaceId: 'ws1',
          filePath: 'src/pending.ts',
          lineStart: 2,
          lineEnd: 2,
          side: 'new',
          body: 'nit: rename this',
        }),
      ),
    );
    expect(await screen.findByTestId('comment-item-c1')).toHaveTextContent(
      'nit: rename this',
    );
  });

  it('"Send to agent" calls comment:sendToAgent then streams a turn', async () => {
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: TurnStreamChunk) => void,
      ) => {
        onChunk({
          kind: 'started',
          turnId: 't1',
          sessionId: 'sess-1',
          mode: 'default',
        });
        onChunk({ kind: 'event', event: { kind: 'turn_end', usage: {} } });
        return Promise.resolve();
      },
    );
    const existingComment: DiffComment = {
      id: 'c1',
      workspaceId: 'ws1',
      filePath: 'src/foo.ts',
      lineStart: 2,
      lineEnd: 2,
      side: 'new',
      body: 'nit',
      state: 'open',
      createdAt: 1,
    };
    const api = installApi({
      comments: [existingComment],
      sendToAgentResult: {
        attachments: [
          {
            type: 'diff_comment',
            file: 'src/foo.ts',
            lineStart: 2,
            lineEnd: 2,
            side: 'new',
            excerpt: 'new line',
            body: 'nit',
          },
        ],
      },
      stream,
    });

    renderDiffPanel({ workspaceId: 'ws1' });

    fireEvent.click(await screen.findByTestId('diff-file-src/pending.ts'));
    const sendButton = await screen.findByTestId('send-to-agent');
    expect(sendButton).toHaveTextContent('Send to agent (1)');
    fireEvent.click(sendButton);

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('comment:sendToAgent', {
        workspaceId: 'ws1',
      }),
    );
    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(stream.mock.calls[0][0]).toBe('turn:start');
    expect(stream.mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws1',
      prompt: 'Please address the following review comments.',
    });
  });
});
