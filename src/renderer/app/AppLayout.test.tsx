// Renderer: AppLayout renders + the IPC-OK indicator reflects the app:ping result
// (Task 10 / phase doc §7). Runs under jsdom (see vitest.config environmentMatchGlobs).
//
// We do NOT boot Electron. Instead we stub `window.api` — the ONLY main-process access
// point the renderer has (src/preload/api.d.ts) — so `invoke('app:ping', …)` resolves or
// rejects on demand. The renderer IPC funnel (src/renderer/ipc) calls `window.api.invoke`
// under the hood, so stubbing `window.api` exercises the real funnel + real component.
//
// Phase 1 note: <AppLayout> now renders <Sidebar> which issues TanStack queries for
// `project:list` and `workspace:list`. We wrap renders in <Providers> (which supplies
// the QueryClientProvider) and make the `invoke` stub dispatch per-channel so both the
// IPC-health check AND the sidebar queries resolve correctly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { AppLayout } from '@renderer/app/AppLayout';
import { Providers } from '@renderer/app/providers';

/** Minimal shape of the bits of `window.api` the renderer touches in Phase 1. */
interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

/**
 * Install a stubbed `window.api`.
 *
 * The `invoke` mock dispatches on channel so:
 *   - 'app:ping'        → 'ok'   (IpcHealth)
 *   - 'project:list'    → []     (Sidebar ProjectSwitcher)
 *   - 'workspace:list'  → []     (Sidebar workspace list)
 *
 * A custom override factory can be passed to make specific channels resolve
 * differently (used by the error-path tests).
 */
function installApi(
  invokeFactory: (channel: string) => unknown = () => undefined,
): ApiStub {
  const invoke = vi.fn((channel: string, _req?: unknown) => {
    if (channel === 'app:ping') return Promise.resolve('ok');
    if (channel === 'project:list') return Promise.resolve([]);
    if (channel === 'workspace:list') return Promise.resolve([]);
    return Promise.resolve(invokeFactory(channel));
  });
  const api: ApiStub = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => Promise.resolve()),
  };
  // The renderer reads `window.api` (declared `readonly` in the ambient d.ts, so cast).
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('AppLayout structure', () => {
  beforeEach(() => {
    installApi();
  });

  it('renders the three-pane layout and both placeholder panes', async () => {
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
    expect(
      screen.getByText('Select a workspace to begin.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Context panel')).toBeInTheDocument();
    // Let the IpcHealth mount effect settle so its state update is inside act(...).
    await waitFor(() => {
      expect(screen.getByTestId('ipc-health')).toHaveAttribute(
        'data-state',
        'ok',
      );
    });
  });
});

describe('IPC health indicator', () => {
  it('starts pending, then flips to the ok state when app:ping resolves "ok"', async () => {
    const api = installApi();

    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    // Immediately after mount the effect is in flight → pending.
    const health = screen.getByTestId('ipc-health');
    expect(health).toHaveAttribute('data-state', 'pending');

    // Once the promise resolves, the dot flips to ok ("IPC OK").
    await waitFor(() => {
      expect(screen.getByTestId('ipc-health')).toHaveAttribute(
        'data-state',
        'ok',
      );
    });
    expect(screen.getByText('IPC OK')).toBeInTheDocument();

    // It called through the funnel with the frozen channel + void arg.
    expect(api.invoke).toHaveBeenCalledWith('app:ping', undefined);
  });

  it('flips to the error state when app:ping rejects', async () => {
    // Override just app:ping to reject; other channels still resolve happily.
    const invoke = vi.fn((channel: string, _req?: unknown) => {
      if (channel === 'app:ping')
        return Promise.reject(new Error('no main process'));
      if (channel === 'project:list') return Promise.resolve([]);
      if (channel === 'workspace:list') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const api: ApiStub = {
      invoke,
      on: vi.fn(() => () => {}),
      stream: vi.fn(() => Promise.resolve()),
    };
    (window as unknown as { api: ApiStub }).api = api;

    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('ipc-health')).toHaveAttribute(
        'data-state',
        'error',
      );
    });
    expect(screen.getByText('IPC error')).toBeInTheDocument();
  });

  it('treats an unexpected (non-"ok") response as an error', async () => {
    const invoke = vi.fn((channel: string, _req?: unknown) => {
      if (channel === 'app:ping') return Promise.resolve('pong');
      if (channel === 'project:list') return Promise.resolve([]);
      if (channel === 'workspace:list') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const api: ApiStub = {
      invoke,
      on: vi.fn(() => () => {}),
      stream: vi.fn(() => Promise.resolve()),
    };
    (window as unknown as { api: ApiStub }).api = api;

    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('ipc-health')).toHaveAttribute(
        'data-state',
        'error',
      );
    });
  });
});
