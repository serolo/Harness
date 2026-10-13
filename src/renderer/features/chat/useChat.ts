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
/** Guards late transport closes independently for every manual chat context. */
const activeSendTokens = new Map<
  string,
  { workspaceId: string; token: symbol }
>();

function sendTokenKey(workspaceId: string, contextId?: string): string {
  return `${workspaceId}\u0000${contextId ?? ''}`;
}

function workspaceHasActiveSend(workspaceId: string): boolean {
  for (const active of activeSendTokens.values()) {
    if (active.workspaceId === workspaceId) return true;
  }
  return false;
}

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
    contextId: t.contextId ?? undefined,
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
    contextId?: string,
    displayPrompt?: string,
  ) => Promise<void>;
  interrupt: (contextId?: string) => Promise<void>;
  forceInterrupt: (contextId?: string) => Promise<void>;
  clear: (contextId?: string) => Promise<void>;
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
  const clearContext = useChatStore((s) => s.clearContext);

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
      ({ workspaceId: eventWorkspaceId, turnId, projectId, proposalIds }) => {
        if (eventWorkspaceId !== workspaceId) return;
        appendEvent(
          workspaceId,
          {
            kind: 'knowledge_proposal',
            projectId,
            proposalIds,
          },
          turnId,
        );
      },
    );
  }, [workspaceId, appendEvent]);

  useEffect(() => {
    if (!workspaceId) return;
    return onEvent('knowledge:extractionCompleted', (payload) => {
      if (payload.workspaceId !== workspaceId) return;
      appendEvent(workspaceId, payload.event, payload.turnId);
    });
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
      contextId?: string,
      displayPrompt?: string,
    ): Promise<void> => {
      if (!workspaceId) return;
      const startedAt = Date.now();
      const pendingTurnId = `pending:${startedAt}:${Math.random()}`;
      const sendToken = Symbol(workspaceId);
      const tokenKey = sendTokenKey(workspaceId, contextId);
      let activeTurnId = pendingTurnId;
      let started = false;
      let terminal = false;
      const finishBusy = (): void => {
        if (activeSendTokens.get(tokenKey)?.token !== sendToken) return;
        activeSendTokens.delete(tokenKey);
        setBusy(workspaceId, workspaceHasActiveSend(workspaceId));
      };
      startTurn(
        workspaceId,
        pendingTurnId,
        '',
        {
          kind: 'user_message',
          text: displayPrompt ?? prompt,
        },
        startedAt,
        mode,
        harness,
        model,
        contextId,
      );
      if (attachments.length > 0) {
        appendEvent(
          workspaceId,
          { kind: 'user_attachments', attachments },
          pendingTurnId,
        );
      }
      activeSendTokens.set(tokenKey, { workspaceId, token: sendToken });
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
          ...(contextId === undefined ? {} : { contextId }),
          ...(displayPrompt === undefined ? {} : { displayPrompt }),
        };
        await subscribeStream('turn:start', turnArg, (chunk) => {
          if (chunk.kind === 'started') {
            started = true;
            activeTurnId = chunk.turnId;
            startTurn(
              workspaceId,
              chunk.turnId,
              chunk.sessionId,
              undefined,
              undefined,
              chunk.mode,
              undefined, // harness
              undefined, // model
              contextId,
              pendingTurnId,
            );
            return;
          }
          const event: AgentEvent = chunk.event;
          if (event.kind === 'turn_end') {
            terminal = true;
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
              activeTurnId,
            );
            // The semantic turn is finished even if main keeps the transport open for
            // post-turn work. Restore Send immediately on the terminal event.
            finishBusy();
          } else if (event.kind === 'error') {
            terminal = true;
            appendEvent(workspaceId, event, activeTurnId);
            endTurn(
              workspaceId,
              'error',
              undefined,
              undefined,
              undefined,
              activeTurnId,
            );
            finishBusy();
          } else {
            appendEvent(workspaceId, event, activeTurnId);
          }
        });
        if (!terminal) {
          // The stream contract promises a terminal event before transport end. Keep
          // malformed/legacy streams from leaving a context permanently "streaming".
          terminal = true;
          appendEvent(
            workspaceId,
            {
              kind: 'error',
              message: 'turn stream ended without a terminal event',
            },
            activeTurnId,
          );
          endTurn(
            workspaceId,
            'error',
            undefined,
            undefined,
            undefined,
            activeTurnId,
          );
          finishBusy();
        }
      } catch (err) {
        // Stream-level failure: record a terminal error so the UI recovers.
        if (!terminal) {
          if (!started) startTurn(workspaceId, pendingTurnId, '');
          appendEvent(
            workspaceId,
            {
              kind: 'error',
              message: err instanceof Error ? err.message : 'turn failed',
            },
            activeTurnId,
          );
          endTurn(
            workspaceId,
            'error',
            undefined,
            undefined,
            undefined,
            activeTurnId,
          );
        }
      } finally {
        finishBusy();
      }
    },
    [workspaceId, setBusy, startTurn, appendEvent, endTurn],
  );

  const interrupt = useCallback(
    async (contextId?: string): Promise<void> => {
      if (!workspaceId) return;
      if (contextId === undefined || contextId.startsWith('task:')) {
        await invoke('turn:interrupt', { workspaceId });
        return;
      }
      await invoke('turn:interruptContext', { workspaceId, contextId });
    },
    [workspaceId],
  );

  const forceInterrupt = useCallback(
    async (contextId?: string): Promise<void> => {
      if (!workspaceId) return;
      if (contextId === undefined || contextId.startsWith('task:')) {
        await invoke('turn:forceInterrupt', { workspaceId });
        return;
      }
      await invoke('turn:forceInterruptContext', { workspaceId, contextId });
    },
    [workspaceId],
  );

  const clear = useCallback(
    async (contextId?: string): Promise<void> => {
      if (!workspaceId) return;
      if (contextId !== undefined && !contextId.startsWith('task:')) {
        await invoke('chat:clearContext', { workspaceId, contextId });
        clearContext(workspaceId, contextId);
        return;
      }
      await invoke('chat:clear', { workspaceId });
      reset(workspaceId);
    },
    [workspaceId, reset, clearContext],
  );

  return { turns, isBusy, sendTurn, interrupt, forceInterrupt, clear };
}
