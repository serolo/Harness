import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@renderer/app/providers';
import type { Workspace } from '@shared/models';
import { useWorkspaceCreationStore } from '@renderer/stores/workspaceCreation';
import { useWorkspaceArchiveStore } from '@renderer/stores/workspaceArchive';
import { WorkspaceItem } from './WorkspaceItem';

const WORKSPACE: Workspace = {
  id: 'ws-1',
  projectId: 'project-1',
  name: 'paris',
  branch: 'agent/paris',
  baseBranch: 'main',
  worktreePath: '/tmp/paris',
  status: 'idle',
  sourceKind: 'none',
  sourceRef: null,
  harness: 'claude_code',
  port: 3001,
  createdAt: 1,
  archivedAt: null,
  prNumber: null,
  location: 'worktree',
};

function renderItem(workspace: Workspace = WORKSPACE): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ul>
        <WorkspaceItem
          workspace={workspace}
          isSelected={false}
          onSelect={() => {}}
        />
      </ul>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useWorkspaceCreationStore.setState({ current: null });
  useWorkspaceArchiveStore.setState({ current: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

function installWorkspaceUpdateApi(): ReturnType<typeof vi.fn> {
  const invoke = vi.fn((channel: string, req: Record<string, unknown>) => {
    if (channel === 'workspace:update') {
      return Promise.resolve({ ...WORKSPACE, ...req });
    }
    return Promise.resolve(undefined);
  });
  (window as unknown as { api: unknown }).api = {
    invoke,
    on: vi.fn(),
    stream: vi.fn(),
  };
  return invoke;
}

describe('WorkspaceItem context menu', () => {
  it('shows only the workspace name and status in the list row', () => {
    renderItem();

    expect(screen.getByText('paris')).toBeInTheDocument();
    expect(screen.getByText('idle')).toBeInTheDocument();
    expect(screen.queryByText('agent/paris')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
    expect(screen.queryByText(':3001')).not.toBeInTheDocument();
  });

  it.each([
    ['open', false, 'Pull request #42 is open'],
    ['open', true, 'Pull request #42 is draft'],
    ['closed', false, 'Pull request #42 is closed'],
    ['merged', false, 'Pull request #42 is merged'],
  ])(
    'shows the linked pull request icon for %s (draft: %s)',
    async (state, draft, accessibleName) => {
      const invoke = vi.fn((channel: string) =>
        Promise.resolve(
          channel === 'github:getWorkspacePr'
            ? {
                number: 42,
                url: 'https://github.com/acme/repo/pull/42',
                title: 'Improve workspace list',
                draft,
                mergeableState: 'unknown',
                state,
              }
            : undefined,
        ),
      );
      (window as unknown as { api: unknown }).api = {
        invoke,
        on: vi.fn(),
        stream: vi.fn(),
      };

      renderItem({ ...WORKSPACE, prNumber: 42 });

      expect(
        await screen.findByLabelText(accessibleName),
      ).toBeInTheDocument();
      expect(invoke).toHaveBeenCalledWith('github:getWorkspacePr', {
        workspaceId: WORKSPACE.id,
      });
    },
  );

  it('discovers a pull request from the workspace branch without a stored PR number', async () => {
    const invoke = vi.fn((channel: string) =>
      Promise.resolve(
        channel === 'github:getWorkspacePr'
          ? {
              number: 43,
              url: 'https://github.com/acme/repo/pull/43',
              title: 'Branch-discovered PR',
              draft: false,
              mergeableState: 'clean',
              state: 'open',
            }
          : undefined,
      ),
    );
    (window as unknown as { api: unknown }).api = {
      invoke,
      on: vi.fn(),
      stream: vi.fn(),
    };

    renderItem();

    expect(
      await screen.findByLabelText('Pull request #43 is open'),
    ).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('github:getWorkspacePr', {
      workspaceId: WORKSPACE.id,
    });
  });

  it('shows background lifecycle progress on the matching workspace row', () => {
    useWorkspaceArchiveStore.setState({
      current: {
        workspaceId: WORKSPACE.id,
        workspaceName: WORKSPACE.name,
        phase: 'Stopping processes…',
        lines: [],
        status: 'running',
        error: null,
      },
    });

    renderItem();

    expect(
      screen.getByTestId('workspace-operation-progress'),
    ).toHaveTextContent('archiving');
    expect(screen.queryByTestId('archive-btn')).not.toBeInTheDocument();
  });

  it('opens on right click and persists unread, pin, and status actions', async () => {
    const invoke = installWorkspaceUpdateApi();
    renderItem();

    fireEvent.contextMenu(screen.getByTestId('workspace-item'), {
      clientX: 40,
      clientY: 60,
    });
    expect(screen.getByTestId('workspace-context-menu')).toBeInTheDocument();
    expect(screen.getByText('Mark as unread')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('workspace-menu-unread'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('workspace:update', {
        id: 'ws-1',
        isUnread: true,
      }),
    );

    fireEvent.contextMenu(screen.getByTestId('workspace-item'));
    fireEvent.click(screen.getByTestId('workspace-menu-pin'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('workspace:update', {
        id: 'ws-1',
        isPinned: true,
      }),
    );

    fireEvent.contextMenu(screen.getByTestId('workspace-item'));
    fireEvent.click(screen.getByTestId('workspace-menu-status'));
    fireEvent.click(screen.getByTestId('workspace-status-needs_attention'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('workspace:update', {
        id: 'ws-1',
        status: 'needs_attention',
      }),
    );
  });

  it('renames from a modal and copies the stable workspace deep link', async () => {
    const invoke = installWorkspaceUpdateApi();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderItem();

    fireEvent.contextMenu(screen.getByTestId('workspace-item'));
    fireEvent.click(screen.getByTestId('workspace-menu-rename'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const input = screen.getByTestId('workspace-rename-input');
    fireEvent.change(input, { target: { value: 'Fix workspace menu' } });
    expect(
      screen.getByTestId('workspace-rename-branch-checkbox'),
    ).not.toBeChecked();
    fireEvent.click(screen.getByText('Rename'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('workspace:update', {
        id: 'ws-1',
        name: 'Fix workspace menu',
      }),
    );

    fireEvent.contextMenu(screen.getByTestId('workspace-item'));
    fireEvent.click(screen.getByTestId('workspace-menu-copy-link'));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('harness://workspace/ws-1'),
    );
  });

  it('can rename the branch while leaving the worktree path unchanged', async () => {
    const invoke = installWorkspaceUpdateApi();
    renderItem();

    fireEvent.contextMenu(screen.getByTestId('workspace-item'));
    fireEvent.click(screen.getByTestId('workspace-menu-rename'));
    const input = screen.getByTestId('workspace-rename-input');
    fireEvent.change(input, {
      target: { value: 'W2BT-21830/prev-stay-room (#42)' },
    });
    expect(
      screen.getByText('agent/paris -> agent/w2bt-21830-prev-stay-room-42'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('workspace-rename-branch-checkbox'));
    fireEvent.click(screen.getByText('Rename'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('workspace:update', {
        id: 'ws-1',
        name: 'W2BT-21830/prev-stay-room (#42)',
        renameBranch: true,
      }),
    );
  });
});

describe('WorkspaceItem archive safety', () => {
  it('warns that dirty files will be deleted before archiving', async () => {
    const invoke = vi.fn((channel: string) => {
      if (channel === 'workspace:archivePreview') {
        return Promise.resolve({
          hasUncommittedChanges: true,
          changedFileCount: 2,
          willDeleteWorktree: true,
        });
      }
      return Promise.resolve(undefined);
    });
    (window as unknown as { api: unknown }).api = {
      invoke,
      on: vi.fn(),
      stream: vi.fn(() => Promise.resolve()),
    };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderItem();

    fireEvent.click(screen.getByTestId('archive-btn'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toContain(
      '2 uncommitted files will be permanently deleted',
    );
    await waitFor(() =>
      expect(
        (window as unknown as { api: { stream: ReturnType<typeof vi.fn> } }).api
          .stream,
      ).toHaveBeenCalledWith(
        'workspace:archiveStream',
        { id: 'ws-1' },
        expect.any(Function),
        expect.any(Object),
      ),
    );
  });

  it('explains that dirty files are preserved when deletion is disabled', async () => {
    const invoke = vi.fn((channel: string) =>
      Promise.resolve(
        channel === 'workspace:archivePreview'
          ? {
              hasUncommittedChanges: true,
              changedFileCount: 1,
              willDeleteWorktree: false,
            }
          : undefined,
      ),
    );
    (window as unknown as { api: unknown }).api = {
      invoke,
      on: vi.fn(),
      stream: vi.fn(() => Promise.resolve()),
    };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderItem();

    fireEvent.click(screen.getByTestId('archive-btn'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toContain(
      '1 uncommitted file will remain in the preserved checkout',
    );
    expect(invoke).not.toHaveBeenCalledWith(
      'workspace:archive',
      expect.anything(),
    );
  });
});
