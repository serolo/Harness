// Renderer tests for the Sidebar feature (jsdom environment).
// Mirrors the installApi pattern from AppLayout.test.tsx.
//
// Tests:
//  - Seeded workspaces render with status-badge data-status attributes
//  - The New Workspace button is present
//  - A live workspace:status event flips a badge's data-status

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@renderer/app/providers';
import { Sidebar } from './Sidebar';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import type { Project, Workspace } from '@shared/models';

// ---------------------------------------------------------------------------
// window.api stub helpers (mirrors AppLayout.test.tsx)
// ---------------------------------------------------------------------------

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

type OnCallback = (payload: unknown) => void;

/**
 * Install a stubbed window.api.
 *
 * `invoke` dispatches on channel:
 *   - 'project:list'    → projects
 *   - 'workspace:list'  → workspaces
 *   - anything else     → undefined
 *
 * `on` records callbacks by event name so tests can invoke them.
 */
function installApi(
  projects: Project[],
  workspaces: Workspace[],
): { api: ApiStub; fireEvent: (event: string, payload: unknown) => void } {
  const callbacks: Record<string, OnCallback[]> = {};

  const invoke = vi.fn((channel: string, _req?: unknown) => {
    if (channel === 'project:list') return Promise.resolve(projects);
    if (channel === 'workspace:list') return Promise.resolve(workspaces);
    if (channel === 'app:ping') return Promise.resolve('ok');
    return Promise.resolve(undefined);
  });

  const on = vi.fn((event: string, cb: OnCallback) => {
    if (!callbacks[event]) callbacks[event] = [];
    callbacks[event].push(cb);
    return () => {
      callbacks[event] = (callbacks[event] ?? []).filter((x) => x !== cb);
    };
  });

  const stream = vi.fn(() => Promise.resolve());

  const api: ApiStub = { invoke, on, stream };
  (window as unknown as { api: ApiStub }).api = api;

  function fireEvent(event: string, payload: unknown): void {
    (callbacks[event] ?? []).forEach((cb) => cb(payload));
  }

  return { api, fireEvent };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-1';

const SEED_PROJECT: Project = {
  id: PROJECT_ID,
  name: 'my-repo',
  originUrl: 'https://github.com/x/y',
  defaultBranch: 'main',
  repoPath: '/tmp/my-repo',
  createdAt: Date.now(),
};

const WORKSPACE_IDLE: Workspace = {
  id: 'ws-idle',
  projectId: PROJECT_ID,
  name: 'paris',
  branch: 'agent/paris',
  baseBranch: 'main',
  worktreePath: '/tmp/worktrees/paris',
  status: 'idle',
  sourceKind: 'none',
  sourceRef: null,
  harness: 'claude_code',
  port: 3001,
  createdAt: Date.now(),
  archivedAt: null,
  prNumber: null,
};

const WORKSPACE_ARCHIVED: Workspace = {
  id: 'ws-archived',
  projectId: PROJECT_ID,
  name: 'tokyo',
  branch: 'agent/tokyo',
  baseBranch: 'main',
  worktreePath: null,
  status: 'archived',
  sourceKind: 'none',
  sourceRef: null,
  harness: 'claude_code',
  port: null,
  createdAt: Date.now(),
  archivedAt: Date.now(),
  prNumber: null,
};

// ---------------------------------------------------------------------------
// Helper: render <Sidebar> with isolated QueryClient + providers
// ---------------------------------------------------------------------------

function renderSidebar() {
  const client = createQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <Sidebar />
    </QueryClientProvider>,
  );
}

/**
 * Reset the Zustand store before AND after each test so state never leaks across
 * test boundaries. The store is a module-level singleton — it outlives individual
 * renders and accumulates state if not reset explicitly.
 */
function resetStore(): void {
  useWorkspacesStore.setState({
    projects: [],
    workspaces: [],
    selectedWorkspaceId: null,
    selectedProjectId: null,
  });
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
  resetStore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sidebar — seeded workspaces render', () => {
  beforeEach(() => {
    installApi([SEED_PROJECT], [WORKSPACE_IDLE, WORKSPACE_ARCHIVED]);
  });

  it('renders status badges for workspaces that have loaded', async () => {
    renderSidebar();
    // Wait for the idle workspace badge
    await waitFor(() => {
      const badges = screen.getAllByTestId('status-badge');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
    const badges = screen.getAllByTestId('status-badge');
    const statuses = badges.map((b) => b.getAttribute('data-status'));
    expect(statuses).toContain('idle');
  });

  it('renders the New Workspace button', async () => {
    renderSidebar();
    // Button may be disabled but must be present
    await waitFor(() => {
      expect(screen.getByTestId('new-workspace-button')).toBeInTheDocument();
    });
  });

  it('renders the idle workspace item', async () => {
    renderSidebar();
    await waitFor(() => {
      const badge = screen
        .getAllByTestId('status-badge')
        .find((b) => b.getAttribute('data-status') === 'idle');
      expect(badge).toBeDefined();
    });
  });
});

describe('Sidebar — live workspace:status event flips badge', () => {
  it('flips data-status from idle to working when workspace:status event fires', async () => {
    const { fireEvent } = installApi(
      [SEED_PROJECT],
      [WORKSPACE_IDLE, WORKSPACE_ARCHIVED],
    );

    renderSidebar();

    // Wait for the idle badge to appear
    await waitFor(() => {
      const badge = screen
        .getAllByTestId('status-badge')
        .find((b) => b.getAttribute('data-status') === 'idle');
      expect(badge).toBeDefined();
    });

    // Fire a workspace:status event for the idle workspace
    fireEvent('workspace:status', {
      workspaceId: WORKSPACE_IDLE.id,
      status: 'working',
    });

    // The badge should flip to working
    await waitFor(() => {
      const workingBadge = screen
        .getAllByTestId('status-badge')
        .find((b) => b.getAttribute('data-status') === 'working');
      expect(workingBadge).toBeDefined();
    });
  });
});

describe('Sidebar — empty state', () => {
  it('shows empty-state message when no workspaces exist', async () => {
    installApi([SEED_PROJECT], []);
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-empty')).toBeInTheDocument();
    });
  });

  it('does not render status badges when workspace list is empty', async () => {
    installApi([SEED_PROJECT], []);
    renderSidebar();
    await waitFor(() => {
      // Sidebar should be fully rendered (empty-state visible)
      expect(screen.getByTestId('sidebar-empty')).toBeInTheDocument();
    });
    expect(screen.queryAllByTestId('status-badge').length).toBe(0);
  });
});

describe('Sidebar — no projects state', () => {
  it('New Workspace button is disabled when no project is selected', async () => {
    installApi([], []);
    renderSidebar();
    await waitFor(() => {
      const btn = screen.getByTestId('new-workspace-button');
      expect(btn).toBeInTheDocument();
      expect(btn).toBeDisabled();
    });
  });
});
