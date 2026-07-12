// ChatPanel: reconstruction from chat:history, live streaming over turn:start, and
// interrupt (Phase 2, Task 9). Runs under jsdom with a stubbed `window.api` — the ONLY
// main-process access point — so the real @renderer/ipc funnel + real components run.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ChatPanel } from './ChatPanel';
import { useChatStore } from '@renderer/stores/chat';
import type { ChatHistory, HarnessInfo, TurnStreamChunk } from '@shared/ipc';
import type { SlashCommand } from '@shared/slash';

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
      supportsMidTurnSteer: false,
    },
    detect: { installed: true, authenticated: true },
  },
];

function installApi(opts: {
  history?: ChatHistory;
  stream?: ApiStub['stream'];
  slashCommands?: SlashCommand[];
}): ApiStub {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'chat:history')
      return Promise.resolve(opts.history ?? { turns: [] });
    if (channel === 'harness:list') return Promise.resolve(HARNESS_LIST);
    if (channel === 'turn:interrupt') return Promise.resolve(undefined);
    if (channel === 'chat:clear') return Promise.resolve(undefined);
    if (channel === 'slash:list')
      return Promise.resolve(
        opts.slashCommands ?? [
          {
            name: 'review',
            template: 'Review the current changes.',
            description: 'Review current changes',
          },
          {
            name: 'fix-checks',
            template: 'Fix checks\n\n$ARGS',
            description: 'Investigate failing checks',
          },
        ],
      );
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
    const activity = screen.getByTestId('turn-activity');
    expect(activity).toHaveAttribute('data-status', 'completed');
    expect(screen.getByTestId('turn-elapsed')).toHaveTextContent('0.0s');
  });

  it('clears the visible transcript for the current workspace', async () => {
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
          inputTokens: null,
          outputTokens: null,
          events: [
            {
              id: 'e1',
              turnId: 't1',
              kind: 'text',
              ts: 1,
              event: { kind: 'text', delta: 'Clear me' },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    expect(await screen.findByText('Clear me')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-clear'));

    await waitFor(() =>
      expect(screen.queryByText('Clear me')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('turn-activity')).not.toBeInTheDocument();
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
      expect(screen.getByTestId('turn-activity')).toHaveAttribute(
        'data-status',
        'completed',
      ),
    );
    expect(screen.getByTestId('turn-prompt')).toHaveTextContent('hi there');
  });

  it('sends the typed prompt when Enter is pressed in the composer', async () => {
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        onChunk: (c: TurnStreamChunk) => void,
      ) => {
        onChunk({ kind: 'started', turnId: 't-enter', sessionId: 'sess-enter' });
        onChunk({ kind: 'event', event: { kind: 'turn_end', usage: {} } });
        return Promise.resolve();
      },
    );
    installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'send from enter' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: false });

    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(stream.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        prompt: 'send from enter',
      }),
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

  it('shows a pre-start stream error instead of dropping it', async () => {
    const stream = vi.fn(() =>
      Promise.reject(new Error('claude not available')),
    );
    installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'work' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    expect(await screen.findByTestId('error-card')).toHaveTextContent(
      'claude not available',
    );
    expect(screen.getByTestId('turn-activity')).toHaveAttribute(
      'data-status',
      'error',
    );
  });

  it('shows configured skills when typing slash and inserts the selected skill name', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/' } });

    expect(await screen.findByTestId('slash-menu')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('slash-command-review'));

    expect(input).toHaveValue('/review ');
  });

  it('clears chat from /clear without starting a model turn', async () => {
    const api = installApi({});

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/clear' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: false });

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('chat:clear', {
        workspaceId: 'ws1',
      }),
    );
    expect(api.stream).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it('opens context usage details from the context button', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);

    fireEvent.click(await screen.findByTestId('composer-context-usage'));

    expect(await screen.findByTestId('composer-context-popover')).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('Free space')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Skills')).toBeInTheDocument();
  });

  it('expands slash commands with args before starting a turn', async () => {
    const stream = vi.fn(
      (
        _channel: string,
        _arg: unknown,
        _onChunk: (c: TurnStreamChunk) => void,
      ) => Promise.resolve(),
    );
    const api = installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'slash:list',
        expect.objectContaining({ workspaceId: 'ws1' }),
      ),
    );
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/fix-checks rerun CI' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(stream.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        prompt: 'Fix checks\n\nrerun CI',
      }),
    );
    expect(screen.getByTestId('turn-prompt')).toHaveTextContent(
      '/fix-checks rerun CI',
    );
  });
});
