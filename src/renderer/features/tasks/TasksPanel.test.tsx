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
      case 'knowledge:config':
        return Promise.resolve(knowledge?.config);
      case 'knowledge:initialize':
        return Promise.resolve({ commit: 'abc' });
      case 'knowledge:listPages':
        return Promise.resolve(knowledge?.pages ?? []);
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
    fireEvent.change(reason, { target: { value: '  Superseded by ADR-42.  ' } });
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
  it('defaults to the current workspace and shows project-qualified active workspaces', async () => {
    installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));
    const select = screen.getByTestId('task-workspace-select');

    expect(select).toHaveValue('ws1');
    expect(select).toHaveTextContent('Harness — current');
    expect(select).toHaveTextContent('Harness — target');
    expect(select).toHaveTextContent('Companion — remote');
    expect(select).not.toHaveTextContent('Companion — old');
  });

  it('submits the selected workspace and normalized cross-provider model without navigating', async () => {
    const { api } = installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    // Open the form.
    fireEvent.click(await screen.findByTestId('task-new'));

    // Fill the prompt + pick a model preset.
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: 'run the suite' },
    });
    fireEvent.change(screen.getByTestId('task-model-select'), {
      target: { value: 'codex-gpt-5-6-terra' },
    });
    fireEvent.change(screen.getByTestId('task-workspace-select'), {
      target: { value: 'ws2' },
    });

    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'task:create',
        expect.objectContaining({
          workspaceId: 'ws2',
          prompt: 'run the suite',
          model: 'codex-gpt-5-6-terra',
          harnessOverride: 'codex',
        }),
      ),
    );
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws1');
  });

  it('uses Chat catalogue normalization for Claude extended-context models', async () => {
    const { api } = installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('task-new'));
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: 'review everything' },
    });
    fireEvent.change(screen.getByTestId('task-model-select'), {
      target: { value: 'claude-opus-4-8-1m' },
    });
    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'task:create',
        expect.objectContaining({
          model: 'opus[1m]',
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
