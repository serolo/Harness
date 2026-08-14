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
  /** Owning chat tab; null/undefined for task-owned turns and turns whose tab was closed. */
  contextId?: string | null;
}

export interface TaskTurnOwner {
  taskId: string;
  prompt: string;
}

export interface ChatState {
  /** Transcript per workspace id. */
  byWorkspace: Record<string, RenderedTurn[]>;
  /** Whether a turn is currently streaming, per workspace id. */
  busyByWorkspace: Record<string, boolean>;
  /** Scheduled-task ownership keyed by workspace and turn id. */
  taskTurnsByWorkspace: Record<string, Record<string, TaskTurnOwner>>;

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
    contextId?: string,
  ) => void;
  /** Atomically claim and begin a scheduled-task turn. */
  startTaskTurn: (
    workspaceId: string,
    taskId: string,
    turnId: string,
    sessionId: string,
    prompt: string,
  ) => void;
  /** Record persisted scheduled-task ownership during reconstruction. */
  registerTaskTurn: (
    workspaceId: string,
    taskId: string,
    turnId: string,
    prompt: string,
  ) => void;
  /** Append one event to the workspace's latest (streaming) turn, coalescing text. */
  appendEvent: (
    workspaceId: string,
    event: AgentEvent,
    turnId?: string,
  ) => void;
  /** Finalize the latest turn with a terminal status (+ usage from turn_end). */
  endTurn: (
    workspaceId: string,
    status: TurnStatus,
    usage?: Usage,
    costMicros?: number,
    pricingKey?: string,
    turnId?: string,
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
  if (
    event.kind === 'knowledge_proposal' &&
    turns
      .at(-1)
      ?.events.some(
        (existing) =>
          existing.kind === 'knowledge_proposal' &&
          existing.projectId === event.projectId &&
          existing.proposalIds.length === event.proposalIds.length &&
          existing.proposalIds.every(
            (proposalId, index) => proposalId === event.proposalIds[index],
          ),
      )
  ) {
    // `useChat(workspaceId)` is consumed by Chat, Checks, and Diff. Each consumer can
    // observe the same broadcast, so make this out-of-band event idempotent in-store.
    return turns;
  }
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

function startTurnInList(
  turns: RenderedTurn[],
  turnId: string,
  sessionId: string,
  initialEvent?: AgentEvent,
  startedAt?: number,
  mode?: AgentMode,
  harness?: HarnessId,
  model?: string,
  contextId?: string,
  // Internal flag — kept last so `startTaskTurn`'s explicit `false` stays at the tail.
  replacePending = true,
): RenderedTurn[] {
  const existingIndex = turns.findIndex((turn) => turn.turnId === turnId);
  if (existingIndex !== -1) {
    const next = turns.slice();
    const existing = next[existingIndex];
    const hasInitialEvent =
      initialEvent === undefined ||
      existing.events.some(
        (event) =>
          event.kind === 'user_message' &&
          initialEvent.kind === 'user_message' &&
          event.text === initialEvent.text,
      );
    next[existingIndex] = {
      ...existing,
      status: 'streaming',
      sessionId: sessionId || existing.sessionId,
      events:
        initialEvent !== undefined && !hasInitialEvent
          ? [initialEvent, ...existing.events]
          : existing.events,
      startedAt: existing.startedAt ?? startedAt ?? Date.now(),
      mode: mode ?? existing.mode,
      harness: harness ?? existing.harness,
      model: model ?? existing.model,
      contextId: contextId ?? existing.contextId,
    };
    return next;
  }

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
    contextId,
  };
  if (
    replacePending &&
    last?.turnId.startsWith('pending:') &&
    last.status === 'streaming'
  ) {
    return [
      ...turns.slice(0, -1),
      {
        ...turn,
        events: last.events,
        startedAt: last.startedAt ?? turn.startedAt,
        mode: turn.mode ?? last.mode,
        harness: turn.harness ?? last.harness,
        model: turn.model ?? last.model,
        contextId: turn.contextId ?? last.contextId,
      },
    ];
  }
  return [...turns, turn];
}

export const useChatStore = create<ChatState>((set) => ({
  byWorkspace: {},
  busyByWorkspace: {},
  taskTurnsByWorkspace: {},

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
    contextId,
  ) =>
    set((state) => {
      const turns = state.byWorkspace[workspaceId] ?? [];
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: startTurnInList(
            turns,
            turnId,
            sessionId,
            initialEvent,
            startedAt,
            mode,
            harness,
            model,
            contextId,
          ),
        },
      };
    }),

  startTaskTurn: (workspaceId, taskId, turnId, sessionId, prompt) =>
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: startTurnInList(
          state.byWorkspace[workspaceId] ?? [],
          turnId,
          sessionId,
          { kind: 'user_message', text: prompt },
          undefined, // startedAt
          undefined, // mode
          undefined, // harness
          undefined, // model
          undefined, // contextId — scheduler-fired turns never belong to a chat tab
          false, // replacePending
        ),
      },
      busyByWorkspace: {
        ...state.busyByWorkspace,
        [workspaceId]: true,
      },
      taskTurnsByWorkspace: {
        ...state.taskTurnsByWorkspace,
        [workspaceId]: {
          ...(state.taskTurnsByWorkspace[workspaceId] ?? {}),
          [turnId]: { taskId, prompt },
        },
      },
    })),

  registerTaskTurn: (workspaceId, taskId, turnId, prompt) =>
    set((state) => ({
      taskTurnsByWorkspace: {
        ...state.taskTurnsByWorkspace,
        [workspaceId]: {
          ...(state.taskTurnsByWorkspace[workspaceId] ?? {}),
          [turnId]: { taskId, prompt },
        },
      },
    })),

  appendEvent: (workspaceId, event, turnId) =>
    set((state) => {
      const turns = state.byWorkspace[workspaceId] ?? [];
      const targetIndex =
        turnId === undefined
          ? turns.length - 1
          : turns.findIndex((turn) => turn.turnId === turnId);
      if (targetIndex < 0) return state;
      const target = turns[targetIndex];
      const updated = appendToLastTurn([target], event)[0];
      const next = turns.slice();
      next[targetIndex] = updated;
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: next,
        },
      };
    }),

  endTurn: (workspaceId, status, usage, costMicros, pricingKey, turnId) =>
    set((state) => {
      const turns = state.byWorkspace[workspaceId] ?? [];
      if (turns.length === 0) return state;
      const targetIndex =
        turnId === undefined
          ? turns.length - 1
          : turns.findIndex((turn) => turn.turnId === turnId);
      if (targetIndex < 0) return state;
      const next = turns.slice();
      next[targetIndex] = {
        ...next[targetIndex],
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
      const taskTurnsByWorkspace = { ...state.taskTurnsByWorkspace };
      delete byWorkspace[workspaceId];
      delete busyByWorkspace[workspaceId];
      delete taskTurnsByWorkspace[workspaceId];
      return { byWorkspace, busyByWorkspace, taskTurnsByWorkspace };
    }),
}));
