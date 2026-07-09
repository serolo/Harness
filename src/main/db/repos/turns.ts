// Turns repository — typed CRUD over the `turns` table (migration 0003), returning
// the shared `TurnRecord` DTO (src/shared/models.ts). IDs are UUIDv7; timestamps are
// epoch-millis. Nullable DDL columns (sessionId, mode, endedAt, inputTokens,
// outputTokens) round-trip as `x | null`. The row↔DTO mapping is explicit
// (`rowToTurn`) so schema drift surfaces here, mirroring `workspaces.ts`.
//
// A bare row read leaves `events: []` — history assembly joins events in via
// EventsRepo (the consumer fills `events`), so this repo never touches that table.

import { v7 as uuidv7 } from 'uuid';
import type { TurnRecord, TurnStatus } from '@shared/models';
import type { AgentMode } from '@shared/harness';
import type { AppDatabase } from '../index';
import type { TurnsTable } from '../schema';

/**
 * Fields a caller supplies to open a turn. `id` is generated; `startedAt` defaults to
 * now; `status` is typically `'streaming'` at creation. Nullable inputs default to null.
 */
export interface CreateTurnInput {
  workspaceId: string;
  idx: number;
  status: TurnStatus;
  sessionId?: string | null;
  mode?: AgentMode | null;
  startedAt?: number;
}

/**
 * Optional fields written alongside a status transition in `setStatus` — the turn's
 * terminal bookkeeping (end time + usage). Only provided fields are written.
 */
export interface SetTurnStatusPatch {
  endedAt?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Map a DB row to the shared `TurnRecord` DTO (snake_case → camelCase). `events`
 * defaults to `[]` — the caller (history assembler) fills it from EventsRepo.
 */
function rowToTurn(row: TurnsTable): TurnRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    idx: row.idx,
    status: row.status,
    sessionId: row.session_id,
    mode: row.mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    events: [],
  };
}

/**
 * Repository for the `turns` table. Constructed with the shared `AppDatabase` handle.
 */
export class TurnsRepo {
  constructor(private readonly db: AppDatabase) {}

  /** Insert a new turn and return the created DTO (with `events: []`). */
  async create(input: CreateTurnInput): Promise<TurnRecord> {
    const row: TurnsTable = {
      id: uuidv7(),
      workspace_id: input.workspaceId,
      idx: input.idx,
      status: input.status,
      session_id: input.sessionId ?? null,
      mode: input.mode ?? null,
      started_at: input.startedAt ?? Date.now(),
      ended_at: null,
      input_tokens: null,
      output_tokens: null,
      reverted_at: null,
    };

    await this.db.insertInto('turns').values(row).execute();
    return rowToTurn(row);
  }

  /**
   * Next ordinal for a workspace: `MAX(idx) + 1`, or `0` when the workspace has no
   * turns yet. SQLite `MAX` over zero rows returns NULL → coerced to `-1` so the
   * first turn is `0`. The `uidx_turns_workspace_idx` unique index is the ultimate
   * guard against a racing duplicate.
   */
  async nextIdx(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom('turns')
      .select((eb) => eb.fn.max('idx').as('maxIdx'))
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    // maxIdx is NULL (→ undefined here) when the workspace has no turns.
    const max = row?.maxIdx;
    return (max ?? -1) + 1;
  }

  /**
   * Transition a turn's status and, optionally, its terminal bookkeeping (endedAt +
   * usage). Only provided patch fields are written (camelCase → snake_case).
   */
  async setStatus(
    turnId: string,
    status: TurnStatus,
    patch: SetTurnStatusPatch = {},
  ): Promise<void> {
    // Build the column set explicitly so we only touch provided fields and keep the
    // camelCase→snake_case mapping in one place.
    const set: Partial<TurnsTable> = { status };
    if (patch.endedAt !== undefined) set.ended_at = patch.endedAt;
    if (patch.inputTokens !== undefined) set.input_tokens = patch.inputTokens;
    if (patch.outputTokens !== undefined)
      set.output_tokens = patch.outputTokens;

    await this.db
      .updateTable('turns')
      .set(set)
      .where('id', '=', turnId)
      .execute();
  }

  /**
   * Persist the harness-captured session id onto a turn (the authoritative id the CLI
   * ran under, used to `--resume` the NEXT turn). Additive to `setStatus` so the two
   * concerns stay independent.
   */
  async setSessionId(turnId: string, sessionId: string): Promise<void> {
    await this.db
      .updateTable('turns')
      .set({ session_id: sessionId })
      .where('id', '=', turnId)
      .execute();
  }

  /**
   * The session id of the most recent turn for a workspace that captured one (highest
   * `idx` with a non-null `session_id`), or undefined. Used to `--resume` the next turn.
   */
  async latestSessionId(workspaceId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('turns')
      .select('session_id')
      .where('workspace_id', '=', workspaceId)
      .where('session_id', 'is not', null)
      // Reverted turns are excluded so the NEXT turn after a revert starts a fresh
      // session rather than resuming a truncated one (Phase 4, revert semantics).
      .where('reverted_at', 'is', null)
      .orderBy('idx', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.session_id ?? undefined;
  }

  /**
   * Mark every turn AFTER `idx` (strictly greater) in a workspace as reverted, stamping
   * `reverted_at` = now on any not already reverted. Used by CheckpointService.revert so
   * reverted turns drop out of history + `latestSessionId` (Phase 4, spec §5.4). The turn
   * at `idx` itself (the checkpoint target) is retained. Idempotent: turns already stamped
   * are left untouched, so reverting twice is safe.
   */
  async markRevertedAfter(workspaceId: string, idx: number): Promise<void> {
    await this.db
      .updateTable('turns')
      .set({ reverted_at: Date.now() })
      .where('workspace_id', '=', workspaceId)
      .where('idx', '>', idx)
      .where('reverted_at', 'is', null)
      .execute();
  }

  /** Fetch a turn by id (with `events: []`), or `null` if none exists. */
  async getById(turnId: string): Promise<TurnRecord | null> {
    const row = await this.db
      .selectFrom('turns')
      .selectAll()
      .where('id', '=', turnId)
      .executeTakeFirst();
    return row ? rowToTurn(row) : null;
  }

  /**
   * List all turns for a workspace ordered by `idx ASC` (chronological). Events are
   * left empty (`[]`); the caller fills them from EventsRepo per turn.
   */
  async listByWorkspace(workspaceId: string): Promise<TurnRecord[]> {
    const rows = await this.db
      .selectFrom('turns')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      // Reverted turns keep their rows but drop out of reconstructed chat history so a
      // post-revert transcript reflects the restored state (Phase 4, spec §5.4). `nextIdx`
      // deliberately does NOT filter — ordinals must keep climbing to avoid ref collisions.
      .where('reverted_at', 'is', null)
      .orderBy('idx', 'asc')
      .execute();
    return rows.map(rowToTurn);
  }
}
