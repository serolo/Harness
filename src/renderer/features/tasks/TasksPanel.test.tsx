// TasksPanel test (Phase 12). Runs under jsdom with a stubbed `window.api` (the only main
// access point), mirroring ChecksPanel.test.tsx so the real `@renderer/ipc` funnel + real
// components run.
//
// Covers: the list renders a state badge per task; a `missed` row shows Reschedule + Run
// now; the create form submits `task:create` with the chosen model; and a `task:changed`
// event triggers a refetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { TasksPanel } from './TasksPanel';
import { useTasksStore } from '@renderer/stores/tasks';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import type { ScheduledTask } from '@shared/tasks';
import type { Project, Workspace } from '@shared/models';
import type {
  KnowledgeConfig,
  WikiHistoryEntry,
  WikiPageSummary,
  WikiProposal,
  WikiSearchResult,
} from '@shared/knowledge';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

function makeTask(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    workspaceId: 'ws1',
    prompt: 'do the thing',
    model: null,
    mode: null,
    scheduledAt: null,
    state: 'pending',
    origin: 'user',
    turnId: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    harnessOverride: null,
    ...over,
  };
}

const TASKS: ScheduledTask[] = [
  makeTask({ id: 'a', state: 'scheduled', scheduledAt: Date.now() + 60_000 }),
  makeTask({ id: 'b', state: 'missed', prompt: 'was missed' }),
];

interface Installed {
  api: ApiStub;
  listeners: Record<string, ((payload: unknown) => void)[]>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function installApi(
  tasks: ScheduledTask[],
  knowledge?: {
    config: KnowledgeConfig;
    pages: WikiPageSummary[];
    history?: WikiHistoryEntry[];
    proposals?: WikiProposal[];
    searchResults?: WikiSearchResult[];
  },
): Installed {
  const listeners: Record<string, ((payload: unknown) => void)[]> = {};
  const unsubscribe = vi.fn();

  const invoke = vi.fn((channel: string) => {
    switch (channel) {
      case 'task:list':
        return Promise.resolve(tasks);
      case 'settings:getEffective':
        return Promise.resolve({ agent: { mode: 'default' } });
      case 'slash:list':
        return Promise.resolve([
          {
            name: 'harness-plan',
            template: '/harness-plan $ARGS',
            description: 'Create an implementation plan',
          },
        ]);
      case 'knowledge:config':
        return Promise.resolve(knowledge?.config);
      case 'knowledge:initialize':
        return Promise.resolve({ commit: 'abc' });
      case 'knowledge:listPages':
        return Promise.resolve(knowledge?.pages ?? []);
      case 'knowledge:search':
        return Promise.resolve(knowledge?.searchResults ?? []);
      case 'knowledge:history':
        return Promise.resolve(knowledge?.history ?? []);
      case 'knowledge:listProposals':
        return Promise.resolve(knowledge?.proposals ?? []);
      case 'knowledge:acceptProposal':
        return Promise.resolve(
          knowledge?.proposals?.[0]
            ? { ...knowledge.proposals[0], status: 'accepted' }
            : undefined,
        );
      case 'knowledge:rejectProposal':
        return Promise.resolve(
          knowledge?.proposals?.[0]
            ? { ...knowledge.proposals[0], status: 'rejected' }
            : undefined,
        );
      case 'task:create':
      case 'task:update':
        return Promise.resolve(makeTask({}));
      case 'task:runNow':
      case 'task:markDone':
        return Promise.resolve(makeTask({}));
      case 'task:delete':
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });

  const api: ApiStub = {
    invoke,
    on: vi.fn((event: string, cb: (payload: unknown) => void) => {
      (listeners[event] ??= []).push(cb);
      return unsubscribe;
    }),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return { api, listeners, unsubscribe };
}

beforeEach(() => {
  window.localStorage.removeItem('harness:model-preferences');
  useTasksStore.setState({ tasksByWorkspace: {} });
  useWorkspacesStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'Harness',
        originUrl: '',
        defaultBranch: 'main',
        repoPath: '/repo',
        createdAt: 1,
      } satisfies Project,
      {
        id: 'project-2',
        name: 'Companion',
        originUrl: '',
        defaultBranch: 'main',
        repoPath: '/companion',
        createdAt: 2,
      } satisfies Project,
    ],
    workspaces: [
      {
        id: 'ws1',
        projectId: 'project-1',
        name: 'current',
        branch: 'current',
        baseBranch: 'main',
        worktreePath: '/repo/current',
        status: 'idle',
        sourceKind: null,
        sourceRef: null,
        harness: 'claude_code',
        port: null,
        createdAt: 1,
        archivedAt: null,
        prNumber: null,
      } satisfies Workspace,
      {
        id: 'ws2',
        projectId: 'project-1',
        name: 'target',
        branch: 'target',
        baseBranch: 'main',
        worktreePath: '/repo/target',
        status: 'idle',
        sourceKind: null,
        sourceRef: null,
        harness: 'claude_code',
        port: null,
        createdAt: 2,
        archivedAt: null,
        prNumber: null,
      } satisfies Workspace,
      {
        id: 'ws3',
        projectId: 'project-2',
        name: 'remote',
        branch: 'remote',
        baseBranch: 'main',
        worktreePath: '/companion/remote',
        status: 'idle',
        sourceKind: null,
        sourceRef: null,
        harness: 'codex',
        port: null,
        createdAt: 3,
        archivedAt: null,
        prNumber: null,
      } satisfies Workspace,
      {
        id: 'archived',
        projectId: 'project-2',
        name: 'old',
        branch: 'old',
        baseBranch: 'main',
        worktreePath: null,
        status: 'archived',
        sourceKind: null,
        sourceRef: null,
        harness: 'codex',
        port: null,
        createdAt: 4,
        archivedAt: 5,
        prNumber: null,
      } satisfies Workspace,
    ],
    selectedWorkspaceId: 'ws1',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('TasksPanel rendering', () => {
  it('renders a state badge per task', async () => {
    installApi(TASKS);
    render(<TasksPanel workspaceId="ws1" />);

    expect(
      await screen.findByTestId('task-state-scheduled'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tools-header')).toHaveAttribute(
      'data-ui',
      'panel-tab-bar',
    );
    expect(screen.getByTestId('task-state-missed')).toBeInTheDocument();
  });

  it('shows Reschedule + Run now on a missed task', async () => {
    installApi(TASKS);
    render(<TasksPanel workspaceId="ws1" />);

    expect(await screen.findByTestId('task-reschedule-b')).toBeInTheDocument();
    expect(screen.getByTestId('task-run-b')).toBeInTheDocument();
  });

  it('checks whether project knowledge is available in a neighboring tab', async () => {
    const { api } = installApi(TASKS, {
      config: {
        enabled: true,
        storage: 'local',
        proposalMode: 'review_required',
        injectContext: true,
        extractAfterTurn: true,
        search: {
          enabled: true,
          provider: 'basic',
          maxResults: 12,
          rerank: true,
        },
        format: { name: 'okf', version: '0.1' },
      },
      pages: [
        {
          id: 'overview',
          path: 'overview.md',
          title: 'Project overview',
          type: 'Project Overview',
          status: 'canonical',
          tags: [],
        },
      ],
      history: [
        {
          commit: 'abcdef1234567890',
          subject: 'Update project overview',
          author: 'Harness Knowledge',
          timestamp: Date.UTC(2026, 6, 28, 12, 0),
        },
      ],
    });
    render(<TasksPanel workspaceId="ws1" projectId="project-1" />);

    fireEvent.click(screen.getByTestId('workspace-tab-knowledge'));

    expect(
      await screen.findByTestId('workspace-knowledge-available'),
    ).toHaveTextContent('Available · OKF 0.1 · 1 pages');
    expect(screen.getByText('Project overview')).toBeInTheDocument();
    expect(api.invoke).toHaveBeenCalledWith('knowledge:config', {
      projectId: 'project-1',
    });

    fireEvent.click(screen.getByTestId('knowledge-view-history'));
    expect(
      await screen.findByTestId('knowledge-history-list'),
    ).toHaveTextContent('Update project overview');
    expect(screen.getByTestId('knowledge-history-list')).toHaveTextContent(
      'Harness Knowledge',
    );
    expect(screen.getByTestId('knowledge-history-list')).toHaveTextContent(
      'abcdef1',
    );
    expect(api.invoke).toHaveBeenCalledWith('knowledge:history', {
      projectId: 'project-1',
    });
  });

  it('explains how to enable knowledge when it is unavailable', async () => {
    installApi(TASKS, {
      config: {
        enabled: false,
        storage: 'local',
        proposalMode: 'review_required',
        injectContext: true,
        extractAfterTurn: true,
        search: {
          enabled: true,
          provider: 'basic',
          maxResults: 12,
          rerank: true,
        },
        format: { name: 'okf', version: '0.1' },
      },
      pages: [],
    });
    render(<TasksPanel workspaceId="ws1" projectId="project-1" />);

    fireEvent.click(screen.getByTestId('workspace-tab-knowledge'));

    expect(
      await screen.findByTestId('workspace-knowledge-unavailable'),
    ).toHaveTextContent('Knowledge is disabled');
    expect(
      screen.getByText(/Settings → Repo → Project knowledge/),
    ).toBeInTheDocument();
  });

  it('searches knowledge pages and opens a result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const searchResults: WikiSearchResult[] = [
      {
        pageId: 'auth',
        path: 'architecture/auth.md',
        title: 'Authentication flow',
        snippet: 'OAuth2 token exchange…',
        status: 'canonical',
      },
    ];
    const { api } = installApi(TASKS, {
      config: {
        enabled: true,
        storage: 'local',
        proposalMode: 'review_required',
        injectContext: true,
        extractAfterTurn: true,
        search: {
          enabled: true,
          provider: 'basic',
          maxResults: 12,
          rerank: true,
        },
        format: { name: 'okf', version: '0.1' },
      },
      pages: [
        {
          id: 'overview',
          path: 'overview.md',
          title: 'Project overview',
          type: 'Project Overview',
          status: 'canonical',
          tags: [],
        },
      ],
      searchResults,
    });
    render(<TasksPanel workspaceId="ws1" projectId="project-1" />);

    fireEvent.click(screen.getByTestId('workspace-tab-knowledge'));
    await screen.findByTestId('workspace-knowledge-available');

    const input = screen.getByTestId('knowledge-search-input');
    fireEvent.change(input, { target: { value: 'auth' } });

    await vi.advanceTimersByTimeAsync(300);

    expect(api.invoke).toHaveBeenCalledWith('knowledge:search', {
      projectId: 'project-1',
      query: 'auth',
    });
    expect(
      await screen.findByTestId('knowledge-search-results'),
    ).toHaveTextContent('Authentication flow');
    expect(screen.getByText('OAuth2 token exchange…')).toBeInTheDocument();

    api.invoke.mockImplementation((channel: string) => {
      if (channel === 'knowledge:getPage') {
        return Promise.resolve({
          id: 'auth',
          path: 'architecture/auth.md',
          title: 'Authentication flow',
          type: 'Architecture',
          status: 'canonical',
          tags: [],
          content: '---\ntitle: Authentication flow\n---\n\n# Auth',
          body: '# Auth',
          frontmatter: { title: 'Authentication flow' },
        });
      }
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByText('Authentication flow'));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('knowledge:getPage', {
        projectId: 'project-1',
        path: 'architecture/auth.md',
      }),
    );

    vi.useRealTimers();
  });

  it('shows empty state when search finds no matches', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installApi(TASKS, {
      config: {
        enabled: true,
        storage: 'local',
        proposalMode: 'review_required',
        injectContext: true,
        extractAfterTurn: true,
        search: {
          enabled: true,
          provider: 'basic',
          maxResults: 12,
          rerank: true,
        },
        format: { name: 'okf', version: '0.1' },
      },
      pages: [
        {
          id: 'overview',
          path: 'overview.md',
          title: 'Project overview',
          type: 'Project Overview',
          status: 'canonical',
          tags: [],
        },
      ],
      searchResults: [],
    });
    render(<TasksPanel workspaceId="ws1" projectId="project-1" />);

    fireEvent.click(screen.getByTestId('workspace-tab-knowledge'));
    await screen.findByTestId('workspace-knowledge-available');

    const input = screen.getByTestId('knowledge-search-input');
    fireEvent.change(input, { target: { value: 'nonexistent' } });

    await vi.advanceTimersByTimeAsync(300);

    expect(
      await screen.findByTestId('knowledge-search-empty'),
    ).toHaveTextContent('No matching pages found.');
    vi.useRealTimers();
  });

  it('preserves expanded knowledge folders across workspace tool tabs', async () => {
    installApi(TASKS, {
      config: {
        enabled: true,
        storage: 'local',
        proposalMode: 'review_required',
        injectContext: true,
        extractAfterTurn: true,
        search: {
          enabled: true,
          provider: 'basic',
          maxResults: 12,
          rerank: true,
        },
        format: { name: 'okf', version: '0.1' },
      },
      pages: [
        {
          id: 'setup',
          path: 'sources/claude/setup.md',
          title: 'Setup',
          type: 'Document',
          status: 'canonical',
          tags: [],
        },
      ],
    });
    render(<TasksPanel workspaceId="ws1" projectId="project-1" />);

    fireEvent.click(screen.getByTestId('workspace-tab-knowledge'));
    fireEvent.click(
      await screen.findByRole('button', { name: /sources 1 page/i }),
    );
    expect(
      screen.getByRole('button', { name: /claude 1 page/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('workspace-tab-tasks'));
    fireEvent.click(screen.getByTestId('workspace-tab-knowledge'));

    expect(
      await screen.findByRole('button', { name: /claude 1 page/i }),
    ).toBeInTheDocument();
  });

  it('opens review from chat navigation and approves a proposed OKF change', async () => {
    const proposal: WikiProposal = {
      id: 'proposal-1',
      projectId: 'project-1',
      workspaceId: 'ws1',
      turnId: 'turn-1',
      baseWikiCommit: 'abc',
      title: 'Document cabin semantics',
      summary: 'Records the union decision.',
      operations: [
        {
          op: 'create',
          path: 'decisions/cabin.md',
          content:
            '---\ntype: Decision\nstatus: canonical\n---\n\n# Cabin semantics',
        },
      ],
      status: 'pending_review',
      createdAt: 1,
    };
    const knowledge = {
      config: {
        enabled: true,
        storage: 'local' as const,
        proposalMode: 'review_required' as const,
        injectContext: true,
        extractAfterTurn: true,
        search: {
          enabled: true,
          provider: 'basic' as const,
          maxResults: 12,
          rerank: true,
        },
        format: { name: 'okf' as const, version: '0.1' as const },
      },
      pages: [],
      proposals: [proposal],
    };
    const { api } = installApi(TASKS, knowledge);

    render(
      <TasksPanel
        workspaceId="ws1"
        projectId="project-1"
        knowledgeReviewRequestId={1}
      />,
    );

    expect(
      await screen.findByTestId('knowledge-proposal-list'),
    ).toHaveTextContent('Document cabin semantics');
    fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('knowledge:acceptProposal', {
        projectId: 'project-1',
        proposalId: 'proposal-1',
      }),
    );
  });

  it('submits a trimmed rejection reason and removes the reviewed proposal', async () => {
    const proposal: WikiProposal = {
      id: 'proposal-1',
      projectId: 'project-1',
      workspaceId: 'ws1',
      baseWikiCommit: 'abc',
      title: 'Document cabin semantics',
      summary: 'Records the union decision.',
      operations: [
        {
          op: 'create',
          path: 'decisions/cabin.md',
          content:
            '---\ntype: Decision\nstatus: canonical\n---\n\n# Cabin semantics',
        },
      ],
      status: 'pending_review',
      createdAt: 1,
    };
    const knowledge = {
      config: {
        enabled: true,
        storage: 'local' as const,
        proposalMode: 'review_required' as const,
        injectContext: true,
        extractAfterTurn: true,
        search: {
          enabled: true,
          provider: 'basic' as const,
          maxResults: 12,
          rerank: true,
        },
        format: { name: 'okf' as const, version: '0.1' as const },
      },
      pages: [],
      proposals: [proposal],
    };
    const { api } = installApi(TASKS, knowledge);

    render(
      <TasksPanel
        workspaceId="ws1"
        projectId="project-1"
        knowledgeReviewRequestId={1}
      />,
    );

    const reason = await screen.findByRole('textbox', {
      name: 'Rejection reason for Document cabin semantics',
    });
    fireEvent.change(reason, {
      target: { value: '  Superseded by ADR-42.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('knowledge:rejectProposal', {
        projectId: 'project-1',
        proposalId: 'proposal-1',
        reason: 'Superseded by ADR-42.',
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText('Document cabin semantics'),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('TasksPanel create form', () => {
  it('does not expose workspace selection', async () => {
    installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));

    expect(
      screen.queryByTestId('task-workspace-select'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument();
  });

  it('uses the chat composer layout without cost or context controls', async () => {
    installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));

    expect(screen.getByTestId('task-composer')).toContainElement(
      screen.getByTestId('task-prompt'),
    );
    expect(screen.getByTestId('task-composer-controls')).toContainElement(
      screen.getByTestId('task-model-select'),
    );
    expect(screen.getByTestId('task-composer-controls')).toContainElement(
      screen.getByTestId('task-effort-select'),
    );
    expect(screen.queryByTestId('composer-cost')).not.toBeInTheDocument();
    expect(screen.queryByTestId('composer-context')).not.toBeInTheDocument();
  });

  it('shows the resolved default model and mode without workspace-default text', async () => {
    installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));

    expect(screen.getByTestId('task-model-select')).toHaveTextContent('Opus 5');
    expect(screen.getByTestId('task-effort-select')).toHaveTextContent('High');
    expect(screen.queryByText(/Workspace default/)).not.toBeInTheDocument();
  });

  it('offers workspace skills and expands the selected slash command on submit', async () => {
    const { api } = installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: '/harness' },
    });
    fireEvent.click(
      await screen.findByTestId('task-slash-command-harness-plan'),
    );
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: '/harness-plan build the task modal' },
    });
    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'task:create',
        expect.objectContaining({
          prompt: '/harness-plan build the task modal',
        }),
      ),
    );
  });

  it('submits plan mode and attached files from composer controls', async () => {
    const { api } = installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: 'review the brief' },
    });
    fireEvent.click(screen.getByTestId('task-plan'));
    expect(screen.getByTestId('task-plan')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByTestId('task-attach'));
    api.invoke.mockResolvedValueOnce('/tmp/brief.md');
    fireEvent.click(screen.getByTestId('task-attach-file'));
    expect(await screen.findByText('📄 brief.md')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'task:create',
        expect.objectContaining({
          mode: 'plan',
          attachments: [{ type: 'file', path: '/tmp/brief.md' }],
        }),
      ),
    );
  });

  it('submits the selected reasoning effort', async () => {
    const { api } = installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: 'review the implementation' },
    });
    fireEvent.click(screen.getByTestId('task-effort-select'));
    fireEvent.click(screen.getByTestId('task-effort-low'));
    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'task:create',
        expect.objectContaining({ effort: 'low' }),
      ),
    );
  });

  it('schedules after a predefined minute or hour delay', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { api } = installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));
    expect(screen.getByTestId('task-schedule-now')).toBeChecked();
    expect(
      screen.queryByTestId('task-relative-schedule'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-schedule')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: 'run after the delay' },
    });
    fireEvent.click(screen.getByTestId('task-schedule-relative'));
    fireEvent.click(screen.getByTestId('task-relative-preset-240'));

    expect(screen.getByTestId('task-relative-schedule')).toHaveTextContent(
      'Runs in 4 hours',
    );
    expect(screen.getByTestId('task-relative-preset-1440')).toHaveTextContent(
      '1 day',
    );
    expect(screen.queryByTestId('task-schedule')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'task:create',
        expect.objectContaining({
          scheduledAt: 15_400_000,
        }),
      ),
    );
  });

  it('submits the current workspace and normalized cross-provider model', async () => {
    const { api } = installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    // Open the form.
    fireEvent.click(await screen.findByTestId('task-new'));

    // Fill the prompt + pick a model preset.
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: 'run the suite' },
    });
    fireEvent.click(screen.getByTestId('task-model-select'));
    fireEvent.click(
      screen.getByTestId('task-model-option-codex-gpt-5-6-terra'),
    );

    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'task:create',
        expect.objectContaining({
          workspaceId: 'ws1',
          prompt: 'run the suite',
          model: 'codex-gpt-5-6-terra',
          harnessOverride: 'codex',
        }),
      ),
    );
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws1');
  });

  it('renders the full model menu outside the clipping task modal', async () => {
    installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));
    fireEvent.click(screen.getByTestId('task-model-select'));

    const menu = screen.getByTestId('task-model-menu');
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveClass('fixed', 'max-h-[calc(100vh-32px)]');
  });

  it('uses Chat catalogue normalization for Claude extended-context models', async () => {
    const { api } = installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: 'review everything' },
    });
    fireEvent.click(screen.getByTestId('task-model-select'));
    fireEvent.click(screen.getByTestId('task-model-option-claude-opus-4-8-1m'));
    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'task:create',
        expect.objectContaining({
          model: 'claude-opus-4-8[1m]',
          harnessOverride: 'claude_code',
        }),
      ),
    );
  });
});

describe('TasksPanel edit form', () => {
  it('does not expose or mutate task workspace assignment', async () => {
    const { api } = installApi([makeTask({ id: 'editable' })]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-edit-editable'));
    expect(
      screen.queryByTestId('task-workspace-select'),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: 'updated prompt' },
    });
    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() => {
      const update = api.invoke.mock.calls.find(
        ([channel]) => channel === 'task:update',
      );
      expect(update?.[1]).toEqual(
        expect.objectContaining({
          id: 'editable',
          prompt: 'updated prompt',
        }),
      );
      expect(update?.[1]).not.toHaveProperty('workspaceId');
    });
  });
});

describe('TasksPanel task:changed subscription', () => {
  it('refetches when a task:changed event fires for this workspace', async () => {
    const { api, listeners } = installApi(TASKS);
    render(<TasksPanel workspaceId="ws1" />);

    await screen.findByTestId('task-state-scheduled');
    const before = api.invoke.mock.calls.filter(
      (c) => c[0] === 'task:list',
    ).length;

    listeners['task:changed']?.forEach((cb) => cb({ workspaceId: 'ws1' }));

    await waitFor(() => {
      const after = api.invoke.mock.calls.filter(
        (c) => c[0] === 'task:list',
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
