import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@renderer/app/providers';
import { Sidebar } from './Sidebar';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import type { Project, Workspace } from '@shared/models';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

type OnCallback = (payload: unknown) => void;

function installApi(
  projects: Project[],
  workspaces: Workspace[],
  workspaceListPending = false,
): { fireEvent: (event: string, payload: unknown) => void } {
  const callbacks: Record<string, OnCallback[]> = {};
  const invoke = vi.fn((channel: string, req?: { projectId?: string }) => {
    if (channel === 'project:list') return Promise.resolve(projects);
    if (channel === 'workspace:list') {
      if (workspaceListPending) return new Promise(() => {});
      return Promise.resolve(
        workspaces.filter(
          (workspace) => workspace.projectId === req?.projectId,
        ),
      );
    }
    if (channel === 'app:ping') return Promise.resolve('ok');
    return Promise.resolve(undefined);
  });
  const on = vi.fn((event: string, cb: OnCallback) => {
    (callbacks[event] ??= []).push(cb);
    return () => {
      callbacks[event] = (callbacks[event] ?? []).filter(
        (entry) => entry !== cb,
      );
    };
  });
  const api: ApiStub = { invoke, on, stream: vi.fn(() => Promise.resolve()) };
  (window as unknown as { api: ApiStub }).api = api;
  return {
    fireEvent: (event, payload) =>
      (callbacks[event] ?? []).forEach((callback) => callback(payload)),
  };
}

const PROJECT_ONE: Project = {
  id: 'proj-1',
  name: 'my-repo',
  originUrl: 'https://github.com/x/y',
  defaultBranch: 'main',
  repoPath: '/tmp/my-repo',
  createdAt: 1,
};

const PROJECT_TWO: Project = {
  ...PROJECT_ONE,
  id: 'proj-2',
  name: 'second-repo',
  repoPath: '/tmp/second-repo',
  createdAt: 2,
};

function workspace(id: string, projectId: string, name: string): Workspace {
  return {
    id,
    projectId,
    name,
    branch: `agent/${name}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${name}`,
    status: 'idle',
    sourceKind: 'none',
    sourceRef: null,
    harness: 'claude_code',
    port: null,
    createdAt: 1,
    archivedAt: null,
    prNumber: null,
  };
}

const WORKSPACE_ONE = workspace('ws-1', PROJECT_ONE.id, 'paris');
const WORKSPACE_TWO = workspace('ws-2', PROJECT_TWO.id, 'tokyo');

function renderSidebar(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Sidebar />
    </QueryClientProvider>,
  );
}

function resetStore(): void {
  useWorkspacesStore.setState({
    projects: [],
    workspaces: [],
    selectedWorkspaceId: null,
    selectedProjectId: null,
  });
}

beforeEach(resetStore);

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
  resetStore();
});

describe('Sidebar project tree', () => {
  it('renders every project without a project selection dropdown', async () => {
    installApi([PROJECT_ONE, PROJECT_TWO], [WORKSPACE_ONE, WORKSPACE_TWO]);
    renderSidebar();

    expect(await screen.findByText('my-repo')).toBeInTheDocument();
    expect(screen.getByText('second-repo')).toBeInTheDocument();
    expect(screen.queryByLabelText('Select project')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('project-group')).toHaveLength(2);
  });

  it('expands each project to show that project’s sessions', async () => {
    installApi([PROJECT_ONE, PROJECT_TWO], [WORKSPACE_ONE, WORKSPACE_TWO]);
    renderSidebar();

    expect(await screen.findByText('paris')).toBeInTheDocument();
    expect(screen.queryByText('tokyo')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId('project-toggle')[1]);
    expect(await screen.findByText('tokyo')).toBeInTheDocument();
  });

  it('omits archived workspaces from the project list', async () => {
    const archivedWorkspace: Workspace = {
      ...workspace('ws-archived', PROJECT_ONE.id, 'finished-session'),
      status: 'archived',
      archivedAt: 2,
    };
    installApi([PROJECT_ONE], [WORKSPACE_ONE, archivedWorkspace]);
    renderSidebar();

    expect(await screen.findByText('paris')).toBeInTheDocument();
    expect(screen.queryByText('finished-session')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('workspace-item')).toHaveLength(1);
  });

  it('sorts pinned workspaces before unpinned siblings', async () => {
    const first = workspace('ws-first', PROJECT_ONE.id, 'first');
    const pinned = {
      ...workspace('ws-pinned', PROJECT_ONE.id, 'pinned'),
      isPinned: true,
    };
    installApi([PROJECT_ONE], [first, pinned]);
    renderSidebar();

    const rows = await screen.findAllByTestId('workspace-item');
    expect(rows.map((row) => row.getAttribute('data-workspace-id'))).toEqual([
      'ws-pinned',
      'ws-first',
    ]);
  });

  it('offers a new-workspace action on every project', async () => {
    installApi([PROJECT_ONE, PROJECT_TWO], []);
    renderSidebar();
    await waitFor(() =>
      expect(screen.getAllByTestId('project-new-workspace')).toHaveLength(2),
    );
  });

  it('updates a visible session from workspace status events', async () => {
    const events = installApi([PROJECT_ONE], [WORKSPACE_ONE]);
    renderSidebar();
    await screen.findByText('paris');

    events.fireEvent('workspace:status', {
      workspaceId: WORKSPACE_ONE.id,
      status: 'working',
    });
    await waitFor(() =>
      expect(screen.getByTestId('status-badge')).toHaveAttribute(
        'data-status',
        'working',
      ),
    );
  });

  it('shows the add-project action when there are no projects', async () => {
    installApi([], []);
    renderSidebar();
    expect(await screen.findByTestId('sidebar-empty')).toHaveTextContent(
      'No projects yet.',
    );
    expect(screen.getByTestId('add-project-button')).toBeEnabled();
  });

  it('does not loop or blank the app while workspace lists are pending', async () => {
    installApi([PROJECT_ONE], [], true);
    renderSidebar();

    expect(await screen.findByText('my-repo')).toBeInTheDocument();
    expect(screen.getByText('Loading sessions…')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });
});
