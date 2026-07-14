// DiffPanel: the diff viewer + comments + checkpoint revert (Phase 4, Tasks 10/11).
// Runs under jsdom with a stubbed `window.api` — the ONLY main-process access point —
// mirroring `ChatPanel.test.tsx`'s harness so the real @renderer/ipc funnel + real
// components run. Monaco can't render in jsdom, so `@monaco-editor/react` is mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { DiffPanel } from './DiffPanel';
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
}): ApiStub {
  const invoke = vi.fn((channel: string, req?: unknown) => {
    switch (channel) {
      case 'diff:get':
        return Promise.resolve(DIFF_SET);
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
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('DiffPanel file list + diff view', () => {
  it('renders the file list from diff:get, then fetches diff:file and mounts the DiffEditor on selection', async () => {
    installApi({});

    render(<DiffPanel workspaceId="ws1" />);

    const fileRow = await screen.findByTestId('diff-file-src/foo.ts');
    expect(screen.getByTestId('git-changes-header')).toHaveTextContent(
      'Changes 1',
    );
    expect(screen.getByText('All files')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('git-more'));
    expect(screen.getByTestId('commit-filter-menu')).toHaveTextContent('main');
    expect(screen.getByText('Target branch')).toBeInTheDocument();
    expect(screen.getByTestId('commit-filter-menu')).toHaveTextContent(
      'All changes',
    );

    expect(fileRow).toBeInTheDocument();
    expect(fileRow).toHaveTextContent('+3');
    expect(fileRow).toHaveTextContent('-1');

    fireEvent.click(fileRow);

    const monaco = await screen.findByTestId('monaco-diff');
    expect(monaco).toHaveAttribute('data-original', 'old line\n');
    expect(monaco).toHaveAttribute('data-modified', 'new line\n');
  });

  it('changes the target branch and scopes the list to uncommitted or the latest commit', async () => {
    const api = installApi({});

    render(<DiffPanel workspaceId="ws1" />);
    await screen.findByTestId('diff-file-src/foo.ts');

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
        scope: { kind: 'all' },
      }),
    );
    fireEvent.click(screen.getByTestId('git-more'));
    fireEvent.click(screen.getByTestId('git-scope-uncommitted'));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('diff:query', {
        workspaceId: 'ws1',
        targetRef: 'origin/develop',
        scope: { kind: 'uncommitted' },
      }),
    );
    expect(
      await screen.findByTestId('diff-file-src/pending.ts'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('diff-file-src/foo.ts'),
    ).not.toBeInTheDocument();

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

describe('DiffPanel comments', () => {
  it('creating a comment via the popover calls comment:create', async () => {
    const api = installApi({});

    render(<DiffPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('diff-file-src/foo.ts'));
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
          filePath: 'src/foo.ts',
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
        onChunk({ kind: 'started', turnId: 't1', sessionId: 'sess-1' });
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

    render(<DiffPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('diff-file-src/foo.ts'));
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
