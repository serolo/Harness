import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Events } from '@shared/ipc';
import { useChatStore } from '@renderer/stores/chat';
import { useChat } from './useChat';

beforeEach(() => {
  useChatStore.setState({
    byWorkspace: {},
    busyByWorkspace: {},
    taskTurnsByWorkspace: {},
  });
});

it('receives post-stream extraction over the bridge, scopes it, and unsubscribes', async () => {
  let receive:
    ((payload: Events['knowledge:extractionCompleted']) => void) | undefined;
  const unsubscribe = vi.fn();
  const invoke = vi.fn().mockResolvedValue({ turns: [] });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      invoke,
      on: (channel: string, callback: typeof receive) => {
        if (channel === 'knowledge:extractionCompleted') {
          receive = callback;
          return unsubscribe;
        }
        return vi.fn();
      },
      stream: vi.fn(),
    },
  });
  const { unmount } = renderHook(() => useChat('ws'));
  await waitFor(() =>
    expect(useChatStore.getState().byWorkspace.ws).toEqual([]),
  );
  act(() => {
    useChatStore.getState().startTurn('ws', 'turn', 'session');
    useChatStore.getState().endTurn('ws', 'completed');
  });
  const event: Events['knowledge:extractionCompleted']['event'] = {
    kind: 'knowledge_extraction',
    status: 'failed',
    proposalCount: 0,
    rejectedCount: 1,
  };
  act(() => receive?.({ workspaceId: 'other', turnId: 'turn', event }));
  expect(useChatStore.getState().byWorkspace.ws?.[0]?.events).toEqual([]);
  act(() => receive?.({ workspaceId: 'ws', turnId: 'turn', event }));
  expect(useChatStore.getState().byWorkspace.ws?.[0]?.events).toEqual([event]);
  expect(useChatStore.getState().byWorkspace.ws?.[0]?.status).toBe('completed');
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
