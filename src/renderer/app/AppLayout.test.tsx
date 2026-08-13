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

  it('renders the three-pane layout with chat, Git changes, and terminal placeholders', () => {
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
    expect(screen.getByTestId('center-pane')).toContainElement(
      screen.getByTestId('workspace-title'),
    );
    expect(screen.getByTestId('center-pane')).toHaveClass('min-w-[560px]');
    expect(screen.getByTestId('left-pane')).toHaveClass(
      'min-w-[240px]',
      'shrink-0',
    );
    expect(screen.getByTestId('right-pane')).toHaveClass(
      'min-w-[240px]',
      'shrink-0',
    );
    expect(
      screen.getByText('Select a workspace to begin.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Select a workspace to view its diff.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Select a workspace to view its tasks.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Select a workspace to open a terminal.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Context panel')).not.toBeInTheDocument();
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
    fireEvent.mouseDown(screen.getByTestId('left-resize-handle'), {
      clientX: 340,
    });
    fireEvent.mouseMove(window, { clientX: 700 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('left-pane')).toHaveStyle({ width: '700px' });

    expect(screen.getByTestId('right-pane')).toHaveStyle({ width: '360px' });
    fireEvent.keyDown(screen.getByTestId('right-resize-handle'), {
      key: 'ArrowLeft',
    });
    expect(screen.getByTestId('right-pane')).toHaveStyle({ width: '376px' });
  });

  it('stops a side-pane resize when the center reaches its minimum width', () => {
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    vi.spyOn(
      screen.getByTestId('left-pane'),
      'getBoundingClientRect',
    ).mockReturnValue({ width: 280 } as DOMRect);
    vi.spyOn(
      screen.getByTestId('center-pane'),
      'getBoundingClientRect',
    ).mockReturnValue({ width: 600 } as DOMRect);

    fireEvent.mouseDown(screen.getByTestId('left-resize-handle'), {
      clientX: 280,
    });
    fireEvent.mouseMove(window, { clientX: 500 });
    fireEvent.mouseUp(window);

    expect(screen.getByTestId('left-pane')).toHaveStyle({ width: '320px' });
    expect(screen.getByTestId('center-pane')).toHaveClass('min-w-[560px]');
    expect(screen.getByTestId('right-pane')).toHaveStyle({ width: '360px' });
  });

  it('resizes the stacked Git, tasks, and terminal work panes', () => {
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    expect(screen.getByTestId('right-git-pane')).toHaveClass(
      'flex-1',
      'basis-0',
    );
    expect(screen.getByTestId('right-tasks-pane')).toHaveClass(
      'flex-1',
      'basis-0',
    );
    expect(screen.getByTestId('right-terminal-pane')).toHaveClass(
      'flex-1',
      'basis-0',
    );
    vi.spyOn(
      screen.getByTestId('right-terminal-pane'),
      'getBoundingClientRect',
    ).mockReturnValue({ height: 180 } as DOMRect);
    fireEvent.keyDown(screen.getByTestId('tasks-resize-handle'), {
      key: 'ArrowUp',
    });
    expect(screen.getByTestId('right-tasks-pane')).toHaveStyle({
      height: '240px',
    });
    expect(screen.getByTestId('right-terminal-pane')).toHaveStyle({
      height: '180px',
    });
    expect(screen.getByTestId('right-terminal-pane')).toHaveClass('shrink-0');
    fireEvent.mouseDown(screen.getByTestId('tasks-resize-handle'), {
      clientY: 240,
    });
    fireEvent.mouseMove(window, { clientY: 200 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('right-tasks-pane')).toHaveStyle({
      height: '280px',
    });
    fireEvent.mouseDown(screen.getByTestId('tasks-resize-handle'), {
      clientY: 280,
    });
    fireEvent.mouseMove(window, { clientY: -320 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('right-tasks-pane')).toHaveStyle({
      height: '880px',
    });

    fireEvent.keyDown(screen.getByTestId('terminal-resize-handle'), {
      key: 'ArrowDown',
    });
    expect(screen.getByTestId('right-terminal-pane')).toHaveStyle({
      height: '164px',
    });
  });
});
