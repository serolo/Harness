// Deep-link navigation (Phase 6, Track E2). A `nav:deepLink` broadcast (main resolved
// an `harness://…` URL) must select the target workspace. Chat, diff, and terminal now
// have fixed locations, so navigation no longer switches a center tab. Runs under jsdom
// with a stubbed `window.api`; captures the event listeners so the test can fire
// `nav:deepLink` like main would.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

import { AppLayout } from '@renderer/app/AppLayout';
import { Providers } from '@renderer/app/providers';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useNavStore } from '@renderer/stores/nav';
import { useTerminalStore } from '@renderer/features/terminal/terminalStore';
import type { Workspace } from '@shared/models';

// AppLayout now opens a terminal as soon as a workspace is selected. Keep these shell
// navigation tests focused on layout behavior rather than mounting xterm in jsdom.
vi.mock('@renderer/features/terminal/TerminalTab', () => ({
  TerminalTab: ({ tabId }: { tabId: string }) => (
    <div data-testid={`terminal-surface-${tabId}`} />
  ),
}));

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
      case 'harness:list':
      case 'run:list':
      case 'workspace:listOpenApps':
        return Promise.resolve([]);
      case 'chat:history':
        return Promise.resolve({ turns: [] });
      case 'diff:get':
        return Promise.resolve({ baseRef: 'main', headRef: 'HEAD', files: [] });
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
  useTerminalStore.setState({
    tabsByWorkspace: {},
    activeTabByWorkspace: {},
    bigTerminal: false,
  });
});

describe('AppLayout deep-link navigation', () => {
  it('selects the workspace and keeps diff in the right pane on a nav:deepLink event', async () => {
    const { listeners } = installApi();
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    expect(screen.queryByTestId('center-tabs')).not.toBeInTheDocument();
    expect(screen.getByTestId('right-git-pane')).toBeInTheDocument();

    // Fire the broadcast main would send after resolving `harness://workspace/ws-9/diff`.
    act(() => {
      listeners['nav:deepLink']?.forEach((cb) =>
        cb({ workspaceId: 'ws-9', pane: 'diff' }),
      );
    });

    await waitFor(() => {
      expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-9');
      expect(screen.getByTestId('right-git-pane')).toContainElement(
        screen.getByTestId('diff-panel'),
      );
    });
    // The pending nav target was consumed (won't re-fire).
    expect(useNavStore.getState().target).toBeNull();
  });

  it('selects the workspace and keeps chat centered for a bare link', async () => {
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
    expect(screen.getByTestId('center-pane')).toContainElement(
      screen.getByTestId('chat-panel'),
    );
  });
});

describe('AppLayout terminal section', () => {
  it('collapses the terminal row and gives the space back to git changes', async () => {
    const { listeners } = installApi();
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    act(() => {
      listeners['nav:deepLink']?.forEach((cb) => cb({ workspaceId: 'ws-4' }));
    });

    const toggle = await screen.findByLabelText('Collapse terminal section');
    expect(screen.getByTestId('right-work-area')).toHaveAttribute(
      'data-terminal-collapsed',
      'false',
    );

    act(() => toggle.click());
    expect(screen.getByTestId('right-work-area')).toHaveAttribute(
      'data-terminal-collapsed',
      'true',
    );
    expect(
      screen.getByLabelText('Expand terminal section'),
    ).toBeInTheDocument();
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

  it('reveals the fixed right pane on the showDiff action', async () => {
    const { listeners } = installApi();
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    act(() => {
      screen.getByTestId('toggle-right-pane').click();
    });
    expect(screen.queryByTestId('right-pane')).toBeNull();

    act(() => {
      listeners['menu:action']?.forEach((cb) => cb({ actionId: 'showDiff' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('right-git-pane')).toBeInTheDocument(),
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
});
