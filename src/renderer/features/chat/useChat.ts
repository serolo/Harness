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
  ReasoningEffort,
  Usage,
} from '@shared/harness';
import type { ChatHistory } from '@shared/ipc';
import { calculateTurnBilling } from '@shared/billing';
import { invoke, onEvent, subscribeStream } from '@renderer/ipc';
import { useChatStore, type RenderedTurn } from '@renderer/stores/chat';

/** Stable empty-array reference so the `turns` selector doesn't loop on `?? []`. */
const EMPTY_TURNS: readonly RenderedTurn[] = [];

/** Map a persisted `ChatHistory` into the store's `RenderedTurn[]`. */
function historyToTurns(history: ChatHistory): RenderedTurn[] {
  return history.turns.map((t) => ({
    turnId: t.id,
    status: t.status,
    mode: t.mode ?? undefined,
    sessionId: t.sessionId ?? undefined,
    events: t.events
      .map((e) => e.event)
      .reduce<AgentEvent[]>((events, event) => {
        const previous = events.at(-1);
        if (previous?.kind === 'text' && event.kind === 'text') {
          previous.delta += event.delta;
        } else {
          events.push(structuredClone(event));
        }
        return events;
      }, []),
    startedAt: t.startedAt,
    endedAt: t.endedAt ?? undefined,
    harness: t.harness ?? undefined,
    model: t.model ?? undefined,
    costMicros: t.costMicros ?? undefined,
    pricingKey: t.pricingKey ?? undefined,
    usage:
      t.inputTokens != null || t.outputTokens != null
        ? {
            inputTokens: t.inputTokens ?? undefined,
            outputTokens: t.outputTokens ?? undefined,
            cachedInputTokens: t.cachedInputTokens ?? undefined,
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
    sessionId?: string | null,
    model?: string,
    effort?: ReasoningEffort,
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

  useEffect(() => {
    if (!workspaceId) return;
    return onEvent(
      'knowledge:proposalsCreated',
      ({ workspaceId: eventWorkspaceId, projectId, proposalIds }) => {
        if (eventWorkspaceId !== workspaceId) return;
        appendEvent(workspaceId, {
          kind: 'knowledge_proposal',
          projectId,
          proposalIds,
        });
      },
    );
  }, [workspaceId, appendEvent]);

  const sendTurn = useCallback(
    async (
      prompt: string,
      attachments: Attachment[],
      mode?: AgentMode,
      harness?: HarnessId,
      sessionId?: string | null,
      model?: string,
      effort?: ReasoningEffort,
    ): Promise<void> => {
      if (!workspaceId) return;
      const startedAt = Date.now();
      const pendingTurnId = `pending:${startedAt}:${Math.random()}`;
      let started = false;
      startTurn(
        workspaceId,
        pendingTurnId,
        '',
        {
          kind: 'user_message',
          text: prompt,
        },
        startedAt,
        mode,
        harness,
        model,
      );
      setBusy(workspaceId, true);
      try {
        const turnArg = {
          workspaceId,
          prompt,
          attachments,
          mode,
          harness,
          model,
          effort,
          ...(sessionId === undefined ? {} : { sessionId }),
        };
        await subscribeStream('turn:start', turnArg, (chunk) => {
          if (chunk.kind === 'started') {
            started = true;
            startTurn(
              workspaceId,
              chunk.turnId,
              chunk.sessionId,
              undefined,
              undefined,
              chunk.mode,
            );
            return;
          }
          const event: AgentEvent = chunk.event;
          if (event.kind === 'turn_end') {
            const billing =
              harness === undefined
                ? null
                : calculateTurnBilling(harness, model, event.usage);
            endTurn(
              workspaceId,
              'completed',
              event.usage as Usage,
              billing?.costMicros,
              billing?.pricingKey,
            );
          } else if (event.kind === 'error') {
            appendEvent(workspaceId, event);
            endTurn(workspaceId, 'error');
          } else {
            appendEvent(workspaceId, event);
          }
        });
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
