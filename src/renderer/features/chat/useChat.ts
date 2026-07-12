// useChat — the chat feature's data hook. Bridges the FROZEN IPC contract to the
// Zustand chat store: hydrate from `chat:history` on open, stream a turn over
// `turn:start`, and interrupt via `turn:interrupt`. All main access funnels through
// `@renderer/ipc` (README §10) — never `window.api`/`ipcRenderer` directly.

import { useCallback, useEffect, useRef } from 'react';
import type {
  AgentEvent,
  Attachment,
  AgentMode,
  HarnessId,
  Usage,
} from '@shared/harness';
import type { ChatHistory } from '@shared/ipc';
import { invoke, subscribeStream } from '@renderer/ipc';
import { useChatStore, type RenderedTurn } from '@renderer/stores/chat';
import { useQueueStore } from '@renderer/stores/queue';
import { useSelectedHarnessCapabilities } from '@renderer/stores/harness';

/** Stable empty-array reference so the `turns` selector doesn't loop on `?? []`. */
const EMPTY_TURNS: readonly RenderedTurn[] = [];

/** Map a persisted `ChatHistory` into the store's `RenderedTurn[]`. */
function historyToTurns(history: ChatHistory): RenderedTurn[] {
  return history.turns.map((t) => ({
    turnId: t.id,
    status: t.status,
    sessionId: t.sessionId ?? undefined,
    events: t.events.map((e) => e.event),
    usage:
      t.inputTokens != null || t.outputTokens != null
        ? {
            inputTokens: t.inputTokens ?? undefined,
            outputTokens: t.outputTokens ?? undefined,
          }
        : undefined,
  }));
}

export interface UseChat {
  turns: RenderedTurn[];
  isBusy: boolean;
  sendTurn: (
    prompt: string,
    attachments: Attachment[],
    mode?: AgentMode,
    harness?: HarnessId,
  ) => Promise<void>;
  interrupt: () => Promise<void>;
  /**
   * "Steer now": inject `text` into the live turn when the selected harness supports
   * genuine mid-turn injection (`turn:steer`), else degrade to a legible interrupt +
   * resend as a brand-new turn (§3.6). The fallback/resend preserves `attachments`/`mode`
   * (true injection is text-only by the frozen IPC contract). No-op with empty text / no
   * workspace.
   */
  steer: (
    text: string,
    attachments?: Attachment[],
    mode?: AgentMode,
  ) => Promise<void>;
}

/**
 * Chat state + actions for one workspace. Hydrates the transcript on mount / workspace
 * change; `sendTurn` streams a turn and `interrupt` stops it. The stream subscription is
 * aborted on unmount / workspace change so no listener leaks across workspaces.
 */
export function useChat(workspaceId: string | null): UseChat {
  const turns = useChatStore((s) =>
    workspaceId ? (s.byWorkspace[workspaceId] ?? EMPTY_TURNS) : EMPTY_TURNS,
  ) as RenderedTurn[];
  const isBusy = useChatStore((s) =>
    workspaceId ? (s.busyByWorkspace[workspaceId] ?? false) : false,
  );
  const hydrate = useChatStore((s) => s.hydrate);
  const startTurn = useChatStore((s) => s.startTurn);
  const appendEvent = useChatStore((s) => s.appendEvent);
  const endTurn = useChatStore((s) => s.endTurn);
  const setBusy = useChatStore((s) => s.setBusy);
  const caps = useSelectedHarnessCapabilities();

  // Latest `sendTurn`, so the auto-flush / steer-fallback paths can invoke it without
  // creating a self-referential `useCallback` (assigned in an effect below).
  const sendTurnRef = useRef<UseChat['sendTurn'] | null>(null);
  // Resolves when the in-flight turn finalizes — lets the steer FALLBACK wait for the
  // interrupted turn to end before resending (set here, resolved in `sendTurn`'s finally).
  const turnDoneRef = useRef<(() => void) | null>(null);
  // True while a steer-fallback resend owns the NEXT turn, so the idle auto-flush stands
  // down and doesn't race a second `sendTurn` (which the supervisor would reject).
  const steerPendingRef = useRef(false);

  // Hydrate the transcript from persisted history on open / workspace change.
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void invoke('chat:history', { workspaceId })
      .then((history) => {
        if (active) hydrate(workspaceId, historyToTurns(history));
      })
      .catch(() => {
        /* surfaced elsewhere; an empty transcript is a safe fallback */
      });
    return () => {
      active = false;
    };
  }, [workspaceId, hydrate]);

  // Auto-flush the queue head on the transition to idle: pop the head (DB remove) and
  // send it as the NEXT turn, in order. Only one head per idle transition — the recursive
  // `sendTurn` flushes the following one when it, in turn, goes idle. Stands down while a
  // steer-fallback resend is pending so the two don't race for the single active turn.
  const flushQueueHead = useCallback(async (wsId: string): Promise<void> => {
    if (steerPendingRef.current) return;
    const queueStore = useQueueStore.getState();
    const head = (queueStore.byWorkspace[wsId] ?? [])[0];
    if (!head) return;
    // Remove the head FIRST so a resend failure can't loop-resend the same message.
    await queueStore.remove(wsId, head.id);
    await sendTurnRef.current?.(head.prompt, head.attachments, head.mode);
  }, []);

  const sendTurn = useCallback(
    async (
      prompt: string,
      attachments: Attachment[],
      mode?: AgentMode,
      harness?: HarnessId,
    ): Promise<void> => {
      if (!workspaceId) return;
      const pendingTurnId = `pending:${Date.now()}:${Math.random()}`;
      let started = false;
      startTurn(workspaceId, pendingTurnId, '');
      setBusy(workspaceId, true);
      try {
        await subscribeStream(
          'turn:start',
          { workspaceId, prompt, attachments, mode, harness },
          (chunk) => {
            if (chunk.kind === 'started') {
              started = true;
              startTurn(workspaceId, chunk.turnId, chunk.sessionId);
              return;
            }
            const event: AgentEvent = chunk.event;
            if (event.kind === 'turn_end') {
              endTurn(workspaceId, 'completed', event.usage as Usage);
            } else if (event.kind === 'error') {
              appendEvent(workspaceId, event);
              endTurn(workspaceId, 'error');
            } else {
              appendEvent(workspaceId, event);
            }
          },
        );
      } catch (err) {
        // Stream-level failure: record a terminal error so the UI recovers.
        if (!started) startTurn(workspaceId, pendingTurnId, '');
        appendEvent(workspaceId, {
          kind: 'error',
          message: err instanceof Error ? err.message : 'turn failed',
        });
        endTurn(workspaceId, 'error');
      } finally {
        setBusy(workspaceId, false);
        // Terminal frame reached: release any steer-fallback waiter FIRST (it owns the
        // next turn), then auto-flush the queue head (a no-op when a steer resend is
        // pending or the queue is empty).
        const resolveTurnDone = turnDoneRef.current;
        turnDoneRef.current = null;
        resolveTurnDone?.();
        void flushQueueHead(workspaceId);
      }
    },
    [workspaceId, setBusy, startTurn, appendEvent, endTurn, flushQueueHead],
  );

  // Keep the ref pointing at the latest `sendTurn` for the flush / steer-fallback paths.
  useEffect(() => {
    sendTurnRef.current = sendTurn;
  }, [sendTurn]);

  const interrupt = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    await invoke('turn:interrupt', { workspaceId });
  }, [workspaceId]);

  const steer = useCallback(
    async (
      text: string,
      attachments: Attachment[] = [],
      mode?: AgentMode,
    ): Promise<void> => {
      if (!workspaceId || text.trim() === '') return;

      // True mid-turn injection when the harness supports it. A steer that RESOLVES
      // `'rejected'` (e.g. the turn ended between click and inject) or THROWS both fall
      // through to the interrupt+resend fallback below — only `'injected'` short-circuits.
      if (caps?.supportsMidTurnSteer) {
        try {
          const result = await invoke('turn:steer', { workspaceId, text });
          if (result === 'injected') return;
        } catch {
          /* fall through to the legible interrupt+resend fallback */
        }
      }

      // No live turn to interrupt: just send the text as a normal turn. Guarded with
      // `steerPendingRef` so a turn ending at the same instant doesn't also auto-flush a
      // queue head and race this send (the supervisor would reject the second turn).
      const busy =
        useChatStore.getState().busyByWorkspace[workspaceId] ?? false;
      if (!busy) {
        steerPendingRef.current = true;
        try {
          await sendTurnRef.current?.(text, attachments, mode);
        } finally {
          steerPendingRef.current = false;
          // Advance any remaining queue now that the steered turn is done.
          void flushQueueHead(workspaceId);
        }
        return;
      }

      // Fallback (§3.6 — a legible NEW-turn boundary, not seamless injection): interrupt
      // the live turn, wait for it to finalize, then resend as a brand-new turn (carrying
      // the original attachments/mode so steering a queued row preserves its payload).
      steerPendingRef.current = true;
      const done = new Promise<void>((resolve) => {
        turnDoneRef.current = resolve;
      });
      try {
        await invoke('turn:interrupt', { workspaceId });
        await done;
        await sendTurnRef.current?.(text, attachments, mode);
      } finally {
        steerPendingRef.current = false;
        // Advance any still-queued messages that stood down during the resend.
        void flushQueueHead(workspaceId);
      }
    },
    [workspaceId, caps?.supportsMidTurnSteer, flushQueueHead],
  );

  return { turns, isBusy, sendTurn, interrupt, steer };
}
