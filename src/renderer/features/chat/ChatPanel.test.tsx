// ChatPanel: reconstruction from chat:history, live streaming over turn:start, and
// interrupt (Phase 2, Task 9). Runs under jsdom with a stubbed `window.api` — the ONLY
// main-process access point — so the real @renderer/ipc funnel + real components run.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from '@testing-library/react';

import { ChatPanel } from './ChatPanel';
import { useChatStore } from '@renderer/stores/chat';
import { useWorkspaceCreationStore } from '@renderer/stores/workspaceCreation';
import { useWorkspaceArchiveStore } from '@renderer/stores/workspaceArchive';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useHarnessStore } from '@renderer/stores/harness';
import {
  DEFAULT_MODEL_PREFERENCES,
  writeModelPreferences,
} from '../settings/modelPreferences';
import type {
  ChatHistory,
  HarnessInfo,
  TurnStreamChunk,
  WorkspaceDirectoryEntry,
} from '@shared/ipc';
import type { SlashCommand } from '@shared/slash';
import type { FileDiff } from '@shared/review';
import type { ScheduledTask } from '@shared/tasks';
import type { ChatContextRecord } from '@shared/models';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

const HARNESS_LIST: HarnessInfo[] = [
  {
    id: 'claude_code',
    capabilities: {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: true,
      rawTerminalFallback: true,
    },
    detect: { installed: true, authenticated: true },
  },
];

const CURSOR_HARNESS: HarnessInfo = {
  id: 'cursor',
  capabilities: {
    supportsResume: false,
    supportsMcp: false,
    supportsPlanMode: false,
    rawTerminalFallback: true,
  },
  detect: { installed: true, authenticated: true },
};

function installApi(opts: {
  /**
   * Fixed history, or a per-call function keyed by the request (lets a test build a
   * tiny fake backend where `chat:history` reflects turns a custom `stream` stub has
   * persisted — see the manual-tab-persistence regression tests below).
   */
  history?: ChatHistory | ((req: { workspaceId: string }) => ChatHistory);
  stream?: ApiStub['stream'];
  slashCommands?: SlashCommand[] | (() => SlashCommand[]);
  files?: Record<string, string>;
  plans?: Record<string, string>;
  fileDiffs?: Record<string, FileDiff>;
  tasks?: ScheduledTask[];
  revealError?: Error;
  imagePreviews?: Record<string, string>;
  pickedFile?: string;
  directories?: Record<string, WorkspaceDirectoryEntry[]>;
}): ApiStub {
  // Fake `chat_contexts` persistence, keyed by workspace — mirrors main's
  // `ChatContextsRepo`: `list` bootstraps a single 'Untitled' tab the first time a
  // workspace is asked for, and stays populated across calls within the same test
  // (real persistence), so a simulated remount (rerender with a different then the
  // same workspaceId) sees whatever `create`/`rename`/`close` already did.
  const contextsByWorkspace = new Map<string, ChatContextRecord[]>();
  let nextContextSeq = 1;

  function contextsFor(workspaceId: string): ChatContextRecord[] {
    let list = contextsByWorkspace.get(workspaceId);
    if (!list) {
      list = [];
      contextsByWorkspace.set(workspaceId, list);
    }
    return list;
  }

  const invoke = vi.fn((channel: string, req?: unknown) => {
    if (channel === 'chat:history') {
      const historyReq = req as { workspaceId: string };
      const history =
        typeof opts.history === 'function'
          ? opts.history(historyReq)
          : (opts.history ?? { turns: [] });
      return Promise.resolve(history);
    }
    if (channel === 'chat:contexts:list') {
      const { workspaceId } = req as { workspaceId: string };
      const list = contextsFor(workspaceId);
      if (list.length === 0) {
        list.push({
          id: `ctx-${workspaceId}-${nextContextSeq++}`,
          workspaceId,
          label: 'Untitled',
          initialSessionId: null,
          position: 0,
          createdAt: 0,
        });
      }
      return Promise.resolve([...list]);
    }
    if (channel === 'chat:contexts:create') {
      const { workspaceId, label, initialSessionId } = req as {
        workspaceId: string;
        label?: string;
        initialSessionId?: string | null;
      };
      const list = contextsFor(workspaceId);
      const created: ChatContextRecord = {
        id: `ctx-${workspaceId}-${nextContextSeq++}`,
        workspaceId,
        label: label?.trim() ? label.trim() : 'Untitled',
        initialSessionId: initialSessionId ?? null,
        position: list.length,
        createdAt: 0,
      };
      list.push(created);
      return Promise.resolve(created);
    }
    if (channel === 'chat:contexts:rename') {
      const { contextId, label } = req as {
        contextId: string;
        label: string;
      };
      for (const list of contextsByWorkspace.values()) {
        const match = list.find((context) => context.id === contextId);
        if (match) {
          match.label = label;
          return Promise.resolve(undefined);
        }
      }
      return Promise.reject(new Error('chat context not found'));
    }
    if (channel === 'chat:contexts:close') {
      const { contextId } = req as { contextId: string };
      for (const list of contextsByWorkspace.values()) {
        const index = list.findIndex((context) => context.id === contextId);
        if (index >= 0) {
          list.splice(index, 1);
          break;
        }
      }
      return Promise.resolve(undefined);
    }
    if (channel === 'harness:list') return Promise.resolve(HARNESS_LIST);
    if (channel === 'turn:interrupt') return Promise.resolve(undefined);
    if (channel === 'chat:clear') return Promise.resolve(undefined);
    if (channel === 'task:list') return Promise.resolve(opts.tasks ?? []);
    if (channel === 'workspace:readFile') {
      const path = (req as { path?: string } | undefined)?.path ?? '';
      return Promise.resolve({
        path,
        content: opts.files?.[path] ?? '',
      });
    }
    if (channel === 'plan:read') {
      const path = (req as { path?: string } | undefined)?.path ?? '';
      return Promise.resolve({
        path,
        content: opts.plans?.[path] ?? '',
      });
    }
    if (channel === 'diff:file' || channel === 'diff:fileQuery') {
      const path = (req as { path?: string } | undefined)?.path ?? '';
      return Promise.resolve(
        opts.fileDiffs?.[path] ?? {
          path,
          oldContent: opts.files?.[path] ?? '',
          newContent: opts.files?.[path] ?? '',
          hunks: [],
        },
      );
    }
    if (channel === 'workspace:pickFile') {
      return Promise.resolve(opts.pickedFile ?? '/tmp/ws/src/app.ts');
    }
    if (channel === 'workspace:listDirectory') {
      const path = (req as { path?: string } | undefined)?.path ?? '';
      return Promise.resolve(opts.directories?.[path] ?? []);
    }
    if (channel === 'file:revealInFinder') {
      return opts.revealError
        ? Promise.reject(opts.revealError)
        : Promise.resolve(undefined);
    }
    if (channel === 'attachment:imagePreview') {
      const { turnId, attachmentIndex } = req as {
        turnId: string;
        attachmentIndex: number;
      };
      const dataUrl = opts.imagePreviews?.[`${turnId}:${attachmentIndex}`];
      return dataUrl
        ? Promise.resolve({ dataUrl })
        : Promise.reject(new Error('preview unavailable'));
    }
    if (channel === 'slash:list')
      return Promise.resolve(
        (typeof opts.slashCommands === 'function'
          ? opts.slashCommands()
          : opts.slashCommands) ?? [
          {
            name: 'review',
            template: 'Review the current changes.',
            description: 'Review current changes',
          },
          {
            name: 'fix-checks',
            template: 'Fix checks\n\n$ARGS',
            description: 'Investigate failing checks',
          },
        ],
      );
    return Promise.resolve(undefined);
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
  window.localStorage.clear();
  useChatStore.setState({
    byWorkspace: {},
    busyByWorkspace: {},
    taskTurnsByWorkspace: {},
  });
  useWorkspaceCreationStore.setState({ current: null });
  useWorkspaceArchiveStore.setState({ current: null });
  useHarnessStore.setState({ infoById: {}, loaded: false, loading: false });
  useWorkspacesStore.setState({
    projects: [],
    workspaces: [],
    selectedWorkspaceId: null,
    selectedProjectId: null,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('ChatPanel reconstruction', () => {
  it('shows a GitHub PR refresh error in chat and offers an explicit retry', async () => {
    installApi({});
    const retry = vi.fn();

    render(
      <ChatPanel
        workspaceId="ws1"
        workspacePrError={new Error('Connect Timeout Error')}
        onRetryWorkspacePr={retry}
      />,
    );

    const alert = await screen.findByTestId('github-pr-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(
      'Could not refresh the GitHub pull request: Connect Timeout Error',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('opens and selects a dedicated tab when a scheduled task starts', async () => {
    const api = installApi({});
    render(<ChatPanel workspaceId="ws1" />);

    await waitFor(() =>
      expect(
        api.on.mock.calls.some(([event]) => event === 'task:turnStarted'),
      ).toBe(true),
    );
    const listener = api.on.mock.calls.find(
      ([event]) => event === 'task:turnStarted',
    )?.[1] as
      | ((payload: {
          workspaceId: string;
          taskId: string;
          turnId: string;
          sessionId: string;
          prompt: string;
        }) => void)
      | undefined;

    act(() => {
      listener?.({
        workspaceId: 'ws1',
        taskId: 'task-1',
        turnId: 'turn-task-1',
        sessionId: 'session-task-1',
        prompt: 'Audit the release workflow',
      });
    });

    const taskTab = screen.getByRole('tab', {
      name: /Task: Audit the release workflow/i,
    });
    expect(taskTab).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps a scheduled turn out of the current chat context', async () => {
    const api = installApi({
      history: {
        turns: [
          {
            id: 'turn-chat-1',
            workspaceId: 'ws1',
            idx: 0,
            status: 'completed',
            sessionId: 'session-chat-1',
            mode: 'default',
            startedAt: 1,
            endedAt: 2,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            harness: 'claude_code',
            model: null,
            costMicros: null,
            contextId: 'ctx-ws1-1',
            pricingKey: null,
            events: [
              {
                id: 'event-chat-1',
                turnId: 'turn-chat-1',
                kind: 'text',
                ts: 2,
                event: { kind: 'text', delta: 'Current chat response' },
              },
            ],
          },
        ],
      },
    });
    render(<ChatPanel workspaceId="ws1" />);

    expect(
      await screen.findByText('Current chat response'),
    ).toBeInTheDocument();
    const listener = api.on.mock.calls.find(
      ([event]) => event === 'task:turnStarted',
    )?.[1] as
      | ((payload: {
          workspaceId: string;
          taskId: string;
          turnId: string;
          sessionId: string;
          prompt: string;
        }) => void)
      | undefined;

    act(() => {
      useChatStore
        .getState()
        .startTaskTurn(
          'ws1',
          'task-1',
          'turn-task-1',
          'session-task-1',
          'Scheduled prompt',
        );
      useChatStore
        .getState()
        .appendEvent(
          'ws1',
          { kind: 'text', delta: 'Scheduled response' },
          'turn-task-1',
        );
      listener?.({
        workspaceId: 'ws1',
        taskId: 'task-1',
        turnId: 'turn-task-1',
        sessionId: 'session-task-1',
        prompt: 'Scheduled prompt',
      });
    });

    expect(await screen.findByText('Scheduled response')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Untitled — double-click to rename'));
    expect(screen.getByText('Current chat response')).toBeInTheDocument();
    expect(screen.queryByText('Scheduled response')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByTitle('Task: Scheduled prompt — double-click to rename'),
    );
    expect(screen.getByText('Scheduled response')).toBeInTheDocument();
    expect(screen.queryByText('Current chat response')).not.toBeInTheDocument();
  });

  it('restores a completed task in its own tab from persisted history', async () => {
    installApi({
      tasks: [
        {
          id: 'task-1',
          workspaceId: 'ws1',
          prompt: 'Audit the release workflow',
          model: null,
          mode: null,
          scheduledAt: null,
          state: 'done',
          origin: 'user',
          turnId: 'turn-task-1',
          errorMessage: null,
          createdAt: 1,
          updatedAt: 2,
          harnessOverride: null,
          attachments: [],
        },
      ],
      history: {
        turns: [
          {
            id: 'turn-task-1',
            workspaceId: 'ws1',
            idx: 0,
            status: 'completed',
            sessionId: 'session-task-1',
            mode: 'default',
            startedAt: 1,
            endedAt: 2,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            harness: 'claude_code',
            model: null,
            costMicros: null,
            pricingKey: null,
            events: [
              {
                id: 'event-1',
                turnId: 'turn-task-1',
                kind: 'user_message',
                ts: 1,
                event: {
                  kind: 'user_message',
                  text: 'Audit the release workflow',
                },
              },
              {
                id: 'event-2',
                turnId: 'turn-task-1',
                kind: 'text',
                ts: 2,
                event: { kind: 'text', delta: 'Audit complete.' },
              },
            ],
          },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);

    const taskTab = await screen.findByRole('tab', {
      name: /Task: Audit the release workflow/i,
    });
    fireEvent.click(
      screen.getByTitle(
        'Task: Audit the release workflow — double-click to rename',
      ),
    );
    expect(taskTab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Audit complete.')).toBeInTheDocument();
  });

  it('shows workspace context at the start of a new chat', async () => {
    installApi({});
    useWorkspacesStore.setState({
      projects: [
        {
          id: 'project-1',
          name: 'w2-platform',
          originUrl: 'git@github.com:acme/w2-platform.git',
          defaultBranch: 'main',
          repoPath: '/src/w2-platform',
          createdAt: 1,
        },
      ],
      workspaces: [
        {
          id: 'ws1',
          projectId: 'project-1',
          name: 'FeatureFlag Context',
          branch: 'feature/featureflag-context',
          baseBranch: 'main',
          worktreePath: '/src/worktrees/featureflag-context',
          status: 'idle',
          sourceKind: 'pr',
          sourceRef: '42',
          harness: 'claude_code',
          port: 3001,
          createdAt: 1,
          archivedAt: null,
          prNumber: 42,
          location: 'worktree',
        },
      ],
      selectedWorkspaceId: 'ws1',
      selectedProjectId: 'project-1',
    });

    render(<ChatPanel workspaceId="ws1" />);

    expect(screen.getByTestId('transcript')).toHaveClass('pb-8');
    expect(screen.getByTestId('composer')).toHaveClass('pt-4', 'px-6');
    const context = await screen.findByTestId('new-chat-workspace-context');
    expect(context).toHaveTextContent('FeatureFlag Context');
    expect(context).toHaveTextContent('feature/featureflag-context');
    expect(context).toHaveTextContent('Base branchmain');
    expect(context).toHaveTextContent('w2-platform');
    expect(context).toHaveTextContent('Worktreefeatureflag-context');
    expect(context).not.toHaveTextContent('/src/worktrees/featureflag-context');
    expect(context).toHaveTextContent('PR #42');
  });

  it('shows workspace creation progress in a chat terminal', async () => {
    installApi({});
    useWorkspaceCreationStore.setState({
      current: {
        runId: 'create-1',
        projectId: 'project-1',
        workspaceId: 'ws1',
        phase: 'Running setup…',
        lines: ['Installing dependencies', 'Ready'],
        status: 'creating',
        error: null,
      },
    });

    const { rerender } = render(<ChatPanel workspaceId="ws1" />);

    expect(
      await screen.findByTestId('workspace-creation-terminal'),
    ).toHaveTextContent('Running setup…');
    expect(screen.getByText('Installing dependencies')).toBeInTheDocument();

    rerender(<ChatPanel workspaceId="ws2" />);
    expect(
      screen.queryByTestId('workspace-creation-terminal'),
    ).not.toBeInTheDocument();
  });

  it('dismisses completed workspace creation output after five seconds', async () => {
    vi.useFakeTimers();
    installApi({});
    useWorkspaceCreationStore.setState({
      current: {
        runId: 'create-complete',
        projectId: 'project-1',
        workspaceId: 'ws1',
        phase: 'Workspace ready',
        lines: ['Workspace ready'],
        status: 'complete',
        error: null,
      },
    });

    render(<ChatPanel workspaceId="ws1" />);
    expect(
      screen.getByTestId('workspace-creation-terminal'),
    ).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(4_999));
    expect(
      screen.getByTestId('workspace-creation-terminal'),
    ).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.queryByTestId('workspace-creation-terminal'),
    ).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('shows workspace archive progress and script output in chat', async () => {
    installApi({});
    useWorkspaceArchiveStore.setState({
      current: {
        workspaceId: 'ws1',
        workspaceName: 'paris',
        phase: 'Running archive script…',
        lines: ['Stopping server', 'Cleanup complete'],
        status: 'running',
        error: null,
      },
    });

    const { rerender } = render(<ChatPanel workspaceId="ws1" />);

    expect(
      await screen.findByTestId('workspace-archive-terminal'),
    ).toHaveTextContent('Archiving paris');
    expect(screen.getByText('Stopping server')).toBeInTheDocument();

    rerender(<ChatPanel workspaceId="ws2" />);
    expect(
      screen.queryByTestId('workspace-archive-terminal'),
    ).not.toBeInTheDocument();
  });

  it('rebuilds a transcript from chat:history (text, tool card, todo, divider)', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't1',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-1',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: 10,
          outputTokens: 20,
          costMicros: 123_400,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'e0',
              turnId: 't1',
              kind: 'user_message',
              ts: 0,
              event: { kind: 'user_message', text: 'Please inspect this' },
            },
            {
              id: 'e1',
              turnId: 't1',
              kind: 'text',
              ts: 1,
              event: { kind: 'text', delta: 'Hello **world**' },
            },
            {
              id: 'e2',
              turnId: 't1',
              kind: 'tool_use',
              ts: 2,
              event: { kind: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
            },
            {
              id: 'e3',
              turnId: 't1',
              kind: 'todo_update',
              ts: 3,
              event: {
                kind: 'todo_update',
                todos: [
                  { id: '1', body: 'do it', done: false, source: 'agent' },
                ],
              },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    expect(await screen.findByText('world')).toBeInTheDocument();
    const userMessage = screen.getByTestId('chat-user-message');
    expect(userMessage).toHaveTextContent('Please inspect this');
    expect(userMessage).toHaveClass('min-w-0', 'justify-end');
    expect(screen.getByTestId('chat-user-message-bubble')).toHaveClass(
      'min-w-0',
      'max-w-[82%]',
      '[overflow-wrap:anywhere]',
    );
    expect(screen.getByTestId('tool-card')).toBeInTheDocument();
    expect(screen.getByTestId('todo-list')).toBeInTheDocument();
    const divider = screen.getByTestId('turn-divider');
    expect(divider).toHaveAttribute('data-status', 'completed');

    fireEvent.mouseEnter(screen.getByTestId('composer-context'));
    const contextPopover = screen.getByTestId('composer-context-popover');
    expect(contextPopover).toHaveTextContent('30/200.0k');
    fireEvent.mouseEnter(contextPopover);
    fireEvent.mouseLeave(contextPopover);
    expect(
      screen.queryByTestId('composer-context-popover'),
    ).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId('composer-cost'));
    const costPopover = screen.getByTestId('composer-cost-popover');
    expect(costPopover).toHaveTextContent('$0.1234');
    expect(costPopover).toHaveTextContent('Priced turns1');
    fireEvent.mouseEnter(costPopover);
    fireEvent.mouseLeave(costPopover);
    expect(
      screen.queryByTestId('composer-cost-popover'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('composer-model'));
    fireEvent.click(
      await screen.findByTestId('composer-model-option-claude-sonnet-5-1m'),
    );
    expect(
      screen.getByTestId('composer-model-switch-notice'),
    ).toHaveTextContent(
      'When you switch models mid-chat, your next response may be slower and use more tokens.',
    );
    fireEvent.click(screen.getByTestId('composer-model-switch-notice-dismiss'));
    expect(
      screen.queryByTestId('composer-model-switch-notice'),
    ).not.toBeInTheDocument();
  });

  it('renders a persisted user image attachment when history is rebuilt', async () => {
    const dataUrl = 'data:image/png;base64,cHJldmlldw==';
    const history: ChatHistory = {
      turns: [
        {
          id: 't-image',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-image',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: 1,
          outputTokens: 1,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'e-image-message',
              turnId: 't-image',
              kind: 'user_message',
              ts: 1,
              event: { kind: 'user_message', text: 'Use this screenshot' },
            },
            {
              id: 'e-image-attachment',
              turnId: 't-image',
              kind: 'user_attachments',
              ts: 2,
              event: {
                kind: 'user_attachments',
                attachments: [{ type: 'image', path: '/private/a/screen.png' }],
              },
            },
          ],
        },
      ],
    };
    const api = installApi({
      history,
      imagePreviews: { 't-image:0': dataUrl },
    });

    render(<ChatPanel workspaceId="ws1" />);

    const image = await screen.findByRole('img', { name: 'screen.png' });
    expect(image).toHaveAttribute('src', dataUrl);
    expect(screen.getByTestId('chat-user-attachments')).toHaveTextContent(
      'screen.png',
    );
    expect(screen.queryByText('/private/a/screen.png')).not.toBeInTheDocument();
    expect(api.invoke).toHaveBeenCalledWith('attachment:imagePreview', {
      workspaceId: 'ws1',
      turnId: 't-image',
      attachmentIndex: 0,
    });
  });

  it('uses the latest provider usage snapshot instead of summing resumed contexts', async () => {
    const turn = (
      id: string,
      idx: number,
      inputTokens: number,
      outputTokens: number,
    ): ChatHistory['turns'][number] => ({
      id,
      workspaceId: 'ws1',
      idx,
      status: 'completed',
      sessionId: 'sess-shared',
      mode: 'default',
      startedAt: idx + 1,
      endedAt: idx + 2,
      inputTokens,
      outputTokens,
      contextId: 'ctx-ws1-1',
      events: [],
    });
    installApi({
      history: {
        turns: [
          turn('t-context-1', 0, 100, 10),
          turn('t-context-2', 1, 150, 20),
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('composer-context'));
    expect(screen.getByTestId('composer-context-popover')).toHaveTextContent(
      '170/200.0k',
    );
    expect(
      screen.getByTestId('composer-context-popover'),
    ).not.toHaveTextContent('280/200.0k');
  });

  it('uses the latest per-call context snapshot instead of cumulative Claude turn usage', async () => {
    installApi({
      history: {
        turns: [
          {
            id: 't-context',
            workspaceId: 'ws1',
            idx: 0,
            status: 'completed',
            sessionId: 'sess-context',
            mode: 'default',
            startedAt: 1,
            endedAt: 2,
            inputTokens: 317_297,
            outputTokens: 1_297,
            contextId: 'ctx-ws1-1',
            events: [
              {
                id: 'context-usage',
                turnId: 't-context',
                kind: 'context_usage',
                ts: 1,
                event: {
                  kind: 'context_usage',
                  usage: { inputTokens: 107_000, outputTokens: 500 },
                },
              },
            ],
          },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('composer-context'));
    expect(screen.getByTestId('composer-context-popover')).toHaveTextContent(
      '107.5k/200.0k',
    );
    expect(screen.getByTestId('turn-divider')).toHaveTextContent(
      '107k in / 500 out',
    );
  });

  it('restores a completed plan from history and approves it into a default turn', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 'plan-turn',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'plan-session',
          mode: 'plan',
          startedAt: 1,
          endedAt: 2,
          inputTokens: null,
          outputTokens: null,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'plan-text',
              turnId: 'plan-turn',
              kind: 'text',
              ts: 1,
              event: {
                kind: 'text',
                delta: '## Implementation plan\n\n1. Update the parser.',
              },
            },
          ],
        },
      ],
    };
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: TurnStreamChunk) => void,
      ) => {
        onChunk({
          kind: 'started',
          turnId: 'implementation-turn',
          sessionId: 'plan-session',
          mode: 'default',
        });
        onChunk({ kind: 'event', event: { kind: 'turn_end' } });
        return Promise.resolve();
      },
    );
    installApi({ history, stream });

    render(<ChatPanel workspaceId="ws1" />);

    expect(await screen.findByText('Implementation plan')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('plan-approve'));

    await waitFor(() =>
      expect(stream).toHaveBeenCalledWith(
        'turn:start',
        expect.objectContaining({
          workspaceId: 'ws1',
          prompt: 'The plan is approved. Start implementing it now.',
          mode: 'default',
          sessionId: 'plan-session',
        }),
        expect.any(Function),
        expect.anything(),
      ),
    );
  });

  it('renders semantic tool summaries with expandable command output', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-tool-detail',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-1',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: null,
          outputTokens: null,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'tool-use',
              turnId: 't-tool-detail',
              kind: 'tool_use',
              ts: 1,
              event: {
                kind: 'tool_use',
                name: 'Bash',
                input: {
                  command: 'git status --short',
                  description: 'Check repository status',
                },
              },
            },
            {
              id: 'tool-result',
              turnId: 't-tool-detail',
              kind: 'tool_result',
              ts: 2,
              event: {
                kind: 'tool_result',
                output: 'M src/renderer/features/chat/ToolCard.tsx',
              },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    const tool = await screen.findByTestId('tool-card');
    expect(tool).toHaveAttribute('data-tool-kind', 'command');
    expect(tool).toHaveTextContent('Check repository status');
    expect(tool).toHaveTextContent('git status --short');
    expect(
      screen.queryByText('M src/renderer/features/chat/ToolCard.tsx'),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /check repository status/i }),
    );
    expect(screen.getByTestId('tool-card-detail')).toHaveTextContent(
      'M src/renderer/features/chat/ToolCard.tsx',
    );
  });

  it('renders model questions and permission prompts as different UI', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-interactions',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-1',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: null,
          outputTokens: null,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'q1',
              turnId: 't-interactions',
              kind: 'question_request',
              ts: 1,
              event: {
                kind: 'question_request',
                questions: [
                  {
                    header: 'Framework',
                    question: 'Which framework should I use?',
                    options: [
                      { label: 'React', description: 'Use components' },
                    ],
                  },
                ],
              },
            },
            {
              id: 'p1',
              turnId: 't-interactions',
              kind: 'permission_request',
              ts: 2,
              event: {
                kind: 'permission_request',
                title: 'Allow package publishing?',
                description: 'This writes to an external registry.',
                toolName: 'command_execution',
                input: { command: 'npm publish' },
              },
            },
          ],
        },
      ],
    };
    const api = installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    expect(await screen.findByTestId('question-card')).toHaveTextContent(
      'Which framework should I use?',
    );
    expect(screen.getByTestId('question-card')).toHaveTextContent('React');
    expect(screen.getByTestId('permission-card')).toHaveTextContent(
      'Allow package publishing?',
    );
    expect(screen.queryAllByTestId('tool-card')).toHaveLength(0);

    fireEvent.click(screen.getByText('Review requested action'));
    expect(screen.getByText(/npm publish/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /React/ }));
    fireEvent.click(screen.getByTestId('question-submit'));
    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    expect(api.stream.mock.calls[0]?.[1]).toMatchObject({
      workspaceId: 'ws1',
      prompt: 'React',
      sessionId: 'sess-1',
    });
  });

  it('turns a plan-mode unavailable-tool fallback into a resumable chat question', async () => {
    const api = installApi({
      history: {
        turns: [
          {
            id: 't-direct-question',
            workspaceId: 'ws1',
            idx: 0,
            status: 'completed',
            sessionId: 'sess-question',
            mode: 'plan',
            startedAt: 1,
            endedAt: 2,
            inputTokens: null,
            outputTokens: null,
            contextId: 'ctx-ws1-1',
            events: [
              {
                id: 'q-fallback',
                turnId: 't-direct-question',
                kind: 'text',
                ts: 1,
                event: {
                  kind: 'text',
                  delta:
                    "The comparison is above. Since AskUserQuestion isn't available here, I'll just ask directly — which database should I use?",
                },
              },
            ],
          },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);

    expect(await screen.findByTestId('question-card')).toHaveTextContent(
      'which database should I use?',
    );
    expect(screen.queryByText(/isn't available here/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Approve plan & start/i }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('which database should I use?'), {
      target: { value: 'PostgreSQL' },
    });
    fireEvent.click(screen.getByTestId('question-submit'));

    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    expect(api.stream.mock.calls[0]?.[1]).toMatchObject({
      prompt: 'PostgreSQL',
      sessionId: 'sess-question',
      mode: 'plan',
    });
  });

  it('does not offer plan approval when plan-mode prose asks for clarification', async () => {
    installApi({
      history: {
        turns: [
          {
            id: 't-prose-question',
            workspaceId: 'ws1',
            idx: 0,
            status: 'completed',
            sessionId: 'sess-prose-question',
            mode: 'plan',
            startedAt: 1,
            endedAt: 2,
            inputTokens: null,
            outputTokens: null,
            contextId: 'ctx-ws1-1',
            events: [
              {
                id: 'prose-question',
                turnId: 't-prose-question',
                kind: 'text',
                ts: 1,
                event: {
                  kind: 'text',
                  delta:
                    'I need to know what outcome you want. Tell me (a/b/c/d) and the scope answer, and I’ll take it from there.',
                },
              },
            ],
          },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);

    expect(
      await screen.findByText(/Tell me \(a\/b\/c\/d\)/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('plan-approval')).not.toBeInTheDocument();
  });

  it('shows a saved plan inline and opens its path in a file tab', async () => {
    const planPath = '/Users/test/.claude/plans/reconciliation.md';
    const api = installApi({
      plans: {
        [planPath]: '# Reconciliation plan\n\n1. Merge the persistence fix.',
      },
      history: {
        turns: [
          {
            id: 't-saved-plan',
            workspaceId: 'ws1',
            idx: 0,
            status: 'completed',
            sessionId: 'sess-saved-plan',
            mode: 'plan',
            startedAt: 1,
            endedAt: 2,
            inputTokens: null,
            outputTokens: null,
            contextId: 'ctx-ws1-1',
            events: [
              {
                id: 'saved-plan-text',
                turnId: 't-saved-plan',
                kind: 'text',
                ts: 1,
                event: {
                  kind: 'text',
                  delta: `The plan is saved at \`${planPath}\`. Ready for review.`,
                },
              },
            ],
          },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);

    const preview = await screen.findByTestId('plan-preview');
    expect(preview).toHaveTextContent('Reconciliation plan');
    expect(screen.getByTestId('plan-preview')).not.toHaveTextContent(
      'reconciliation.md',
    );
    fireEvent.click(screen.getByRole('button', { name: `Open ${planPath}` }));

    expect(await screen.findByTestId('chat-file-tab')).toHaveTextContent(
      'reconciliation.md',
    );
    expect(api.invoke).toHaveBeenCalledWith('plan:read', { path: planPath });
  });

  it('shows a tool-written plan and hands it to a fresh session', async () => {
    const planPath = '/Users/test/.claude/plans/tool-written.md';
    const plan = '# Tool-written plan\n\n1. Fix plan rendering.';
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (chunk: TurnStreamChunk) => void,
      ) => {
        onChunk({
          kind: 'started',
          turnId: 'fresh-implementation-turn',
          sessionId: 'fresh-session',
          mode: 'default',
        });
        onChunk({ kind: 'event', event: { kind: 'turn_end' } });
        return Promise.resolve();
      },
    );
    installApi({
      plans: { [planPath]: plan },
      stream,
      history: {
        turns: [
          {
            id: 't-tool-written-plan',
            workspaceId: 'ws1',
            idx: 0,
            status: 'completed',
            sessionId: 'old-plan-session',
            mode: 'plan',
            startedAt: 1,
            endedAt: 2,
            inputTokens: null,
            outputTokens: null,
            contextId: 'ctx-ws1-1',
            events: [
              {
                id: 'plan-write',
                turnId: 't-tool-written-plan',
                kind: 'file_edit',
                ts: 1,
                event: { kind: 'file_edit', path: planPath, op: 'create' },
              },
              {
                id: 'plan-ready-text',
                turnId: 't-tool-written-plan',
                kind: 'text',
                ts: 2,
                event: {
                  kind: 'text',
                  delta: 'Plan is ready for your review.',
                },
              },
            ],
          },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);

    expect(await screen.findByTestId('plan-preview')).toHaveTextContent(
      'Tool-written plan',
    );
    fireEvent.click(screen.getByTestId('plan-handoff'));

    await waitFor(() =>
      expect(stream).toHaveBeenCalledWith(
        'turn:start',
        expect.objectContaining({
          workspaceId: 'ws1',
          prompt: expect.stringContaining(plan),
          mode: 'default',
          sessionId: null,
        }),
        expect.any(Function),
        expect.anything(),
      ),
    );
    expect(
      screen.getByRole('tab', { name: /Plan implementation/i }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('turns lettered prose choices into clickable answers', async () => {
    const api = installApi({
      history: {
        turns: [
          {
            id: 't-lettered-options',
            workspaceId: 'ws1',
            idx: 0,
            status: 'completed',
            sessionId: 'sess-lettered-options',
            mode: 'plan',
            startedAt: 1,
            endedAt: 2,
            inputTokens: null,
            outputTokens: null,
            contextId: 'ctx-ws1-1',
            events: [
              {
                id: 'lettered-options',
                turnId: 't-lettered-options',
                kind: 'text',
                ts: 1,
                event: {
                  kind: 'text',
                  delta: [
                    'A couple of questions:',
                    '',
                    '1. **What outcome do you want?**',
                    '2. (a) Just the comparison',
                    '3. (b) A plan to reconcile both into one branch',
                    '4. (c) Pick one approach',
                    '5. (d) Deep-dive a specific gap',
                    '',
                    '1. **Scope check:** Should the email reflect invite-level auto-action?',
                    '',
                    'Tell me (a/b/c/d) and the scope answer.',
                  ].join('\n'),
                },
              },
            ],
          },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);

    const card = await screen.findByTestId('question-card');
    fireEvent.click(
      screen.getByRole('button', { name: /b - A plan to reconcile/i }),
    );
    fireEvent.change(
      screen.getByLabelText(
        'Should the email reflect invite-level auto-action?',
      ),
      { target: { value: 'Yes, include email.' } },
    );
    fireEvent.click(screen.getByTestId('question-submit'));

    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    expect(api.stream.mock.calls[0]?.[1]).toMatchObject({
      prompt: 'Outcome: b\nScope: Yes, include email.',
      sessionId: 'sess-lettered-options',
      mode: 'plan',
    });
    expect(card).toBeInTheDocument();
    expect(screen.queryByTestId('plan-approval')).not.toBeInTheDocument();
  });

  it('hides tool results and turns blocked results into permission UI', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-results',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-1',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: null,
          outputTokens: null,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'result-success',
              turnId: 't-results',
              kind: 'tool_result',
              ts: 1,
              event: {
                kind: 'tool_result',
                output: 'internal command output that should stay hidden',
              },
            },
            {
              id: 'result-blocked',
              turnId: 't-results',
              kind: 'tool_result',
              ts: 2,
              event: {
                kind: 'tool_result',
                output:
                  "cat in '/Users/me/.claude/plans/example.md' was blocked. For security, Claude Code requires approval before reading this file.",
              },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    const permission = await screen.findByTestId('permission-card');
    expect(permission).toHaveTextContent('File access requires approval');
    expect(permission).toHaveTextContent(
      "cat in '/Users/me/.claude/plans/example.md'",
    );
    expect(screen.queryByText('tool result')).not.toBeInTheDocument();
    expect(
      screen.queryByText('internal command output that should stay hidden'),
    ).not.toBeInTheDocument();
  });

  it('collapses earlier model messages and activity while keeping the latest response visible', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-model-activity',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-1',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: null,
          outputTokens: null,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'm1',
              turnId: 't-model-activity',
              kind: 'text',
              ts: 1,
              event: { kind: 'text', delta: 'I will inspect the renderer.' },
            },
            {
              id: 'usage-1',
              turnId: 't-model-activity',
              kind: 'context_usage',
              ts: 1,
              event: {
                kind: 'context_usage',
                usage: { inputTokens: 100, outputTokens: 10 },
              },
            },
            {
              id: 'tool-1',
              turnId: 't-model-activity',
              kind: 'tool_use',
              ts: 2,
              event: {
                kind: 'tool_use',
                name: 'Read',
                input: { path: 'Transcript.tsx' },
              },
            },
            {
              id: 'model-1',
              turnId: 't-model-activity',
              kind: 'model_info',
              ts: 2,
              event: { kind: 'model_info', model: 'claude-sonnet-5' },
            },
            {
              id: 'm2',
              turnId: 't-model-activity',
              kind: 'text',
              ts: 3,
              event: { kind: 'text', delta: 'The renderer is now updated.' },
            },
            {
              id: 'tool-2',
              turnId: 't-model-activity',
              kind: 'tool_use',
              ts: 4,
              event: {
                kind: 'tool_use',
                name: 'Bash',
                input: { command: 'npm test' },
              },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    const activity = await screen.findByTestId('model-activity');
    expect(activity).toHaveTextContent('2 tool calls, 1 message');
    expect(
      screen.queryByText('I will inspect the renderer.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('npm test')).not.toBeInTheDocument();
    expect(
      screen.getByText('The renderer is now updated.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('100')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /2 tool calls, 1 message/i }),
    );
    expect(
      screen.getByText('I will inspect the renderer.'),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('tool-card')).toHaveLength(2);
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('does not add a disclosure around a single model message', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-single-message',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-1',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: null,
          outputTokens: null,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'm1',
              turnId: 't-single-message',
              kind: 'text',
              ts: 1,
              event: { kind: 'text', delta: 'Only one response.' },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    const response = await screen.findByText('Only one response.');
    expect(response).toBeInTheDocument();
    expect(response).toHaveClass('text-md');
    expect(screen.queryByTestId('model-activity')).not.toBeInTheDocument();
  });

  it('opens mentioned files in a compact chat tab', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-file-link',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-1',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: null,
          outputTokens: null,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'm1',
              turnId: 't-file-link',
              kind: 'text',
              ts: 1,
              event: {
                kind: 'text',
                delta: 'Updated `src/renderer/features/chat/ChatPanel.tsx`.',
              },
            },
          ],
        },
      ],
    };
    const api = installApi({
      history,
      files: {
        'src/renderer/features/chat/ChatPanel.tsx':
          'export function ChatPanel() {}',
      },
    });

    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open src/renderer/features/chat/ChatPanel.tsx',
      }),
    );

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('workspace:readFile', {
        workspaceId: 'ws1',
        path: 'src/renderer/features/chat/ChatPanel.tsx',
      }),
    );
    expect(await screen.findByTestId('chat-file-viewer')).toHaveTextContent(
      'export function ChatPanel() {}',
    );
    expect(screen.getByTestId('chat-file-tab')).toHaveTextContent(
      'ChatPanel.tsx',
    );
  });

  it('reveals the displayed workspace file in Finder from its header pill', async () => {
    const path = 'src/renderer/features/chat/ChatPanel.tsx';
    const api = installApi({ files: { [path]: 'export const file = true;' } });
    render(
      <ChatPanel
        workspaceId="ws1"
        inspectFileRequest={{ id: 71, workspaceId: 'ws1', path }}
      />,
    );

    const reveal = await screen.findByRole('button', {
      name: `Reveal ${path} in file manager`,
    });
    fireEvent.click(reveal);

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('file:revealInFinder', {
        source: 'workspace',
        workspaceId: 'ws1',
        path,
      }),
    );
    expect(screen.getByTestId('chat-file-viewer')).toHaveTextContent(
      'export const file = true;',
    );
  });

  it('uses the Git panel comparison when opening a file in diff mode', async () => {
    const path = 'src/pending.ts';
    const api = installApi({
      files: { [path]: 'new value\n' },
      fileDiffs: {
        [path]: {
          path,
          oldContent: 'old value\n',
          newContent: 'new value\n',
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-old value', '+new value'],
            },
          ],
        },
      },
    });

    render(
      <ChatPanel
        workspaceId="ws1"
        inspectFileRequest={{
          id: 74,
          workspaceId: 'ws1',
          path,
          mode: 'diff',
          diffQuery: {
            targetRef: 'origin/main',
            scope: { kind: 'uncommitted' },
          },
        }}
      />,
    );

    await screen.findByTestId('chat-file-viewer');
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('diff:fileQuery', {
        workspaceId: 'ws1',
        targetRef: 'origin/main',
        scope: { kind: 'uncommitted' },
        path,
      }),
    );
    expect(api.invoke).not.toHaveBeenCalledWith('diff:file', {
      workspaceId: 'ws1',
      path,
    });
  });

  it('keeps the preview open and shows a non-blocking Finder error', async () => {
    const path = 'src/deleted.ts';
    installApi({
      files: { [path]: 'cached preview' },
      revealError: new Error('file no longer exists'),
    });
    render(
      <ChatPanel
        workspaceId="ws1"
        inspectFileRequest={{ id: 72, workspaceId: 'ws1', path }}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: `Reveal ${path} in file manager`,
      }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'file no longer exists',
    );
    expect(screen.getByTestId('chat-file-viewer')).toHaveTextContent(
      'cached preview',
    );
  });

  it('routes displayed Claude plans through the confined plan reveal source', async () => {
    const path = '/Users/test/.claude/plans/release.md';
    const api = installApi({ plans: { [path]: '# Release plan' } });
    render(
      <ChatPanel
        workspaceId="ws1"
        inspectFileRequest={{ id: 73, workspaceId: 'ws1', path }}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: `Reveal ${path} in file manager`,
      }),
    );
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('file:revealInFinder', {
        source: 'plan',
        path,
      }),
    );
  });

  it('resolves a summary basename from the full path used earlier in the turn', async () => {
    const fullPath = 'apps/backend/src/app/booking/approvals/Base.spec.ts';
    const history: ChatHistory = {
      turns: [
        {
          id: 't-summary-file-link',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-1',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: null,
          outputTokens: null,
          contextId: 'ctx-ws1-1',
          events: [
            {
              id: 'edit-1',
              turnId: 't-summary-file-link',
              kind: 'file_edit',
              ts: 1,
              event: { kind: 'file_edit', path: fullPath, op: 'modify' },
            },
            {
              id: 'summary-1',
              turnId: 't-summary-file-link',
              kind: 'text',
              ts: 2,
              event: {
                kind: 'text',
                delta: 'Updated `Base.spec.ts` and verified the change.',
              },
            },
          ],
        },
      ],
    };
    const api = installApi({
      history,
      files: { [fullPath]: 'describe("approval", () => {});' },
    });

    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open Base.spec.ts' }),
    );

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('workspace:readFile', {
        workspaceId: 'ws1',
        path: fullPath,
      }),
    );
    expect(await screen.findByTestId('chat-file-viewer')).toHaveTextContent(
      'describe("approval", () => {});',
    );
  });

  it('does not replay an old file request after switching workspaces', async () => {
    const api = installApi({
      files: { 'src/old.ts': 'old workspace file' },
    });
    const request = {
      id: 1,
      workspaceId: 'ws1',
      path: 'src/old.ts',
      mode: 'edit' as const,
    };
    const { rerender } = render(
      <ChatPanel workspaceId="ws1" inspectFileRequest={request} />,
    );

    expect(await screen.findByTestId('chat-file-tab')).toHaveTextContent(
      'old.ts',
    );
    rerender(<ChatPanel workspaceId="ws2" inspectFileRequest={request} />);

    await waitFor(() =>
      expect(screen.queryByTestId('chat-file-tab')).not.toBeInTheDocument(),
    );
    expect(api.invoke).not.toHaveBeenCalledWith('workspace:readFile', {
      workspaceId: 'ws2',
      path: 'src/old.ts',
    });
  });

  it('renders Markdown files as human-readable documents', async () => {
    installApi({
      files: {
        'docs/README.md':
          '# Getting started\n\nThis is **important**.\n\n- First step\n- Second step',
      },
    });
    const request = {
      id: 3,
      workspaceId: 'ws1',
      path: 'docs/README.md',
      mode: 'edit' as const,
    };

    render(<ChatPanel workspaceId="ws1" inspectFileRequest={request} />);

    const document = await screen.findByTestId('chat-markdown-viewer');
    expect(document).toHaveTextContent('Getting started');
    expect(document).toHaveTextContent('This is important.');
    expect(document.querySelector('h1')).toHaveTextContent('Getting started');
    expect(document.querySelectorAll('li')).toHaveLength(2);
  });

  it('lets Markdown previews grow to the full file-viewer width', async () => {
    installApi({ files: { 'reports/review.md': '# Review\n\nWide content' } });

    render(
      <ChatPanel
        workspaceId="ws1"
        inspectFileRequest={{
          id: 4,
          workspaceId: 'ws1',
          path: 'reports/review.md',
          mode: 'edit',
        }}
      />,
    );

    const viewer = await screen.findByTestId('chat-file-viewer');
    const document = screen.getByTestId('chat-markdown-viewer');
    const content = screen.getByTestId('chat-markdown-content');

    expect(viewer).toHaveClass('min-w-0');
    expect(document).toHaveClass('min-w-0');
    expect(content).toHaveClass('w-full', 'min-w-0');
    expect(content).not.toHaveClass('max-w-3xl');
  });

  it('restores the selected chat context after closing a file preview', async () => {
    installApi({ files: { 'src/context.ts': 'export const context = true;' } });
    const { rerender } = render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('chat-new'));
    const selectedContext = await screen.findByTestId('chat-context-tab');
    expect(selectedContext).toHaveAttribute('aria-selected', 'true');

    rerender(
      <ChatPanel
        workspaceId="ws1"
        inspectFileRequest={{
          id: 5,
          workspaceId: 'ws1',
          path: 'src/context.ts',
          mode: 'edit',
        }}
      />,
    );
    await screen.findByTestId('chat-file-viewer');

    fireEvent.click(
      screen.getByRole('button', { name: 'Close src/context.ts' }),
    );

    expect(screen.getByTestId('chat-context-tab')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('chat-tab')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('does not reopen a closed file when returning to its workspace', async () => {
    const api = installApi({
      files: { 'src/closed.ts': 'closed workspace file' },
    });
    const request = {
      id: 2,
      workspaceId: 'ws1',
      path: 'src/closed.ts',
      mode: 'edit' as const,
    };
    const { rerender } = render(
      <ChatPanel workspaceId="ws1" inspectFileRequest={request} />,
    );

    await screen.findByTestId('chat-file-tab');
    fireEvent.click(
      screen.getByRole('button', { name: 'Close src/closed.ts' }),
    );
    expect(screen.queryByTestId('chat-file-tab')).not.toBeInTheDocument();

    rerender(<ChatPanel workspaceId="ws2" inspectFileRequest={request} />);
    rerender(<ChatPanel workspaceId="ws1" inspectFileRequest={request} />);

    await waitFor(() =>
      expect(screen.queryByTestId('chat-file-tab')).not.toBeInTheDocument(),
    );
    expect(
      api.invoke.mock.calls.filter(
        ([channel]) => channel === 'workspace:readFile',
      ),
    ).toHaveLength(1);
  });

  it('uses the plus button to open a new context without clearing the current one', async () => {
    writeModelPreferences({
      ...DEFAULT_MODEL_PREFERENCES,
      defaultModel: 'codex-gpt-5-6-terra',
      defaultEffort: 'medium',
    });
    const api = installApi({});

    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('chat-new'));

    expect(await screen.findByTestId('chat-context-tab')).toHaveTextContent(
      'Untitled',
    );
    expect(screen.getByTestId('chat-context-tab')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(api.invoke).not.toHaveBeenCalledWith('chat:clear', {
      workspaceId: 'ws1',
    });

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'Start a separate task' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() =>
      expect(api.stream).toHaveBeenCalledWith(
        'turn:start',
        expect.objectContaining({
          workspaceId: 'ws1',
          prompt: 'Start a separate task',
          sessionId: null,
          harness: 'codex',
          model: 'codex-gpt-5-6-terra',
        }),
        expect.any(Function),
        expect.objectContaining({ id: expect.any(String) }),
      ),
    );
  });

  it('defaults every new context to regular mode while preserving explicit context-local plan mode', async () => {
    writeModelPreferences({
      ...DEFAULT_MODEL_PREFERENCES,
      planMode: true,
    });
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);

    const initialPlanButton = await screen.findByTestId('composer-plan');
    expect(initialPlanButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(initialPlanButton);
    expect(initialPlanButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('chat-new'));
    expect(await screen.findByTestId('chat-context-tab')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('composer-plan')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(
      within(screen.getByTestId('chat-tab')).getByRole('button', {
        name: 'Untitled',
      }),
    );
    expect(screen.getByTestId('composer-plan')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(
      within(screen.getByTestId('chat-context-tab')).getByRole('button', {
        name: 'Untitled',
      }),
    );
    expect(screen.getByTestId('composer-plan')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('isolates and restores explicit plan mode when switching workspaces', async () => {
    installApi({});
    const { rerender } = render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('composer-plan'));
    expect(screen.getByTestId('composer-plan')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    rerender(<ChatPanel workspaceId="ws2" />);
    await waitFor(() =>
      expect(screen.getByTestId('composer-plan')).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );

    rerender(<ChatPanel workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('composer-plan')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('starts the replacement for a closed final context with plan mode off', async () => {
    installApi({});
    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('composer-plan'));
    expect(screen.getByTestId('composer-plan')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByTestId('chat-context-close-0'));

    await waitFor(() =>
      expect(screen.getByTestId('composer-plan')).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );
  });

  it('clears cached plan mode when switching to a harness without plan support', async () => {
    const stream = vi.fn(() => Promise.resolve());
    const api = installApi({ stream });
    useHarnessStore.setState({
      infoById: {
        claude_code: HARNESS_LIST[0],
        cursor: CURSOR_HARNESS,
      },
      loaded: true,
      loading: false,
    });
    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('composer-plan'));
    expect(screen.getByTestId('composer-plan')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByTestId('composer-model'));
    fireEvent.click(
      await screen.findByTestId('composer-model-option-cursor-default'),
    );
    await waitFor(() => {
      expect(screen.getByTestId('composer-plan')).toBeDisabled();
      expect(screen.getByTestId('composer-plan')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    fireEvent.click(screen.getByTestId('composer-model'));
    fireEvent.click(
      await screen.findByTestId('composer-model-option-claude-opus-5'),
    );
    expect(screen.getByTestId('composer-plan')).not.toBeDisabled();
    expect(screen.getByTestId('composer-plan')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByTestId('composer-model'));
    fireEvent.click(
      await screen.findByTestId('composer-model-option-cursor-default'),
    );
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'Continue without plan mode' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() =>
      expect(api.stream).toHaveBeenCalledWith(
        'turn:start',
        expect.objectContaining({
          harness: 'cursor',
          mode: 'default',
          prompt: 'Continue without plan mode',
        }),
        expect.any(Function),
        expect.anything(),
      ),
    );
  });

  it('closes a chat context and selects a remaining context', async () => {
    installApi({});
    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('chat-new'));
    expect(await screen.findByTestId('chat-context-tab')).toHaveTextContent(
      'Untitled',
    );

    fireEvent.click(screen.getByTestId('chat-context-close-1'));

    await waitFor(() =>
      expect(screen.queryByTestId('chat-context-tab')).toBeNull(),
    );
    expect(screen.getByTestId('chat-tab')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(screen.getByTestId('chat-context-close-0'));

    expect(screen.getByTestId('chat-tab')).toHaveTextContent('Untitled');
    expect(screen.getByTestId('chat-tab')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('button', { name: 'Close Untitled' }),
    ).toBeInTheDocument();
  });

  it('renames a chat context inline', async () => {
    installApi({});
    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Rename Untitled' }),
    );
    const input = screen.getByTestId('chat-context-name-input');
    fireEvent.change(input, { target: { value: 'API cleanup' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // `finishRenameContext` is async (it round-trips `chat:contexts:rename` before
    // adopting the new label locally) — wait for that to settle rather than asserting
    // synchronously right after the keydown.
    await waitFor(() =>
      expect(screen.getByTestId('chat-tab')).toHaveTextContent('API cleanup'),
    );
    expect(
      screen.getByRole('button', { name: 'Rename API cleanup' }),
    ).toBeInTheDocument();
  });
});

/**
 * A tiny fake backend for the two regression tests below: `stream` (the `turn:start`
 * mock) persists each sent turn — tagged with whatever `contextId` the call carried —
 * into an in-memory per-workspace history, and `chat:history` reads it back. This is
 * what makes a simulated remount (rerender with a different, then the original,
 * `workspaceId`) meaningfully exercise the fix: `useChat`'s hydrate effect re-fetches
 * `chat:history` on every workspace change and overwrites the in-store transcript, so
 * unless the "backend" actually remembers each turn's `contextId`, returning to the
 * original tab bar would have nothing to prove was preserved.
 */
function createBackendChatMock(): {
  stream: ApiStub['stream'];
  history: (req: { workspaceId: string }) => ChatHistory;
} {
  const turnsByWorkspace: Record<string, ChatHistory['turns']> = {};
  let seq = 0;

  const stream = vi.fn(
    (
      _channel: string,
      arg: unknown,
      onChunk: (chunk: TurnStreamChunk) => void,
    ) => {
      const { workspaceId, prompt, contextId } = arg as {
        workspaceId: string;
        prompt: string;
        contextId?: string;
      };
      const turnId = `turn-${seq++}`;
      const replyText = `Reply to ${prompt}`;
      onChunk({
        kind: 'started',
        turnId,
        sessionId: `sess-${turnId}`,
        mode: 'default',
      });
      onChunk({ kind: 'event', event: { kind: 'text', delta: replyText } });
      onChunk({ kind: 'event', event: { kind: 'turn_end', usage: {} } });

      const list = (turnsByWorkspace[workspaceId] ??= []);
      list.push({
        id: turnId,
        workspaceId,
        idx: list.length,
        status: 'completed',
        sessionId: `sess-${turnId}`,
        mode: 'default',
        startedAt: 0,
        endedAt: 1,
        inputTokens: null,
        outputTokens: null,
        contextId,
        events: [
          {
            id: `${turnId}-u`,
            turnId,
            kind: 'user_message',
            ts: 0,
            event: { kind: 'user_message', text: prompt },
          },
          {
            id: `${turnId}-t`,
            turnId,
            kind: 'text',
            ts: 1,
            event: { kind: 'text', delta: replyText },
          },
        ],
      });
      return Promise.resolve();
    },
  );

  return {
    stream,
    history: (req) => ({ turns: turnsByWorkspace[req.workspaceId] ?? [] }),
  };
}

describe('ChatPanel manual tab persistence (regression)', () => {
  it('keeps two manual tabs and their distinct turn histories un-merged across a workspace switch and back', async () => {
    const backend = createBackendChatMock();
    const api = installApi({
      stream: backend.stream,
      history: backend.history,
    });

    const { rerender } = render(<ChatPanel workspaceId="ws1" />);

    // Send in the default tab.
    fireEvent.change(await screen.findByTestId('composer-input'), {
      target: { value: 'First tab message' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(
      await screen.findByText('Reply to First tab message'),
    ).toBeInTheDocument();

    // Open a second tab and send a different message in it.
    fireEvent.click(await screen.findByTestId('chat-new'));
    await screen.findByTestId('chat-context-tab');
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'Second tab message' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(
      await screen.findByText('Reply to Second tab message'),
    ).toBeInTheDocument();

    // The two sends must have been filed under two DIFFERENT persisted contexts — the
    // actual mechanism the fix relies on.
    const startCalls = api.stream.mock.calls;
    expect(startCalls).toHaveLength(2);
    const contextIds = startCalls.map(
      ([, arg]) => (arg as { contextId?: string }).contextId,
    );
    expect(contextIds[0]).toBeTruthy();
    expect(contextIds[1]).toBeTruthy();
    expect(contextIds[0]).not.toBe(contextIds[1]);

    // Simulate switching away and back to the SAME workspace (the reported bug: this
    // used to reset the tab bar to a single default tab and dump every turn into it).
    rerender(<ChatPanel workspaceId="ws2" />);
    rerender(<ChatPanel workspaceId="ws1" />);

    // Both tabs must still exist.
    const tab1 = await screen.findByTestId('chat-tab');
    const tab2 = await screen.findByTestId('chat-context-tab');

    // Returning to a workspace restores the last selected context, not the first tab.
    expect(tab2).toHaveAttribute('aria-selected', 'true');
    expect(tab1).toHaveAttribute('aria-selected', 'false');

    // Tab 1's history is intact and NOT merged with tab 2's.
    fireEvent.click(within(tab1).getByRole('button', { name: 'Untitled' }));
    expect(
      await screen.findByText('Reply to First tab message'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Reply to Second tab message'),
    ).not.toBeInTheDocument();

    // Tab 2's history is intact and NOT merged with tab 1's.
    fireEvent.click(within(tab2).getByRole('button', { name: 'Untitled' }));
    expect(
      await screen.findByText('Reply to Second tab message'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Reply to First tab message'),
    ).not.toBeInTheDocument();
  });

  it('closing one tab removes only that tab from the bar and only its turns from history', async () => {
    const backend = createBackendChatMock();
    installApi({ stream: backend.stream, history: backend.history });

    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.change(await screen.findByTestId('composer-input'), {
      target: { value: 'First tab message' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(
      await screen.findByText('Reply to First tab message'),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('chat-new'));
    await screen.findByTestId('chat-context-tab');
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'Second tab message' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(
      await screen.findByText('Reply to Second tab message'),
    ).toBeInTheDocument();

    // Close the second tab.
    fireEvent.click(screen.getByTestId('chat-context-close-1'));
    await waitFor(() =>
      expect(screen.queryByTestId('chat-context-tab')).toBeNull(),
    );

    // The remaining (first) tab is selected and shows only its own history.
    expect(screen.getByTestId('chat-tab')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      await screen.findByText('Reply to First tab message'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Reply to Second tab message'),
    ).not.toBeInTheDocument();

    // Closing the last remaining tab replaces it with a fresh, empty 'Untitled' tab —
    // no leftover messages from either closed tab.
    fireEvent.click(screen.getByTestId('chat-context-close-0'));
    await waitFor(() =>
      expect(screen.getByTestId('chat-tab')).toHaveTextContent('Untitled'),
    );
    expect(
      screen.queryByText('Reply to First tab message'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Reply to Second tab message'),
    ).not.toBeInTheDocument();
  });

  it('disables the composer instead of sending an unowned, permanently-invisible turn when bootstrapping tabs fails', async () => {
    const api = installApi({});
    const original = api.invoke.getMockImplementation();
    if (!original)
      throw new Error('installApi must provide a default invoke impl');
    api.invoke.mockImplementation((channel: string, req?: unknown) =>
      channel === 'chat:contexts:list'
        ? Promise.reject(new Error('list failed'))
        : original(channel, req),
    );

    render(<ChatPanel workspaceId="ws1" />);

    // No tab ever loads, so there is no `contextId` a sent turn could be filed under —
    // sending here would persist a turn with `context_id = NULL`, which (per migration
    // 0016's invariant) is indistinguishable from "its tab was explicitly closed" and so
    // would never be shown in any tab again. The composer must refuse to send instead.
    const input = await screen.findByTestId('composer-input');
    expect(input).toBeDisabled();
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    expect(api.stream).not.toHaveBeenCalled();
  });
});

describe('ChatPanel streaming', () => {
  it('navigates all sent text with ArrowUp and ArrowDown', async () => {
    installApi({});
    render(<ChatPanel workspaceId="ws1" />);

    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'First request' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(useChatStore.getState().busyByWorkspace['ws1']).toBe(false),
    );
    fireEvent.change(input, { target: { value: 'Second request' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('Second request');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('First request');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('First request');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveValue('Second request');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveValue('');
  });

  it('updates estimated context usage while the model is still streaming', async () => {
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: TurnStreamChunk) => void,
      ) => {
        onChunk({
          kind: 'started',
          turnId: 't-live-usage',
          sessionId: 'sess-live-usage',
          mode: 'default',
        });
        onChunk({
          kind: 'event',
          event: {
            kind: 'text',
            delta: 'This response is arriving incrementally from the model.',
          },
        });
        return Promise.resolve();
      },
    );
    installApi({ stream });
    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.change(await screen.findByTestId('composer-input'), {
      target: { value: 'Explain this code' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() =>
      expect(screen.getByTestId('composer-context')).toHaveTextContent(
        /^[1-9]\d*$/,
      ),
    );
    fireEvent.click(screen.getByTestId('composer-context'));
    expect(
      screen.getByTestId('composer-context-popover'),
    ).not.toHaveTextContent('0/1.0M');
  });

  it('streams a turn: started + text + turn_end render, then completes', async () => {
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
        onChunk({
          kind: 'event',
          event: { kind: 'text', delta: 'Streaming ' },
        });
        onChunk({ kind: 'event', event: { kind: 'text', delta: 'reply' } });
        onChunk({ kind: 'event', event: { kind: 'turn_end', usage: {} } });
        return Promise.resolve();
      },
    );
    installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);

    // Wait for hydration (harness:list + empty history) to settle, then send.
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'hi there' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    expect(await screen.findByTestId('chat-user-message')).toHaveTextContent(
      'hi there',
    );
    expect(await screen.findByText('Streaming reply')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('turn-divider')).toHaveAttribute(
        'data-status',
        'completed',
      ),
    );
  });

  it('shows Stop while busy and interrupts via turn:interrupt', async () => {
    // A stream that emits `started` then never resolves → stays busy.
    let capturedResolve: (() => void) | undefined;
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: TurnStreamChunk) => void,
      ) => {
        onChunk({
          kind: 'started',
          turnId: 't1',
          sessionId: 's',
          mode: 'default',
        });
        onChunk({
          kind: 'event',
          event: { kind: 'text', delta: 'thinking…' },
        });
        return new Promise<void>((resolve) => {
          capturedResolve = resolve;
        });
      },
    );
    const api = installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'work' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    // Busy → Stop button shows; clicking it invokes turn:interrupt.
    const stop = await screen.findByTestId('composer-interrupt');
    expect(await screen.findByTestId('turn-elapsed')).toHaveTextContent(
      /\d+\.\ds/,
    );
    expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    fireEvent.click(stop);
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('turn:interrupt', {
        workspaceId: 'ws1',
      }),
    );

    // Clean up the pending stream promise.
    await act(async () => {
      capturedResolve?.();
    });
  });

  it('renders live model activity before the final answer', async () => {
    let capturedResolve: (() => void) | undefined;
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: TurnStreamChunk) => void,
      ) => {
        onChunk({
          kind: 'started',
          turnId: 't1',
          sessionId: 's',
          mode: 'default',
        });
        onChunk({
          kind: 'event',
          event: { kind: 'activity', title: 'Thinking' },
        });
        return new Promise<void>((resolve) => {
          capturedResolve = resolve;
        });
      },
    );
    installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'work' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    expect(await screen.findByTestId('activity-chip')).toHaveTextContent(
      'Thinking',
    );

    await act(async () => {
      capturedResolve?.();
    });
  });

  it('shows a pre-start stream error instead of dropping it', async () => {
    const stream = vi.fn(() =>
      Promise.reject(new Error('claude not available')),
    );
    installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'work' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    expect(await screen.findByText('claude not available')).toBeInTheDocument();
    expect(screen.getByTestId('turn-divider')).toHaveAttribute(
      'data-status',
      'error',
    );
  });

  it('shows configured skills when typing slash and inserts the selected command', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/' } });

    expect(await screen.findByTestId('slash-menu')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('slash-command-review'));

    expect(input).toHaveValue('/review ');
  });

  it('opens workspace files for @ and filters the active mention query', async () => {
    const api = installApi({
      directories: {
        '': [
          { name: 'src', path: 'src', kind: 'directory' },
          { name: 'package.json', path: 'package.json', kind: 'file' },
          { name: 'README.md', path: 'README.md', kind: 'file' },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'Look at @' } });

    expect(await screen.findByTestId('file-mention-menu')).toBeInTheDocument();
    expect(api.invoke).toHaveBeenCalledWith('workspace:listDirectory', {
      workspaceId: 'ws1',
      path: '',
    });
    expect(screen.getByTestId('file-mention-option-src')).toBeInTheDocument();
    expect(
      screen.getByTestId('file-mention-option-package.json'),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Look at @pack' } });

    expect(
      await screen.findByTestId('file-mention-option-package.json'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('file-mention-option-src'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('file-mention-option-README.md'),
    ).not.toBeInTheDocument();
  });

  it('uses arrow keys to choose a file and inserts its relative path', async () => {
    installApi({
      directories: {
        '': [
          { name: 'alpha.ts', path: 'alpha.ts', kind: 'file' },
          { name: 'beta.ts', path: 'beta.ts', kind: 'file' },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '@' } });
    await screen.findByTestId('file-mention-option-alpha.ts');

    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(input).toHaveValue('@beta.ts ');
    expect(screen.queryByTestId('file-mention-menu')).not.toBeInTheDocument();
  });

  it('continues browsing after selecting a directory and inserts a nested file', async () => {
    const api = installApi({
      directories: {
        '': [{ name: 'src', path: 'src', kind: 'directory' }],
        src: [
          { name: 'components', path: 'src/components', kind: 'directory' },
          { name: 'index.ts', path: 'src/index.ts', kind: 'file' },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'Review @' } });
    fireEvent.click(await screen.findByTestId('file-mention-option-src'));

    expect(input).toHaveValue('Review @src/');
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('workspace:listDirectory', {
        workspaceId: 'ws1',
        path: 'src',
      }),
    );
    fireEvent.click(
      await screen.findByTestId('file-mention-option-src/index.ts'),
    );

    expect(input).toHaveValue('Review @src/index.ts ');
    expect(screen.queryByTestId('file-mention-menu')).not.toBeInTheDocument();
  });

  it('dismisses @ suggestions with Escape without clearing the draft', async () => {
    installApi({
      directories: {
        '': [{ name: 'src', path: 'src', kind: 'directory' }],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'Keep this draft @' } });
    await screen.findByTestId('file-mention-menu');

    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });

    expect(input).toHaveValue('Keep this draft @');
    await waitFor(() =>
      expect(screen.queryByTestId('file-mention-menu')).not.toBeInTheDocument(),
    );
  });

  it('submits normally with Enter when the @ query has no matching file', async () => {
    const api = installApi({
      directories: {
        '': [{ name: 'available.ts', path: 'available.ts', kind: 'file' }],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'Ship @missing' } });
    expect(await screen.findByText('No matching files')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() =>
      expect(api.stream).toHaveBeenCalledWith(
        'turn:start',
        expect.objectContaining({
          workspaceId: 'ws1',
          prompt: 'Ship @missing',
        }),
        expect.any(Function),
        expect.anything(),
      ),
    );
  });

  it('does not select stale root entries while a nested directory is loading', async () => {
    let resolveNested: (entries: WorkspaceDirectoryEntry[]) => void = () =>
      undefined;
    const nestedDirectory = new Promise<WorkspaceDirectoryEntry[]>(
      (resolve) => {
        resolveNested = resolve;
      },
    );
    const api = installApi({
      directories: {
        '': [
          { name: 'src', path: 'src', kind: 'directory' },
          { name: 'root.ts', path: 'root.ts', kind: 'file' },
        ],
      },
    });
    const invoke = api.invoke.getMockImplementation();
    if (!invoke)
      throw new Error('installApi must provide an invoke implementation');
    api.invoke.mockImplementation((channel: string, req?: unknown) => {
      if (
        channel === 'workspace:listDirectory' &&
        (req as { path?: string } | undefined)?.path === 'src'
      ) {
        return nestedDirectory;
      }
      return invoke(channel, req);
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.click(await screen.findByTestId('file-mention-option-src'));
    expect(input).toHaveValue('@src/');
    expect(await screen.findByText('Loading files...')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(input).toHaveValue('@src/');
    expect(api.stream).not.toHaveBeenCalled();

    await act(async () => {
      resolveNested([{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }]);
    });
    expect(
      await screen.findByTestId('file-mention-option-src/index.ts'),
    ).toBeInTheDocument();
  });

  it('browses and inserts directory and file names containing spaces', async () => {
    const api = installApi({
      directories: {
        '': [{ name: 'my folder', path: 'my folder', kind: 'directory' }],
        'my folder': [
          {
            name: 'notes file.md',
            path: 'my folder/notes file.md',
            kind: 'file',
          },
        ],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.click(await screen.findByTestId('file-mention-option-my folder'));

    expect(input).toHaveValue('@my\\ folder/');
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('workspace:listDirectory', {
        workspaceId: 'ws1',
        path: 'my folder',
      }),
    );
    fireEvent.click(
      await screen.findByTestId('file-mention-option-my folder/notes file.md'),
    );

    expect(input).toHaveValue('@my\\ folder/notes\\ file.md ');
  });

  it('does not treat an embedded email address as a file mention', async () => {
    const api = installApi({
      directories: {
        '': [{ name: 'example.com', path: 'example.com', kind: 'file' }],
      },
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'Email dev@example.com' } });

    expect(screen.queryByTestId('file-mention-menu')).not.toBeInTheDocument();
    expect(api.invoke).not.toHaveBeenCalledWith(
      'workspace:listDirectory',
      expect.anything(),
    );
  });

  it('clears chat from /clear without starting a model turn', async () => {
    const api = installApi({
      slashCommands: [
        {
          name: 'clear',
          template: 'Clear the current chat transcript and context.',
          description: 'Clear chat history and context',
        },
      ],
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/clear' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: false });

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('chat:clear', {
        workspaceId: 'ws1',
      }),
    );
    expect(api.stream).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it('shows /clear as an app command even when no native skill is present', async () => {
    installApi({
      slashCommands: [
        {
          name: 'clear',
          template: 'Clear the current chat transcript and context.',
          description: 'Clear chat history and context',
        },
      ],
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/cl' } });

    expect(await screen.findByTestId('slash-menu')).not.toHaveTextContent(
      'Available commands',
    );
    expect(await screen.findByTestId('slash-command-clear')).toHaveTextContent(
      'Clear chat history and context',
    );
  });

  it('shows the provider model catalogue instead of harness names', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);
    fireEvent.click(await screen.findByTestId('composer-model'));

    expect(
      await screen.findByTestId('composer-model-claude_code'),
    ).toHaveTextContent('Claude Code');
    expect(
      screen.getByTestId('composer-model-option-claude-fable-5'),
    ).toHaveTextContent('Fable 5');
    expect(
      screen.getByTestId('composer-model-option-claude-opus-4-8-1m'),
    ).toHaveTextContent('Opus 4.8 1M');
    expect(
      screen.getByTestId('composer-model-option-claude-opus-5'),
    ).toHaveTextContent('New');
    expect(
      screen.queryByTestId('composer-model-opencode'),
    ).not.toBeInTheDocument();
  });

  it('sends the exact Claude version selected in the catalogue', async () => {
    const api = installApi({});

    render(<ChatPanel workspaceId="ws1" />);
    fireEvent.click(await screen.findByTestId('composer-model'));
    fireEvent.click(
      await screen.findByTestId('composer-model-option-claude-opus-4-8-1m'),
    );
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'Which model are you using?' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() =>
      expect(api.stream).toHaveBeenCalledWith(
        'turn:start',
        expect.objectContaining({
          workspaceId: 'ws1',
          harness: 'claude_code',
          model: 'claude-opus-4-8[1m]',
        }),
        expect.any(Function),
        expect.anything(),
      ),
    );
  });

  it('keeps the selected model across contexts, workspaces, and prompt submission', async () => {
    const api = installApi({});
    const { rerender } = render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('composer-model'));
    fireEvent.click(
      await screen.findByTestId('composer-model-option-claude-fable-5'),
    );
    expect(screen.getByTestId('composer-model')).toHaveTextContent('Fable 5');

    fireEvent.click(screen.getByTestId('chat-new'));
    expect(await screen.findByTestId('composer-model')).toHaveTextContent(
      'Fable 5',
    );

    rerender(<ChatPanel workspaceId="ws2" />);
    expect(await screen.findByTestId('composer-model')).toHaveTextContent(
      'Fable 5',
    );

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'Keep using my selected model' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() =>
      expect(api.stream).toHaveBeenCalledWith(
        'turn:start',
        expect.objectContaining({
          workspaceId: 'ws2',
          harness: 'claude_code',
          model: 'claude-fable-5',
        }),
        expect.any(Function),
        expect.anything(),
      ),
    );
    expect(screen.getByTestId('composer-model')).toHaveTextContent('Fable 5');
  });

  it('shows OpenCode models only after OpenCode has been configured', async () => {
    window.localStorage.setItem('harness:opencode-configured', 'true');
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);
    fireEvent.click(await screen.findByTestId('composer-model'));

    expect(
      await screen.findByTestId('composer-model-opencode'),
    ).toHaveTextContent('OpenCode');
  });

  it('closes the model catalogue when pressing outside it', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);
    fireEvent.click(await screen.findByTestId('composer-model'));
    expect(
      await screen.findByTestId('composer-model-menu'),
    ).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByTestId('composer-model-menu')).toBeNull(),
    );
  });

  it('closes the context, effort, and plus menus when pressing outside them', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('composer-context'));
    expect(
      await screen.findByTestId('composer-context-popover'),
    ).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByTestId('composer-context-popover')).toBeNull(),
    );

    fireEvent.click(screen.getByTestId('composer-effort'));
    expect(
      await screen.findByTestId('composer-effort-menu'),
    ).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByTestId('composer-effort-menu')).toBeNull(),
    );

    fireEvent.click(screen.getByTestId('composer-plus'));
    expect(await screen.findByTestId('composer-plus-menu')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByTestId('composer-plus-menu')).toBeNull(),
    );
  });

  it('opens the plus menu and attaches a file from the picker', async () => {
    const api = installApi({});

    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('composer-plus'));
    fireEvent.click(await screen.findByTestId('composer-plus-attachment'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('workspace:pickFile', undefined),
    );
    expect(await screen.findByTestId('attachment-bar')).toHaveTextContent(
      'app.ts',
    );
    expect(screen.queryByTestId('composer-plus-menu')).toBeNull();
  });

  it('classifies a picked raster image and shows it in the live user turn', async () => {
    const dataUrl = 'data:image/png;base64,cHJldmlldw==';
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (chunk: TurnStreamChunk) => void,
      ) => {
        onChunk({
          kind: 'started',
          turnId: 'turn-live',
          sessionId: 'session',
          mode: 'default',
        });
        return Promise.resolve();
      },
    );
    const api = installApi({
      pickedFile: '/tmp/ws/screenshot.PNG',
      imagePreviews: { 'turn-live:0': dataUrl },
      stream,
    });

    render(<ChatPanel workspaceId="ws1" />);
    fireEvent.click(await screen.findByTestId('composer-plus'));
    fireEvent.click(await screen.findByTestId('composer-plus-attachment'));
    expect(await screen.findByTestId('attachment-bar')).toHaveTextContent(
      'screenshot.PNG',
    );
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'Look at this' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() =>
      expect(api.stream).toHaveBeenCalledWith(
        'turn:start',
        expect.objectContaining({
          attachments: [{ type: 'image', path: '/tmp/ws/screenshot.PNG' }],
        }),
        expect.any(Function),
        expect.anything(),
      ),
    );
    expect(
      await screen.findByRole('img', { name: 'screenshot.PNG' }),
    ).toHaveAttribute('src', dataUrl);
  });

  it('provides tooltip labels on composer controls', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);

    expect(await screen.findByTestId('composer-model')).toHaveAttribute(
      'title',
      'Select model',
    );
    expect(screen.getByTestId('composer-plan')).toHaveAttribute(
      'title',
      'Plan mode',
    );
    expect(screen.getByTestId('composer-send')).toHaveAttribute(
      'title',
      'Send',
    );
    for (const testId of [
      'composer-model',
      'composer-effort',
      'composer-plan',
      'composer-plus',
      'composer-send',
    ]) {
      expect(screen.getByTestId(testId).parentElement).toHaveAttribute(
        'data-state',
        'closed',
      );
    }
    expect(
      screen.getByTestId('composer-context').parentElement,
    ).not.toHaveAttribute('data-state');
    expect(
      screen.getByTestId('composer-cost').parentElement,
    ).not.toHaveAttribute('data-state');
    expect(screen.getByTestId('composer-context')).not.toHaveAttribute('title');
  });

  it('keeps Send visible by collapsing secondary actions into a width-aware menu', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);

    const composer = await screen.findByTestId('composer');
    const prompt = composer.querySelector('.composer-responsive');
    expect(prompt).toBeInTheDocument();
    expect(screen.getByTestId('composer-cost-inline')).toHaveClass(
      'composer-wide-only',
    );
    expect(screen.getByTestId('composer-context-inline')).toHaveClass(
      'composer-wide-only',
    );
    expect(screen.getByTestId('composer-more-icon')).toHaveClass(
      'composer-narrow-only',
    );
    expect(screen.getByTestId('composer-send')).toHaveClass('shrink-0');

    fireEvent.click(screen.getByTestId('composer-plus'));

    expect(await screen.findByTestId('composer-plus-menu')).toContainElement(
      screen.getByTestId('composer-overflow-cost'),
    );
    expect(screen.getByTestId('composer-overflow-cost')).toHaveTextContent(
      'Estimated API cost',
    );
    expect(screen.getByTestId('composer-overflow-context')).toHaveTextContent(
      'Context',
    );
    expect(screen.getByTestId('composer-plus-attachment')).toBeInTheDocument();
  });

  it('expands slash commands with args before starting a turn', async () => {
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        _onChunk: (c: TurnStreamChunk) => void,
      ) => Promise.resolve(),
    );
    const api = installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'slash:list',
        expect.objectContaining({ workspaceId: 'ws1' }),
      ),
    );
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/fix-checks rerun CI' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(stream.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        prompt: 'Fix checks\n\nrerun CI',
        displayPrompt: '/fix-checks rerun CI',
      }),
    );
    expect(screen.getByText('/fix-checks rerun CI')).toBeInTheDocument();
    expect(screen.queryByText('Fix checks')).not.toBeInTheDocument();
  });

  it('sends native skill slash invocations directly to the model', async () => {
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        _onChunk: (c: TurnStreamChunk) => void,
      ) => Promise.resolve(),
    );
    const api = installApi({
      stream,
      slashCommands: [
        {
          name: 'harness-plan',
          template: '$harness-plan $ARGS',
          description: 'Create an implementation plan',
          source: 'native_skill',
          provider: 'codex',
          provenance: 'workspace',
          invocation: 'dollar',
        },
      ],
    });

    render(<ChatPanel workspaceId="ws1" />);
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'slash:list',
        expect.objectContaining({ workspaceId: 'ws1' }),
      ),
    );
    fireEvent.change(await screen.findByTestId('composer-input'), {
      target: { value: '/harness-plan W2BT-1234' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(stream.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        prompt: '$harness-plan W2BT-1234',
        displayPrompt: '/harness-plan W2BT-1234',
      }),
    );
  });

  it('shows colliding prompt and skill provenance and preserves the selected Codex skill', async () => {
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        _onChunk: (c: TurnStreamChunk) => void,
      ) => Promise.resolve(),
    );
    const api = installApi({
      stream,
      slashCommands: [
        {
          name: 'deploy',
          template: 'Run configured deployment.\n\n$ARGS',
          description: 'Deploy from settings',
          source: 'configured_prompt',
          provenance: 'app',
          invocation: 'slash',
        },
        {
          name: 'deploy',
          template: '$deploy $ARGS',
          description: 'Provider deployment workflow',
          source: 'native_skill',
          provider: 'codex',
          provenance: 'workspace',
          invocation: 'dollar',
        },
      ],
    });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/deploy' } });

    const choices = await screen.findAllByTestId('slash-command-deploy');
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveTextContent('configured prompt');
    expect(choices[1]).toHaveTextContent('Codex · skill · workspace');
    expect(choices[1]).toHaveTextContent('$deploy');
    fireEvent.click(choices[1]);
    expect(input).toHaveValue('$deploy ');

    fireEvent.change(input, { target: { value: '$deploy staging' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(stream.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        prompt: '$deploy staging',
        displayPrompt: '$deploy staging',
      }),
    );
    expect(
      api.invoke.mock.calls.filter(([channel]) => channel === 'slash:list')
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('refreshes the native command catalogue whenever autocomplete reopens', async () => {
    let commands: SlashCommand[] = [
      {
        name: 'review',
        template: 'Review.',
        source: 'builtin',
        provenance: 'app',
      },
    ];
    installApi({ slashCommands: () => commands });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/' } });
    expect(
      await screen.findByTestId('slash-command-review'),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'draft' } });
    commands = [
      ...commands,
      {
        name: 'new-skill',
        template: '$new-skill $ARGS',
        description: 'Added while the composer remained mounted',
        source: 'native_skill',
        provider: 'codex',
        provenance: 'workspace',
        invocation: 'dollar',
      },
    ];
    fireEvent.change(input, { target: { value: '/new' } });

    expect(
      await screen.findByTestId('slash-command-new-skill'),
    ).toHaveTextContent('Added while the composer remained mounted');
  });
});
