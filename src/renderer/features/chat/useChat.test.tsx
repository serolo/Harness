// useChat (Phase 9 follow-up) — direct unit coverage for the highest-risk piece of the
// steer/queue state machine: `sendTurn`'s `finally` → `flushQueueHead` auto-flush, and
// `steer`'s three-way branch (true injection / rejected-falls-through / non-steerable
// fallback). Code-review + verifier flagged this hook had NO direct test — the E2E
// (e2e/queue-steer.spec.ts) hand-rolls the IPC sequence instead of driving the hook, so a
// regression in the refs-based orchestration (`sendTurnRef`/`turnDoneRef`/
// `steerPendingRef`) would slip through. Mirrors ChatPanel.test.tsx / harness.test.ts's
// jsdom + stubbed-boundary style, but stubs the `@renderer/ipc` funnel directly (via
// `vi.mock`) rather than `window.api`, and controls `useSelectedHarnessCapabilities`
// directly (via `vi.mock('@renderer/stores/harness')`) so capability + busy state are
// asserted deterministically without a live harness:list round trip.
//
// `subscribeStream` is faked as a controllable per-call promise: each call is captured
// (channel/arg/onChunk) and the test drives it explicitly (`onChunk` for each frame, then
// `resolve()`/`reject()` to end the stream) — this is what lets a test assert ordering
// (e.g. "queue:remove happens before the resend's turn:start") deterministically.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type {
  Attachment,
  AgentMode,
  HarnessCapabilities,
} from '@shared/harness';
import type { QueuedMessage } from '@shared/queue';
import { useChatStore } from '@renderer/stores/chat';
import { useQueueStore } from '@renderer/stores/queue';
import { useSelectedHarnessCapabilities } from '@renderer/stores/harness';
import { invoke, subscribeStream } from '@renderer/ipc';
import { useChat } from './useChat';

vi.mock('@renderer/ipc', () => ({
  invoke: vi.fn(),
  subscribeStream: vi.fn(),
}));

vi.mock('@renderer/stores/harness', () => ({
  useSelectedHarnessCapabilities: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const subscribeStreamMock = vi.mocked(subscribeStream);
const capsMock = vi.mocked(useSelectedHarnessCapabilities);

const WS = 'ws1';

function caps(overrides: Partial<HarnessCapabilities>): HarnessCapabilities {
  return {
    supportsResume: true,
    supportsMcp: true,
    supportsPlanMode: true,
    rawTerminalFallback: true,
    supportsMidTurnSteer: false,
    ...overrides,
  };
}

/** One captured `subscribeStream('turn:start', arg, onChunk)` call, driveable by the test. */
interface StreamCall {
  arg: {
    workspaceId: string;
    prompt: string;
    attachments: Attachment[];
    mode?: AgentMode;
  };
  onChunk: (chunk: unknown) => void;
  resolve: () => void;
  reject: (err: unknown) => void;
}

let streamCalls: StreamCall[];
/** In-memory `queued_messages` fake — mirrors the DB-authoritative round trip. */
let queueRows: QueuedMessage[];

function seedQueue(rows: QueuedMessage[]): void {
  queueRows = rows.map((r) => ({ ...r }));
  useQueueStore.setState({
    byWorkspace: { [WS]: queueRows.map((r) => ({ ...r })) },
  });
}

function listQueue(workspaceId: string): QueuedMessage[] {
  return queueRows
    .filter((r) => r.workspaceId === workspaceId)
    .sort((a, b) => a.orderIdx - b.orderIdx)
    .map((r) => ({ ...r }));
}

/** `turn:steer`'s scripted response for this test; overridden per-case. */
let steerImpl: (req: {
  workspaceId: string;
  text: string;
}) => Promise<'injected' | 'rejected'>;

beforeEach(() => {
  streamCalls = [];
  queueRows = [];
  useChatStore.setState({ byWorkspace: {}, busyByWorkspace: {} });
  useQueueStore.setState({ byWorkspace: {} });
  steerImpl = () =>
    Promise.reject(new Error('steer not configured for this test'));

  subscribeStreamMock.mockImplementation((_channel, arg, onChunk) => {
    return new Promise<void>((resolve, reject) => {
      streamCalls.push({
        arg: arg as StreamCall['arg'],
        onChunk: onChunk as StreamCall['onChunk'],
        resolve,
        reject,
      });
    });
  });

  invokeMock.mockImplementation((channel: string, req: unknown) => {
    switch (channel) {
      case 'chat:history':
        return Promise.resolve({ turns: [] });
      case 'turn:interrupt':
        return Promise.resolve(undefined);
      case 'turn:steer':
        return steerImpl(req as { workspaceId: string; text: string });
      case 'queue:remove': {
        const { id } = req as { id: string };
        queueRows = queueRows.filter((r) => r.id !== id);
        return Promise.resolve(undefined);
      }
      case 'queue:list': {
        const { workspaceId } = req as { workspaceId: string };
        return Promise.resolve(listQueue(workspaceId));
      }
      default:
        return Promise.resolve(undefined);
    }
  });

  capsMock.mockReturnValue(caps({}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useChat auto-flush on idle (flushQueueHead)', () => {
  it('sends the queue head first, removes it before resending, and advances one at a time', async () => {
    seedQueue([
      {
        id: 'q1',
        workspaceId: WS,
        prompt: 'second msg',
        attachments: [],
        orderIdx: 0,
        createdAt: 1,
      },
      {
        id: 'q2',
        workspaceId: WS,
        prompt: 'third msg',
        attachments: [],
        orderIdx: 1,
        createdAt: 2,
      },
    ]);
    const { result } = renderHook(() => useChat(WS));

    // The user's own turn (not from the queue) — call 0.
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendTurn('first msg', []);
    });
    await waitFor(() => expect(streamCalls).toHaveLength(1));
    expect(streamCalls[0].arg.prompt).toBe('first msg');

    // Finish turn 0 → its `finally` should auto-flush exactly the queue HEAD (q1), not
    // both queued messages at once.
    act(() => {
      streamCalls[0].onChunk({
        kind: 'started',
        turnId: 't1',
        sessionId: 's1',
      });
      streamCalls[0].onChunk({
        kind: 'event',
        event: { kind: 'turn_end', usage: {} },
      });
      streamCalls[0].resolve();
    });
    await act(async () => {
      await sendPromise;
    });

    await waitFor(() => expect(streamCalls).toHaveLength(2));
    expect(streamCalls[1].arg.prompt).toBe('second msg');
    // The head was removed from the DB-backed cache BEFORE the resend fired.
    expect(useQueueStore.getState().byWorkspace[WS].map((m) => m.id)).toEqual([
      'q2',
    ]);
    // Only ONE flush happened for this idle transition — the third message hasn't sent yet.
    expect(streamCalls).toHaveLength(2);

    // Finish turn 1 (the flushed head) → should flush the NEXT head (q2), in order.
    act(() => {
      streamCalls[1].onChunk({
        kind: 'started',
        turnId: 't2',
        sessionId: 's2',
      });
      streamCalls[1].onChunk({
        kind: 'event',
        event: { kind: 'turn_end', usage: {} },
      });
      streamCalls[1].resolve();
    });

    await waitFor(() => expect(streamCalls).toHaveLength(3));
    expect(streamCalls[2].arg.prompt).toBe('third msg');
    expect(useQueueStore.getState().byWorkspace[WS]).toEqual([]);

    // Drain the last turn so no promise is left dangling into the next test.
    act(() => {
      streamCalls[2].onChunk({
        kind: 'started',
        turnId: 't3',
        sessionId: 's3',
      });
      streamCalls[2].onChunk({
        kind: 'event',
        event: { kind: 'turn_end', usage: {} },
      });
      streamCalls[2].resolve();
    });
    await waitFor(() =>
      expect(useChatStore.getState().busyByWorkspace[WS]).toBe(false),
    );
  });
});

describe('useChat.steer — true injection', () => {
  it('short-circuits: calls turn:steer only, no interrupt, no new turn', async () => {
    capsMock.mockReturnValue(caps({ supportsMidTurnSteer: true }));
    steerImpl = () => Promise.resolve('injected');
    useChatStore.setState({ busyByWorkspace: { [WS]: true } });

    const { result } = renderHook(() => useChat(WS));
    await act(async () => {
      await result.current.steer('go');
    });

    expect(invokeMock).toHaveBeenCalledWith('turn:steer', {
      workspaceId: WS,
      text: 'go',
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      'turn:interrupt',
      expect.anything(),
    );
    expect(subscribeStreamMock).not.toHaveBeenCalled();
  });
});

describe('useChat.steer — "rejected" falls through to the fallback', () => {
  it('interrupts, waits for the turn to finalize, then resends', async () => {
    capsMock.mockReturnValue(caps({ supportsMidTurnSteer: true }));
    steerImpl = () => Promise.resolve('rejected');

    const { result } = renderHook(() => useChat(WS));

    // A real in-flight turn so `turnDoneRef` has something to wait on.
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendTurn('original work', []);
    });
    await waitFor(() => expect(streamCalls).toHaveLength(1));
    act(() => {
      streamCalls[0].onChunk({
        kind: 'started',
        turnId: 't1',
        sessionId: 's1',
      });
    });
    expect(useChatStore.getState().busyByWorkspace[WS]).toBe(true);

    let steerPromise!: Promise<void>;
    act(() => {
      steerPromise = result.current.steer('go');
    });

    // `turn:steer` resolves 'rejected' → falls through → busy → fallback calls
    // turn:interrupt and then blocks on the still-open turn.
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('turn:interrupt', {
        workspaceId: WS,
      }),
    );
    // No resend yet — still waiting on the interrupted turn to finalize.
    expect(streamCalls).toHaveLength(1);

    // Simulate the interrupt taking effect: the live turn's terminal frame lands.
    act(() => {
      streamCalls[0].onChunk({
        kind: 'event',
        event: { kind: 'turn_end', usage: {} },
      });
      streamCalls[0].resolve();
    });
    await act(async () => {
      await sendPromise;
    });

    // NOW the fallback resends as a brand-new turn.
    await waitFor(() => expect(streamCalls).toHaveLength(2));
    expect(streamCalls[1].arg.prompt).toBe('go');

    act(() => {
      streamCalls[1].onChunk({
        kind: 'started',
        turnId: 't2',
        sessionId: 's2',
      });
      streamCalls[1].onChunk({
        kind: 'event',
        event: { kind: 'turn_end', usage: {} },
      });
      streamCalls[1].resolve();
    });
    await act(async () => {
      await steerPromise;
    });

    expect(invokeMock).toHaveBeenCalledWith('turn:steer', {
      workspaceId: WS,
      text: 'go',
    });
    expect(invokeMock).toHaveBeenCalledWith('turn:interrupt', {
      workspaceId: WS,
    });
  });
});

describe('useChat.steer — non-steerable fallback preserves attachments/mode', () => {
  it('interrupts then resends carrying the SAME attachments and mode (not defaults)', async () => {
    capsMock.mockReturnValue(caps({ supportsMidTurnSteer: false }));
    const { result } = renderHook(() => useChat(WS));

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendTurn('original work', []);
    });
    await waitFor(() => expect(streamCalls).toHaveLength(1));
    act(() => {
      streamCalls[0].onChunk({
        kind: 'started',
        turnId: 't1',
        sessionId: 's1',
      });
    });

    const attachments: Attachment[] = [{ type: 'file', path: 'a.ts' }];
    let steerPromise!: Promise<void>;
    act(() => {
      steerPromise = result.current.steer('go', attachments, 'plan');
    });

    // Non-steerable harness: turn:steer is never even attempted.
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('turn:interrupt', {
        workspaceId: WS,
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      'turn:steer',
      expect.anything(),
    );

    act(() => {
      streamCalls[0].onChunk({
        kind: 'event',
        event: { kind: 'turn_end', usage: {} },
      });
      streamCalls[0].resolve();
    });
    await act(async () => {
      await sendPromise;
    });

    await waitFor(() => expect(streamCalls).toHaveLength(2));
    // The resend carries the SAME attachments/mode, not `[]` / the default.
    expect(streamCalls[1].arg.prompt).toBe('go');
    expect(streamCalls[1].arg.attachments).toEqual(attachments);
    expect(streamCalls[1].arg.mode).toBe('plan');

    act(() => {
      streamCalls[1].onChunk({
        kind: 'started',
        turnId: 't2',
        sessionId: 's2',
      });
      streamCalls[1].onChunk({
        kind: 'event',
        event: { kind: 'turn_end', usage: {} },
      });
      streamCalls[1].resolve();
    });
    await act(async () => {
      await steerPromise;
    });
  });
});

describe('useChat.steer — idle, non-steerable', () => {
  it('sends a normal turn:start with attachments/mode and never interrupts', async () => {
    capsMock.mockReturnValue(caps({ supportsMidTurnSteer: false }));
    const { result } = renderHook(() => useChat(WS));
    expect(useChatStore.getState().busyByWorkspace[WS] ?? false).toBe(false);

    const attachments: Attachment[] = [{ type: 'file', path: 'b.ts' }];
    let steerPromise!: Promise<void>;
    act(() => {
      steerPromise = result.current.steer('go', attachments, 'auto_accept');
    });

    await waitFor(() => expect(streamCalls).toHaveLength(1));
    expect(streamCalls[0].arg.prompt).toBe('go');
    expect(streamCalls[0].arg.attachments).toEqual(attachments);
    expect(streamCalls[0].arg.mode).toBe('auto_accept');
    expect(invokeMock).not.toHaveBeenCalledWith(
      'turn:interrupt',
      expect.anything(),
    );

    act(() => {
      streamCalls[0].onChunk({
        kind: 'started',
        turnId: 't1',
        sessionId: 's1',
      });
      streamCalls[0].onChunk({
        kind: 'event',
        event: { kind: 'turn_end', usage: {} },
      });
      streamCalls[0].resolve();
    });
    await act(async () => {
      await steerPromise;
    });
  });
});
