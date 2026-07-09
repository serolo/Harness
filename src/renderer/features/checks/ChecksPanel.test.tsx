// ChecksPanel test — the merge-readiness panel (Phase 5, Task 10). Runs under jsdom with
// a stubbed `window.api` (the ONLY main-process access point), mirroring
// `DiffPanel.test.tsx`'s harness so the real `@renderer/ipc` funnel + real components run.
//
// Covers: signal rows + blockers render from a stubbed `checks:get`; the Merge button is
// DISABLED when the roll-up is blocked and ENABLED when green; a blocker action button
// invokes the matching command; `checks:updated` triggers a refetch; and the
// `checks:updated` subscription is torn down on unmount (no listener leak).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ChecksPanel } from './ChecksPanel';
import { useChecksStore } from '@renderer/stores/checks';
import { useChatStore } from '@renderer/stores/chat';
import type { ChecksResult } from '@shared/checks';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

/** A blocked roll-up: failing CI (blocker) + unpushed git work (actionable pending). */
const BLOCKED: ChecksResult = {
  workspaceId: 'ws1',
  state: 'blocked',
  updatedAt: 1,
  items: [
    {
      source: 'git',
      label: 'Unpushed commits',
      severity: 'pending',
      suggestedAction: 'Commit & push',
      details: {
        source: 'git',
        ahead: 1,
        behind: 0,
        uncommitted: 0,
        unpushed: true,
      },
    },
    {
      source: 'pr',
      label: 'PR #7',
      severity: 'ok',
      details: {
        source: 'pr',
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        title: 'Add checks panel',
        draft: false,
        mergeableState: 'blocked',
      },
    },
    {
      source: 'ci',
      label: 'CI: 1 failing',
      severity: 'blocker',
      suggestedAction: 'Fix failing checks',
      details: {
        source: 'ci',
        total: 1,
        failing: 1,
        pending: 0,
        runs: [{ name: 'build', conclusion: 'failure', detailsUrl: null }],
      },
    },
  ],
};

/** A green roll-up: nothing gating the merge. */
const GREEN: ChecksResult = {
  workspaceId: 'ws1',
  state: 'green',
  updatedAt: 2,
  items: [
    {
      source: 'git',
      label: 'Up to date with base',
      severity: 'ok',
      details: {
        source: 'git',
        ahead: 0,
        behind: 0,
        uncommitted: 0,
        unpushed: false,
      },
    },
    {
      source: 'ci',
      label: 'CI passing',
      severity: 'ok',
      details: { source: 'ci', total: 1, failing: 0, pending: 0, runs: [] },
    },
  ],
};

interface Installed {
  api: ApiStub;
  /** Captured event listeners, keyed by channel (to fire `checks:updated`). */
  listeners: Record<string, ((payload: unknown) => void)[]>;
  /** The unsubscribe spy every `on(...)` returns (to assert cleanup). */
  unsubscribe: ReturnType<typeof vi.fn>;
}

function installApi(result: ChecksResult): Installed {
  const listeners: Record<string, ((payload: unknown) => void)[]> = {};
  const unsubscribe = vi.fn();

  const invoke = vi.fn((channel: string) => {
    switch (channel) {
      case 'checks:get':
        return Promise.resolve(result);
      case 'pr:open':
        return Promise.resolve({
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          title: 'Add checks panel',
          draft: false,
          mergeableState: 'clean',
        });
      case 'pr:fixChecks':
      case 'pr:fixReviews':
        return Promise.resolve({ prompt: 'Fix it.', attachments: [] });
      case 'pr:merge':
        return Promise.resolve(undefined);
      case 'review:resolveThread':
        return Promise.resolve(undefined);
      case 'chat:history':
        return Promise.resolve({ turns: [] });
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
  useChecksStore.setState({ resultByWorkspace: {} });
  useChatStore.setState({ byWorkspace: {}, busyByWorkspace: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('ChecksPanel rendering', () => {
  it('renders a signal row per item and a blocker list from checks:get', async () => {
    installApi(BLOCKED);

    render(<ChecksPanel workspaceId="ws1" />);

    // One SignalRow per aggregated item.
    expect(await screen.findByTestId('signal-row-git')).toHaveTextContent(
      'Unpushed commits',
    );
    expect(screen.getByTestId('signal-row-ci')).toHaveTextContent(
      'CI: 1 failing',
    );

    // BlockerList surfaces the actionable rows with their one-click buttons.
    expect(screen.getByTestId('blocker-action-git')).toHaveTextContent(
      'Commit & push',
    );
    expect(screen.getByTestId('blocker-action-ci')).toHaveTextContent(
      'Fix failing checks',
    );

    // PrCard renders from the pr item's details.
    expect(screen.getByTestId('pr-card')).toHaveTextContent('#7');
  });
});

describe('ChecksPanel merge gating', () => {
  it('disables the Merge button when the roll-up is blocked', async () => {
    installApi(BLOCKED);
    render(<ChecksPanel workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('merge-button')).toBeDisabled(),
    );
  });

  it('enables the Merge button when the roll-up is green', async () => {
    installApi(GREEN);
    render(<ChecksPanel workspaceId="ws1" />);
    await waitFor(() =>
      expect(screen.getByTestId('merge-button')).toBeEnabled(),
    );
  });
});

describe('ChecksPanel blocker actions', () => {
  it('invokes pr:fixChecks when the "Fix failing checks" blocker button is clicked', async () => {
    const { api } = installApi(BLOCKED);
    render(<ChecksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('blocker-action-ci'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('pr:fixChecks', {
        workspaceId: 'ws1',
      }),
    );
  });

  it('invokes pr:open when the "Commit & push" blocker button is clicked', async () => {
    const { api } = installApi(BLOCKED);
    render(<ChecksPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('blocker-action-git'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('pr:open', {
        workspaceId: 'ws1',
      }),
    );
  });
});

describe('ChecksPanel checks:updated subscription', () => {
  it('refetches when a checks:updated event fires for this workspace', async () => {
    const { api, listeners } = installApi(BLOCKED);
    render(<ChecksPanel workspaceId="ws1" />);

    // Wait for the initial load + subscription.
    await screen.findByTestId('signal-row-git');
    const before = api.invoke.mock.calls.filter(
      (c) => c[0] === 'checks:get',
    ).length;

    // Fire the event the panel subscribed to.
    listeners['checks:updated']?.forEach((cb) =>
      cb({ workspaceId: 'ws1', checks: {} }),
    );

    await waitFor(() => {
      const after = api.invoke.mock.calls.filter(
        (c) => c[0] === 'checks:get',
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('unsubscribes from checks:updated on unmount (no listener leak)', async () => {
    const { unsubscribe } = installApi(BLOCKED);
    const { unmount } = render(<ChecksPanel workspaceId="ws1" />);

    await screen.findByTestId('signal-row-git');
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
