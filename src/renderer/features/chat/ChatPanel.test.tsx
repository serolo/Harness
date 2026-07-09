// ChatPanel: reconstruction from chat:history, live streaming over turn:start, and
// interrupt (Phase 2, Task 9). Runs under jsdom with a stubbed `window.api` — the ONLY
// main-process access point — so the real @renderer/ipc funnel + real components run.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ChatPanel } from './ChatPanel';
import { useChatStore } from '@renderer/stores/chat';
import type { ChatHistory, HarnessInfo, TurnStreamChunk } from '@shared/ipc';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

const HARNESS_LIST: HarnessInfo[] = [
  {
    id: 'claude_code',
    capabilities: {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: true,
      rawTerminalFallback: true,
    },
    detect: { installed: true, authenticated: true },
  },
];

function installApi(opts: {
  history?: ChatHistory;
  stream?: ApiStub['stream'];
}): ApiStub {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'chat:history')
      return Promise.resolve(opts.history ?? { turns: [] });
    if (channel === 'harness:list') return Promise.resolve(HARNESS_LIST);
    if (channel === 'turn:interrupt') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
  const api: ApiStub = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: opts.stream ?? vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

beforeEach(() => {
  useChatStore.setState({ byWorkspace: {}, busyByWorkspace: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('ChatPanel reconstruction', () => {
  it('rebuilds a transcript from chat:history (text, tool card, todo, divider)', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't1',
          workspaceId: 'ws1',
          idx: 0,
          status: 'completed',
          sessionId: 'sess-1',
          mode: 'default',
          startedAt: 1,
          endedAt: 2,
          inputTokens: 10,
          outputTokens: 20,
          events: [
            {
              id: 'e1',
              turnId: 't1',
              kind: 'text',
              ts: 1,
              event: { kind: 'text', delta: 'Hello **world**' },
            },
            {
              id: 'e2',
              turnId: 't1',
              kind: 'tool_use',
              ts: 2,
              event: { kind: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
            },
            {
              id: 'e3',
              turnId: 't1',
              kind: 'todo_update',
              ts: 3,
              event: {
                kind: 'todo_update',
                todos: [
                  { id: '1', body: 'do it', done: false, source: 'agent' },
                ],
              },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    expect(await screen.findByText('world')).toBeInTheDocument();
    expect(screen.getByTestId('tool-card')).toBeInTheDocument();
    expect(screen.getByTestId('todo-list')).toBeInTheDocument();
    const divider = screen.getByTestId('turn-divider');
    expect(divider).toHaveAttribute('data-status', 'completed');
  });
});

describe('ChatPanel streaming', () => {
  it('streams a turn: started + text + turn_end render, then completes', async () => {
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: TurnStreamChunk) => void,
      ) => {
        onChunk({ kind: 'started', turnId: 't1', sessionId: 'sess-1' });
        onChunk({
          kind: 'event',
          event: { kind: 'text', delta: 'Streaming ' },
        });
        onChunk({ kind: 'event', event: { kind: 'text', delta: 'reply' } });
        onChunk({ kind: 'event', event: { kind: 'turn_end', usage: {} } });
        return Promise.resolve();
      },
    );
    installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);

    // Wait for hydration (harness:list + empty history) to settle, then send.
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'hi there' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    expect(await screen.findByText('Streaming reply')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('turn-divider')).toHaveAttribute(
        'data-status',
        'completed',
      ),
    );
  });

  it('shows Stop while busy and interrupts via turn:interrupt', async () => {
    // A stream that emits `started` then never resolves → stays busy.
    let capturedResolve: (() => void) | undefined;
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: TurnStreamChunk) => void,
      ) => {
        onChunk({ kind: 'started', turnId: 't1', sessionId: 's' });
        onChunk({
          kind: 'event',
          event: { kind: 'text', delta: 'thinking…' },
        });
        return new Promise<void>((resolve) => {
          capturedResolve = resolve;
        });
      },
    );
    const api = installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'work' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    // Busy → Stop button shows; clicking it invokes turn:interrupt.
    const stop = await screen.findByTestId('composer-interrupt');
    fireEvent.click(stop);
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('turn:interrupt', {
        workspaceId: 'ws1',
      }),
    );

    // Clean up the pending stream promise.
    capturedResolve?.();
  });
});
