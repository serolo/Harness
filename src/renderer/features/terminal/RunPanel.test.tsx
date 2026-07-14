// RunPanel: lists configured run scripts (run:list), starts one over the run:start stream
// (tailing log frames + showing an exit badge), and stops it (run:stop). Runs under jsdom
// with a stubbed `window.api` — the ONLY main-process access point — so the real
// @renderer/ipc funnel + real components run. Mirrors ChatPanel.test.tsx.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { RunPanel } from './RunPanel';
import type { RunScriptInfo, RunStreamChunk } from '@shared/ipc';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  cancelStream: ReturnType<typeof vi.fn>;
}

function installApi(opts: {
  scripts?: RunScriptInfo[];
  stream?: ApiStub['stream'];
}): ApiStub {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'run:list')
      return Promise.resolve(opts.scripts ?? ([] as RunScriptInfo[]));
    return Promise.resolve(undefined);
  });
  const api: ApiStub = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: opts.stream ?? vi.fn(() => Promise.resolve()),
    cancelStream: vi.fn(),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('RunPanel', () => {
  it('lists configured scripts and shows an empty state when there are none', async () => {
    installApi({ scripts: [] });
    render(<RunPanel workspaceId="ws1" />);
    expect(await screen.findByTestId('run-empty')).toBeInTheDocument();
  });

  it('renders a button per script (icon + label)', async () => {
    installApi({
      scripts: [
        { name: 'dev', label: 'Dev Server', icon: '⚡', running: false },
        { name: 'test', running: false },
      ],
    });
    render(<RunPanel workspaceId="ws1" />);
    expect(await screen.findByText('Dev Server')).toBeInTheDocument();
    // No label → falls back to the script name.
    expect(screen.getByText('test')).toBeInTheDocument();
  });

  it('starts a script: tails log frames and shows an exit badge', async () => {
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: RunStreamChunk) => void,
      ) => {
        onChunk({ kind: 'started', runId: 'r1' });
        onChunk({ kind: 'log', chunk: 'building ' });
        onChunk({ kind: 'log', chunk: 'app…' });
        onChunk({ kind: 'exit', code: 0, durationMs: 1234 });
        return Promise.resolve();
      },
    );
    installApi({
      scripts: [{ name: 'dev', label: 'Dev', running: false }],
      stream,
    });

    render(<RunPanel workspaceId="ws1" />);
    fireEvent.click(await screen.findByTestId('run-start-dev'));

    expect(await screen.findByText(/building app…/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('run-badge-dev')).toHaveTextContent(
        'exit 0 · 1234ms',
      ),
    );
    // The stream was opened for the right script.
    expect(stream).toHaveBeenCalledWith(
      'run:start',
      { workspaceId: 'ws1', scriptName: 'dev' },
      expect.any(Function),
      expect.objectContaining({ id: expect.any(String) }),
    );
  });

  it('shows Stop while running and terminates via run:stop', async () => {
    let resolveStream: (() => void) | undefined;
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: RunStreamChunk) => void,
      ) => {
        onChunk({ kind: 'started', runId: 'r1' });
        onChunk({ kind: 'log', chunk: 'serving…' });
        // Stay open so the run reads as "running".
        return new Promise<void>((resolve) => {
          resolveStream = resolve;
        });
      },
    );
    const api = installApi({
      scripts: [{ name: 'dev', label: 'Dev', running: false }],
      stream,
    });

    render(<RunPanel workspaceId="ws1" />);
    fireEvent.click(await screen.findByTestId('run-start-dev'));

    const stop = await screen.findByTestId('run-stop-dev');
    fireEvent.click(stop);
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('run:stop', {
        workspaceId: 'ws1',
        runId: 'r1',
      }),
    );

    // Clean up the pending stream promise.
    resolveStream?.();
  });
});
