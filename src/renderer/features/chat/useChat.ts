// useChat — the chat feature's data hook. Bridges the FROZEN IPC contract to the
// Zustand chat store: hydrate from `chat:history` on open, stream a turn over
// `turn:start`, and interrupt via `turn:interrupt`. All main access funnels through
// `@renderer/ipc` (README §10) — never `window.api`/`ipcRenderer` directly.

import { useCallback, useEffect } from 'react';
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

/** Stable empty-array reference so the `turns` selector doesn't loop on `?? []`. */
const EMPTY_TURNS: readonly RenderedTurn[] = [];

/** Map a persisted `ChatHistory` into the store's `RenderedTurn[]`. */
function historyToTurns(history: ChatHistory): RenderedTurn[] {
  return history.turns.map((t) => ({
    turnId: t.id,
    status: t.status,
    sessionId: t.sessionId ?? undefined,
    startedAt: t.startedAt,
    endedAt: t.endedAt ?? undefined,
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
    displayPrompt?: string,
  ) => Promise<void>;
  interrupt: () => Promise<void>;
  clear: () => Promise<void>;
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
  const reset = useChatStore((s) => s.reset);

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

  const sendTurn = useCallback(
    async (
      prompt: string,
      attachments: Attachment[],
      mode?: AgentMode,
      harness?: HarnessId,
      displayPrompt?: string,
    ): Promise<void> => {
      if (!workspaceId) return;
      const pendingTurnId = `pending:${Date.now()}:${Math.random()}`;
      const startedAt = Date.now();
      const shownPrompt = displayPrompt ?? prompt;
      let started = false;
      startTurn(workspaceId, pendingTurnId, '', { prompt: shownPrompt, startedAt });
      setBusy(workspaceId, true);
      try {
        await subscribeStream(
          'turn:start',
          { workspaceId, prompt, attachments, mode, harness },
          (chunk) => {
            if (chunk.kind === 'started') {
              started = true;
              startTurn(workspaceId, chunk.turnId, chunk.sessionId, {
                prompt: shownPrompt,
                startedAt,
              });
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
        if (!started) {
          startTurn(workspaceId, pendingTurnId, '', {
            prompt: shownPrompt,
            startedAt,
          });
        }
        appendEvent(workspaceId, {
          kind: 'error',
          message: err instanceof Error ? err.message : 'turn failed',
        });
        endTurn(workspaceId, 'error');
      } finally {
        setBusy(workspaceId, false);
      }
    },
    [workspaceId, setBusy, startTurn, appendEvent, endTurn],
  );

  const interrupt = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    await invoke('turn:interrupt', { workspaceId });
  }, [workspaceId]);

  const clear = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    await invoke('chat:clear', { workspaceId });
    reset(workspaceId);
  }, [workspaceId, reset]);

  return { turns, isBusy, sendTurn, interrupt, clear };
}
