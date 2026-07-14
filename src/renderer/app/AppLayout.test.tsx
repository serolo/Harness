// Renderer AppLayout structure and adjustable pane interactions.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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
  window.localStorage.clear();
  delete (window as unknown as { api?: unknown }).api;
});

describe('AppLayout structure', () => {
  beforeEach(() => {
    installApi();
  });

  it('renders the three-pane layout and both placeholder panes', () => {
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
    expect(screen.getByTestId('center-pane')).toContainElement(
      screen.getByTestId('workspace-title'),
    );
    expect(
      screen.getByText('Select a workspace to begin.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Context panel')).toBeInTheDocument();
    expect(screen.queryByTestId('ipc-health')).not.toBeInTheDocument();
  });

  it('toggles the left and right panes independently while preserving the center', () => {
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    expect(screen.getByTestId('left-pane')).toBeInTheDocument();
    expect(screen.getByTestId('right-pane')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle-left-pane'));
    expect(screen.queryByTestId('left-pane')).not.toBeInTheDocument();
    expect(screen.getByTestId('right-pane')).toBeInTheDocument();
    expect(screen.getByTestId('center-pane')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle-right-pane'));
    expect(screen.queryByTestId('right-pane')).not.toBeInTheDocument();
    expect(screen.getByTestId('center-pane')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle-left-pane'));
    fireEvent.click(screen.getByTestId('toggle-right-pane'));
    expect(screen.getByTestId('left-pane')).toBeInTheDocument();
    expect(screen.getByTestId('right-pane')).toBeInTheDocument();
  });

  it('resizes both side panes by drag or accessible keyboard dividers', () => {
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    expect(screen.getByTestId('left-pane')).toHaveStyle({ width: '280px' });
    fireEvent.keyDown(screen.getByTestId('left-resize-handle'), {
      key: 'ArrowRight',
    });
    expect(screen.getByTestId('left-pane')).toHaveStyle({ width: '296px' });
    fireEvent.mouseDown(screen.getByTestId('left-resize-handle'), {
      clientX: 296,
    });
    fireEvent.mouseMove(window, { clientX: 340 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('left-pane')).toHaveStyle({ width: '340px' });

    expect(screen.getByTestId('right-pane')).toHaveStyle({ width: '360px' });
    fireEvent.keyDown(screen.getByTestId('right-resize-handle'), {
      key: 'ArrowLeft',
    });
    expect(screen.getByTestId('right-pane')).toHaveStyle({ width: '376px' });
  });
});
