// TurnRecorder — the streaming persistence write path for a turn (phase-doc §3.3,
// Risk R5). It sits between the supervisor and the two repos (`TurnsRepo`,
// `EventsRepo`) and is responsible for ONE thing the repos deliberately are not:
// coalescing adjacent `text` deltas so a token-by-token stream does not become a
// per-token flood of synchronous better-sqlite3 writes (which would block the main
// event loop — the whole reason coalescing lives here, not in the repo).
//
// This module is persistence-only. It does NOT hold the renderer `StreamSink`: the
// supervisor (Task 5) forwards every raw `AgentEvent` to the renderer AND calls
// `record()` here, so the live stream stays full-fidelity while the DB stores a
// coalesced form.
//
// Coalescing / round-trip contract:
//   Coalescing merges N consecutive streamed `text` deltas into FEWER persisted
//   `text` rows (flushed on a size threshold, on any non-text event, or at turn end).
//   The guarantee is TRANSCRIPT-EQUIVALENCE, not strict per-event equality:
//   concatenating the persisted `text` events in order, interleaved with the
//   non-text events in their original positions, reproduces the same logical
//   transcript the renderer streamed live. A final partial text buffer is never
//   dropped — it is flushed by `endTurn` (including the interrupt/error path, so no
//   `streaming` turn row is ever left dangling).

import type { AgentEvent, AgentMode, Usage } from '@shared/harness';
import type { TurnRecord, TurnStatus } from '@shared/models';
import type { TurnsRepo } from '../db/repos/turns';
import type { EventsRepo } from '../db/repos/events';

/** Repos the recorder orchestrates (injected for testability). */
export interface TurnRecorderDeps {
  turns: TurnsRepo;
  events: EventsRepo;
}

/** Tunables. `textFlushThreshold` bounds in-memory text buffering (chars). */
export interface TurnRecorderOptions {
  textFlushThreshold?: number;
}

/** Default: flush accumulated text once it reaches ~512 chars. */
const DEFAULT_TEXT_FLUSH_THRESHOLD = 512;

/** Per-turn mutable state: the only thing this class keeps in memory. */
interface TurnState {
  pendingText: string;
}

/**
 * Streaming turn persistence with text-delta coalescing. One instance is shared
 * across all workspaces (state is keyed by turnId); constructed in
 * `src/main/index.ts` and injected into the `HarnessSupervisor`.
 */
export class TurnRecorder {
  private readonly turns: TurnsRepo;
  private readonly events: EventsRepo;
  private readonly textFlushThreshold: number;
  private readonly state = new Map<string, TurnState>();

  constructor(deps: TurnRecorderDeps, opts: TurnRecorderOptions = {}) {
    this.turns = deps.turns;
    this.events = deps.events;
    this.textFlushThreshold =
      opts.textFlushThreshold ?? DEFAULT_TEXT_FLUSH_THRESHOLD;
  }

  /**
   * Open a new turn: allocate the per-workspace `idx`, insert a `streaming` row,
   * and initialize its in-memory coalescing buffer. Returns the new turn id.
   */
  async beginTurn(
    workspaceId: string,
    meta: { sessionId?: string; mode?: AgentMode } = {},
  ): Promise<string> {
    const idx = await this.turns.nextIdx(workspaceId);
    const turn = await this.turns.create({
      workspaceId,
      idx,
      status: 'streaming',
      sessionId: meta.sessionId ?? null,
      mode: meta.mode ?? null,
    });
    this.state.set(turn.id, { pendingText: '' });
    return turn.id;
  }

  /**
   * Persist one `AgentEvent` (renderer forwarding is the supervisor's job). `text`
   * events accumulate in memory and flush on the size threshold; any non-text event
   * first flushes the pending text (preserving order) then persists immediately.
   *
   * A `record` for an unknown turnId (no `beginTurn`) initializes state on demand so
   * a late/out-of-band event is still stored rather than silently dropped.
   */
  async record(turnId: string, event: AgentEvent): Promise<void> {
    const st = this.stateFor(turnId);

    if (event.kind === 'text') {
      if (event.delta.length === 0) {
        return; // empty delta — nothing to accumulate
      }
      st.pendingText += event.delta;
      if (st.pendingText.length >= this.textFlushThreshold) {
        await this.flushText(turnId, st);
      }
      return;
    }

    // Non-text: flush any buffered text FIRST so ordering is preserved, then write.
    await this.flushText(turnId, st);
    await this.events.append({ turnId, event });
  }

  /**
   * Finalize a turn: flush the trailing text buffer (never dropped), then write the
   * terminal status + endedAt + usage. Safe on every terminal path (completed /
   * interrupted / error) — leaves no dangling `streaming` row. Idempotent-ish: a
   * second call is a harmless status re-write with an empty (already-cleared) buffer.
   */
  async endTurn(
    turnId: string,
    status: TurnStatus,
    usage?: Usage,
  ): Promise<void> {
    const st = this.stateFor(turnId);
    await this.flushText(turnId, st);
    this.state.delete(turnId);
    await this.turns.setStatus(turnId, status, {
      endedAt: Date.now(),
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    });
  }

  /**
   * Persist the harness-captured session id onto a turn (for `--resume` on the next
   * turn). Delegates to the repo; independent of the coalescing buffer.
   */
  async setSessionId(turnId: string, sessionId: string): Promise<void> {
    await this.turns.setSessionId(turnId, sessionId);
  }

  /** The most recent captured session id for a workspace (for `--resume`), or undefined. */
  async latestSessionId(workspaceId: string): Promise<string | undefined> {
    return this.turns.latestSessionId(workspaceId);
  }

  /**
   * Reconstruct a workspace's full chat: every turn (idx order) with its persisted
   * events (chronological). Task 6 wraps this as the `ChatHistory` IPC DTO.
   */
  async history(workspaceId: string): Promise<TurnRecord[]> {
    const turns = await this.turns.listByWorkspace(workspaceId);
    for (const turn of turns) {
      turn.events = await this.events.listByTurn(turn.id);
    }
    return turns;
  }

  /** Clear persisted turns and discard buffered text belonging to this workspace. */
  async clear(workspaceId: string): Promise<void> {
    for (const [turnId] of this.state) {
      const turn = await this.turns.getById(turnId);
      if (turn?.workspaceId === workspaceId) {
        this.state.delete(turnId);
      }
    }
    await this.turns.clearWorkspaceHistory(workspaceId);
  }

  /** Flush the pending text buffer as one coalesced `text` event row (if non-empty). */
  private async flushText(turnId: string, st: TurnState): Promise<void> {
    if (st.pendingText.length === 0) {
      return;
    }
    const delta = st.pendingText;
    st.pendingText = '';
    await this.events.append({ turnId, event: { kind: 'text', delta } });
  }

  /** Get (or lazily create) the in-memory state for a turn. */
  private stateFor(turnId: string): TurnState {
    let st = this.state.get(turnId);
    if (!st) {
      st = { pendingText: '' };
      this.state.set(turnId, st);
    }
    return st;
  }
}
