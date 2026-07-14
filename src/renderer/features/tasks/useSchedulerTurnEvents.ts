// useSchedulerTurnEvents — mounted ONCE (in AppLayout). Routes the reserved
// `Events['turn:event']` broadcast (emitted ONLY by the scheduler — see design doc §4.2)
// into the shared `useChatStore`, so a task firing in ANY workspace accumulates in that
// workspace's transcript and is fully visible when the user switches to it.
//
// Only the scheduler emits `turn:event`; user-initiated turns flow over the scoped
// `turn:start` stream (useChat.sendTurn). So there is NO double-render hazard here — this
// hook never sees a user turn.

import { useEffect } from 'react';
import type { Usage } from '@shared/harness';
import { onEvent } from '@renderer/ipc';
import { useChatStore } from '@renderer/stores/chat';

/**
 * Subscribe (once) to `turn:event` and drive the chat store the same way
 * `useChat.sendTurn`'s chunk handler does: a new turnId starts a store turn (+ busy);
 * `turn_end`/`error` finalize it (+ clear busy); everything else appends.
 */
export function useSchedulerTurnEvents(): void {
  useEffect(() => {
    return onEvent('turn:event', ({ workspaceId, turnId, event }) => {
      const store = useChatStore.getState();

      // Start a new store turn the first time we see this turnId for the workspace.
      const turns = store.byWorkspace[workspaceId] ?? [];
      const last = turns[turns.length - 1];
      if (!last || last.turnId !== turnId) {
        store.startTurn(workspaceId, turnId, '');
        store.setBusy(workspaceId, true);
      }

      if (event.kind === 'turn_end') {
        store.endTurn(workspaceId, 'completed', event.usage as Usage);
        store.setBusy(workspaceId, false);
      } else if (event.kind === 'error') {
        store.appendEvent(workspaceId, event);
        store.endTurn(workspaceId, 'error');
        store.setBusy(workspaceId, false);
      } else {
        store.appendEvent(workspaceId, event);
      }
    });
  }, []);
}
