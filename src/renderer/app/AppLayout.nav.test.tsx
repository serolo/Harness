// Deep-link navigation (Phase 6, Track E2). A `nav:deepLink` broadcast (main resolved
// an `harness://…` URL) must select the target workspace and switch to the requested
// pane. Runs under jsdom with a stubbed `window.api`; captures the event listeners so
// the test can fire `nav:deepLink` like main would.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

import { AppLayout } from '@renderer/app/AppLayout';
import { Providers } from '@renderer/app/providers';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useNavStore } from '@renderer/stores/nav';
import type { Workspace } from '@shared/models';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

/** Install a stubbed api, capturing event listeners so tests can fire broadcasts. */
function installApi(): {
  api: ApiStub;
  listeners: Record<string, ((payload: unknown) => void)[]>;
} {
  const listeners: Record<string, ((payload: unknown) => void)[]> = {};
  const invoke = vi.fn((channel: string) => {
    switch (channel) {
      case 'app:ping':
        return Promise.resolve('ok');
      case 'project:list':
      case 'workspace:list':
      case 'diff:commits':
      case 'checkpoint:list':
      case 'comment:list':
        return Promise.resolve([]);
      case 'diff:get':
        return Promise.resolve({ baseRef: 'main', headRef: 'HEAD', files: [] });
      case 'workspace:archivePreview':
        return Promise.resolve({
          hasUncommittedChanges: false,
          changedFileCount: 0,
          willDeleteWorktree: true,
        });
      case 'settings:getEffective':
      case 'settings:getProvenance':
        // Contract-honest objects so the settings overlay renders (getEffective never
        // returns undefined in production); the panel's getAtPath tolerates gaps.
        return Promise.resolve({});
      default:
        return Promise.resolve(undefined);
    }
  });
  const api: ApiStub = {
    invoke,
    on: vi.fn((event: string, cb: (payload: unknown) => void) => {
      (listeners[event] ??= []).push(cb);
      return () => {};
    }),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return { api, listeners };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
  useWorkspacesStore.setState({
    selectedWorkspaceId: null,
    workspaces: [],
    selectedProjectId: null,
  });
  useNavStore.setState({ target: null });
});

describe('AppLayout deep-link navigation', () => {
  it('selects the workspace and opens the diff pane on a nav:deepLink event', async () => {
    const { listeners } = installApi();
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    // Chat is the default center tab.
    expect(screen.getByTestId('center-tab-chat')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Fire the broadcast main would send after resolving `harness://workspace/ws-9/diff`.
    act(() => {
      listeners['nav:deepLink']?.forEach((cb) =>
        cb({ workspaceId: 'ws-9', pane: 'diff' }),
      );
    });

    await waitFor(() => {
      expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-9');
      expect(screen.getByTestId('center-tab-diff')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    // The pending nav target was consumed (won't re-fire).
    expect(useNavStore.getState().target).toBeNull();
  });

  it('selects the workspace without changing the tab for a bare (paneless) link', async () => {
    const { listeners } = installApi();
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    act(() => {
      listeners['nav:deepLink']?.forEach((cb) => cb({ workspaceId: 'ws-3' }));
    });

    await waitFor(() =>
      expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-3'),
    );
    // No pane requested → stays on the default chat tab.
    expect(screen.getByTestId('center-tab-chat')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('AppLayout menu:action dispatch (Track H1)', () => {
  it('opens the settings overlay on the openSettings action', async () => {
    const { listeners } = installApi();
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );
    expect(screen.queryByTestId('settings-overlay')).toBeNull();

    act(() => {
      listeners['menu:action']?.forEach((cb) =>
        cb({ actionId: 'openSettings' }),
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-overlay')).toBeInTheDocument(),
    );
  });

  it('switches to the diff tab on the showDiff action', async () => {
    const { listeners } = installApi();
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    act(() => {
      listeners['menu:action']?.forEach((cb) => cb({ actionId: 'showDiff' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('center-tab-diff')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('selects the Nth workspace on selectWorkspace:N', async () => {
    const { listeners } = installApi();
    useWorkspacesStore.setState({
      selectedProjectId: 'p1',
      workspaces: [
        { id: 'w1', projectId: 'p1', status: 'idle' },
        { id: 'w2', projectId: 'p1', status: 'idle' },
      ] as unknown as Workspace[],
    });
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    act(() => {
      listeners['menu:action']?.forEach((cb) =>
        cb({ actionId: 'selectWorkspace:2' }),
      );
    });
    await waitFor(() =>
      expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('w2'),
    );
  });

  it('archives the selected workspace on archiveWorkspace', async () => {
    const { api, listeners } = installApi();
    const workspace = {
      id: 'w1',
      projectId: 'p1',
      name: 'selected workspace',
      status: 'idle',
    } as Workspace;
    useWorkspacesStore.setState({
      selectedWorkspaceId: workspace.id,
      selectedProjectId: workspace.projectId,
      workspaces: [workspace],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    act(() => {
      listeners['menu:action']?.forEach((cb) =>
        cb({ actionId: 'archiveWorkspace' }),
      );
    });

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('workspace:archive', {
        id: 'w1',
      }),
    );
  });
});
