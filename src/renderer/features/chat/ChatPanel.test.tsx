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
              id: 'e0',
              turnId: 't1',
              kind: 'user_message',
              ts: 0,
              event: { kind: 'user_message', text: 'Please inspect this' },
            },
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
    const userMessage = screen.getByTestId('chat-user-message');
    expect(userMessage).toHaveTextContent('Please inspect this');
    expect(userMessage).toHaveClass('justify-end');
    expect(screen.getByTestId('tool-card')).toBeInTheDocument();
    expect(screen.getByTestId('todo-list')).toBeInTheDocument();
    const divider = screen.getByTestId('turn-divider');
    expect(divider).toHaveAttribute('data-status', 'completed');
  });

  it('renders semantic tool summaries with expandable command output', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-tool-detail',
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
              id: 'tool-use',
              turnId: 't-tool-detail',
              kind: 'tool_use',
              ts: 1,
              event: {
                kind: 'tool_use',
                name: 'Bash',
                input: {
                  command: 'git status --short',
                  description: 'Check repository status',
                },
              },
            },
            {
              id: 'tool-result',
              turnId: 't-tool-detail',
              kind: 'tool_result',
              ts: 2,
              event: {
                kind: 'tool_result',
                output: 'M src/renderer/features/chat/ToolCard.tsx',
              },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    const tool = await screen.findByTestId('tool-card');
    expect(tool).toHaveAttribute('data-tool-kind', 'command');
    expect(tool).toHaveTextContent('Check repository status');
    expect(tool).toHaveTextContent('git status --short');
    expect(
      screen.queryByText('M src/renderer/features/chat/ToolCard.tsx'),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /check repository status/i }),
    );
    expect(screen.getByTestId('tool-card-detail')).toHaveTextContent(
      'M src/renderer/features/chat/ToolCard.tsx',
    );
  });

  it('renders model questions and permission prompts as different UI', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-interactions',
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
              id: 'q1',
              turnId: 't-interactions',
              kind: 'question_request',
              ts: 1,
              event: {
                kind: 'question_request',
                questions: [
                  {
                    header: 'Framework',
                    question: 'Which framework should I use?',
                    options: [
                      { label: 'React', description: 'Use components' },
                    ],
                  },
                ],
              },
            },
            {
              id: 'p1',
              turnId: 't-interactions',
              kind: 'permission_request',
              ts: 2,
              event: {
                kind: 'permission_request',
                title: 'Allow package publishing?',
                description: 'This writes to an external registry.',
                toolName: 'command_execution',
                input: { command: 'npm publish' },
              },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    expect(await screen.findByTestId('question-card')).toHaveTextContent(
      'Which framework should I use?',
    );
    expect(screen.getByTestId('question-card')).toHaveTextContent('React');
    expect(screen.getByTestId('permission-card')).toHaveTextContent(
      'Allow package publishing?',
    );
    expect(screen.queryAllByTestId('tool-card')).toHaveLength(0);

    fireEvent.click(screen.getByText('Review requested action'));
    expect(screen.getByText(/npm publish/)).toBeInTheDocument();
  });

  it('hides tool results and turns blocked results into permission UI', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-results',
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
              id: 'result-success',
              turnId: 't-results',
              kind: 'tool_result',
              ts: 1,
              event: {
                kind: 'tool_result',
                output: 'internal command output that should stay hidden',
              },
            },
            {
              id: 'result-blocked',
              turnId: 't-results',
              kind: 'tool_result',
              ts: 2,
              event: {
                kind: 'tool_result',
                output:
                  "cat in '/Users/me/.claude/plans/example.md' was blocked. For security, Claude Code requires approval before reading this file.",
              },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    const permission = await screen.findByTestId('permission-card');
    expect(permission).toHaveTextContent('File access requires approval');
    expect(permission).toHaveTextContent(
      "cat in '/Users/me/.claude/plans/example.md'",
    );
    expect(screen.queryByText('tool result')).not.toBeInTheDocument();
    expect(
      screen.queryByText('internal command output that should stay hidden'),
    ).not.toBeInTheDocument();
  });

  it('collapses earlier model messages and activity while keeping the latest response visible', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-model-activity',
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
              id: 'm1',
              turnId: 't-model-activity',
              kind: 'text',
              ts: 1,
              event: { kind: 'text', delta: 'I will inspect the renderer.' },
            },
            {
              id: 'tool-1',
              turnId: 't-model-activity',
              kind: 'tool_use',
              ts: 2,
              event: {
                kind: 'tool_use',
                name: 'Read',
                input: { path: 'Transcript.tsx' },
              },
            },
            {
              id: 'm2',
              turnId: 't-model-activity',
              kind: 'text',
              ts: 3,
              event: { kind: 'text', delta: 'The renderer is now updated.' },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    const activity = await screen.findByTestId('model-activity');
    expect(activity).toHaveTextContent('1 tool call, 1 message');
    expect(
      screen.queryByText('I will inspect the renderer.'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('The renderer is now updated.'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /1 tool call, 1 message/i }),
    );
    expect(
      screen.getByText('I will inspect the renderer.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('tool-card')).toBeInTheDocument();
  });

  it('does not add a disclosure around a single model message', async () => {
    const history: ChatHistory = {
      turns: [
        {
          id: 't-single-message',
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
              id: 'm1',
              turnId: 't-single-message',
              kind: 'text',
              ts: 1,
              event: { kind: 'text', delta: 'Only one response.' },
            },
          ],
        },
      ],
    };
    installApi({ history });

    render(<ChatPanel workspaceId="ws1" />);

    const response = await screen.findByText('Only one response.');
    expect(response).toBeInTheDocument();
    expect(response).toHaveClass('text-md');
    expect(screen.queryByTestId('model-activity')).not.toBeInTheDocument();
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

    expect(await screen.findByTestId('chat-user-message')).toHaveTextContent(
      'hi there',
    );
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

  it('shows a pre-start stream error instead of dropping it', async () => {
    const stream = vi.fn(() =>
      Promise.reject(new Error('claude not available')),
    );
    installApi({ stream });

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'work' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    expect(await screen.findByText('claude not available')).toBeInTheDocument();
    expect(screen.getByTestId('turn-divider')).toHaveAttribute(
      'data-status',
      'error',
    );
  });

  it('shows configured skills when typing slash and inserts the selected command', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '/' } });

    expect(await screen.findByTestId('slash-menu')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('slash-command-review'));

    expect(input).toHaveValue('/review ');
  });

  it('clears chat from /clear without starting a model turn', async () => {
    const api = installApi({
      slashCommands: [
        {
          name: 'clear',
          template: 'Clear the current chat transcript and context.',
          description: 'Clear chat history and context',
        },
      ],
    });

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

  it('shows the provider model catalogue instead of harness names', async () => {
    installApi({});

    render(<ChatPanel workspaceId="ws1" />);
    fireEvent.click(await screen.findByTestId('composer-model'));

    expect(
      await screen.findByTestId('composer-model-claude_code'),
    ).toHaveTextContent('Claude Code');
    expect(
      screen.getByTestId('composer-model-option-claude-fable-5'),
    ).toHaveTextContent('Fable 5');
    expect(
      screen.getByTestId('composer-model-option-claude-opus-4-8-1m'),
    ).toHaveTextContent('Opus 4.8 1M');
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
  });
});
