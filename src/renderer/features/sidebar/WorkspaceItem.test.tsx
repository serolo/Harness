import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@renderer/app/providers';
import type { Workspace } from '@shared/models';
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
  port: null,
  createdAt: 1,
  archivedAt: null,
  prNumber: null,
  location: 'worktree',
};

function renderItem(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ul>
        <WorkspaceItem
          workspace={WORKSPACE}
          isSelected={false}
          onSelect={() => {}}
        />
      </ul>
    </QueryClientProvider>,
  );
}

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

  it('renames inline and copies the stable workspace deep link', async () => {
    const invoke = installWorkspaceUpdateApi();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderItem();

    fireEvent.contextMenu(screen.getByTestId('workspace-item'));
    fireEvent.click(screen.getByTestId('workspace-menu-rename'));
    const input = screen.getByTestId('workspace-rename-input');
    fireEvent.change(input, { target: { value: 'Fix workspace menu' } });
    fireEvent.keyDown(input, { key: 'Enter' });
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
      stream: vi.fn(),
    };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderItem();

    fireEvent.click(screen.getByTestId('archive-btn'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toContain(
      '2 uncommitted files will be permanently deleted',
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('workspace:archive', { id: 'ws-1' }),
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
      stream: vi.fn(),
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
