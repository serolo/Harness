// Renderer: AppLayout renders + the IPC health indicator reflects the app:ping result.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AppLayout } from '@renderer/app/AppLayout';
import { Providers } from '@renderer/app/providers';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

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
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('AppLayout structure', () => {
  beforeEach(() => {
    installApi();
  });

  it('keeps chat in the center and stacks work panes on the right', async () => {
    render(
      <Providers>
        <AppLayout />
      </Providers>,
    );

    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
    expect(screen.getByTestId('center-pane')).toContainElement(
      screen.getByText('Select a workspace to begin.'),
    );
    expect(screen.queryByTestId('center-tabs')).not.toBeInTheDocument();
    expect(screen.getByTestId('right-git-pane')).toContainElement(
      screen.getByTestId('diff-empty'),
    );
    expect(screen.getByTestId('right-terminal-pane')).toContainElement(
      screen.getByTestId('terminal-empty'),
    );
    await waitFor(() => {
      expect(screen.getByTestId('ipc-health')).toHaveAttribute(
        'data-state',
        'ok',
      );
    });
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

    expect(screen.getByTestId('right-pane')).toHaveStyle({ width: '640px' });
    fireEvent.keyDown(screen.getByTestId('right-resize-handle'), {
      key: 'ArrowLeft',
    });
    expect(screen.getByTestId('right-pane')).toHaveStyle({ width: '656px' });
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

    expect(screen.getByTestId('ipc-health')).toHaveAttribute(
      'data-state',
      'pending',
    );
    await waitFor(() => {
      expect(screen.getByTestId('ipc-health')).toHaveAttribute(
        'data-state',
        'ok',
      );
    });
    expect(screen.getByText('IPC OK')).toBeInTheDocument();
    expect(api.invoke).toHaveBeenCalledWith('app:ping', undefined);
  });

  it('flips to the error state when app:ping rejects', async () => {
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

  it('treats an unexpected response as an error', async () => {
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
