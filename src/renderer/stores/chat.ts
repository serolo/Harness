// Renderer-side chat store (Zustand) — per-workspace transcript + busy state.
//
// A workspace's transcript is a list of `RenderedTurn`s, each holding the ordered
// `AgentEvent`s the renderer received (live over the `turn:start` stream, or replayed
// from `chat:history`). Consecutive `text` deltas are COALESCED in-store so React does
// not re-render per token (phase-doc §8 / plan Task 8 gotcha).
//
// DTO types come from the FROZEN shared contract (@shared/*); never redeclare them.

import { create } from 'zustand';
import type { AgentEvent, AgentMode, HarnessId, Usage } from '@shared/harness';
import type { TurnStatus } from '@shared/models';

/** One turn as the transcript renders it. `events` excludes turn_end (its usage lives here). */
export interface RenderedTurn {
  turnId: string;
  status: TurnStatus;
  mode?: AgentMode;
  sessionId?: string;
  events: AgentEvent[];
  startedAt?: number;
  endedAt?: number;
  usage?: Usage;
  harness?: HarnessId;
  model?: string;
  costMicros?: number;
  pricingKey?: string;
}

export interface ChatState {
  /** Transcript per workspace id. */
  byWorkspace: Record<string, RenderedTurn[]>;
  /** Whether a turn is currently streaming, per workspace id. */
  busyByWorkspace: Record<string, boolean>;

  /** Replace a workspace's transcript (from `chat:history`). */
  hydrate: (workspaceId: string, turns: RenderedTurn[]) => void;
  /** Begin a new streaming turn (from the `started` stream frame). */
  startTurn: (
    workspaceId: string,
    turnId: string,
    sessionId: string,
    initialEvent?: AgentEvent,
    startedAt?: number,
    mode?: AgentMode,
    harness?: HarnessId,
    model?: string,
  ) => void;
  /** Append one event to the workspace's latest (streaming) turn, coalescing text. */
  appendEvent: (workspaceId: string, event: AgentEvent) => void;
  /** Finalize the latest turn with a terminal status (+ usage from turn_end). */
  endTurn: (
    workspaceId: string,
    status: TurnStatus,
    usage?: Usage,
    costMicros?: number,
    pricingKey?: string,
  ) => void;
  /** Set the busy flag for a workspace. */
  setBusy: (workspaceId: string, busy: boolean) => void;
  /** Clear a workspace's transcript + busy flag. */
  reset: (workspaceId: string) => void;
}

/** Append `event` to `turns`' last turn, coalescing consecutive text deltas. */
function appendToLastTurn(
  turns: RenderedTurn[],
  event: AgentEvent,
): RenderedTurn[] {
  if (turns.length === 0) return turns;
  const next = turns.slice();
  const last = { ...next[next.length - 1] };
  const events = last.events.slice();
  const tail = events[events.length - 1];
  if (event.kind === 'text' && tail && tail.kind === 'text') {
    events[events.length - 1] = {
      kind: 'text',
      delta: tail.delta + event.delta,
    };
  } else {
    events.push(event);
  }
  last.events = events;
  next[next.length - 1] = last;
  return next;
}

export const useChatStore = create<ChatState>((set) => ({
  byWorkspace: {},
  busyByWorkspace: {},

  hydrate: (workspaceId, turns) =>
    set((state) => ({
      byWorkspace: { ...state.byWorkspace, [workspaceId]: turns },
    })),

  startTurn: (
    workspaceId,
    turnId,
    sessionId,
    initialEvent,
    startedAt,
    mode,
    harness,
    model,
  ) =>
    set((state) => {
      const turns = state.byWorkspace[workspaceId] ?? [];
      const last = turns[turns.length - 1];
      const turn: RenderedTurn = {
        turnId,
        status: 'streaming',
        mode,
        sessionId: sessionId || undefined,
        events: initialEvent ? [initialEvent] : [],
        startedAt: startedAt ?? Date.now(),
        harness,
        model,
      };
      if (last?.turnId.startsWith('pending:') && last.status === 'streaming') {
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: [
              ...turns.slice(0, -1),
              {
                ...turn,
                events: last.events,
                startedAt: last.startedAt ?? turn.startedAt,
                mode: turn.mode ?? last.mode,
                harness: turn.harness ?? last.harness,
                model: turn.model ?? last.model,
              },
            ],
          },
        };
      }
      return {
        byWorkspace: { ...state.byWorkspace, [workspaceId]: [...turns, turn] },
      };
    }),

  appendEvent: (workspaceId, event) =>
    set((state) => {
      const turns = state.byWorkspace[workspaceId] ?? [];
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: appendToLastTurn(turns, event),
        },
      };
    }),

  endTurn: (workspaceId, status, usage, costMicros, pricingKey) =>
    set((state) => {
      const turns = state.byWorkspace[workspaceId] ?? [];
      if (turns.length === 0) return state;
      const next = turns.slice();
      next[next.length - 1] = {
        ...next[next.length - 1],
        status,
        usage,
        endedAt: Date.now(),
        costMicros,
        pricingKey,
      };
      return {
        byWorkspace: { ...state.byWorkspace, [workspaceId]: next },
      };
    }),

  setBusy: (workspaceId, busy) =>
    set((state) => ({
      busyByWorkspace: { ...state.busyByWorkspace, [workspaceId]: busy },
    })),

  reset: (workspaceId) =>
    set((state) => {
      const byWorkspace = { ...state.byWorkspace };
      const busyByWorkspace = { ...state.busyByWorkspace };
      delete byWorkspace[workspaceId];
      delete busyByWorkspace[workspaceId];
      return { byWorkspace, busyByWorkspace };
    }),
}));
