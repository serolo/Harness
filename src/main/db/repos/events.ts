// Events repository — typed append/read over the `events` table (migration 0003),
// returning the shared `TurnEventRecord` DTO (src/shared/models.ts). IDs are UUIDv7;
// timestamps are epoch-millis. Each row stores a frozen `AgentEvent` as opaque JSON
// (`payload_json`) plus its `kind` for cheap filtering. The row↔DTO mapping is
// explicit (`rowToEvent`) so schema drift surfaces here, mirroring `workspaces.ts`.
//
// FORWARD-COMPAT (see migration 0003 note): `kind` is NOT enum-narrowed and an
// unrecognized future kind still round-trips. A row whose `payload_json` fails to
// parse is skipped (logged) rather than throwing the whole read — an old reader must
// not crash on a newer writer. A value this app itself wrote always parses cleanly.

import { v7 as uuidv7 } from 'uuid';
import type { AgentEvent } from '@shared/harness';
import type { TurnEventRecord } from '@shared/models';
import type { AppDatabase } from '../index';
import type { EventsTable } from '../schema';

/**
 * Fields a caller supplies to append one event. `id` is generated; `ts` defaults to
 * now. `kind` and `payload_json` are both derived from `event` (single source of truth).
 */
export interface AppendEventInput {
  turnId: string;
  event: AgentEvent;
  ts?: number;
}

/**
 * Map a DB row to the shared `TurnEventRecord` DTO, deserializing `payload_json`.
 * Returns `null` (not throw) when the payload is unparseable so a single bad row
 * cannot break history assembly — the caller filters nulls (forward-compat).
 */
function rowToEvent(row: EventsTable): TurnEventRecord | null {
  let event: AgentEvent;
  try {
    event = JSON.parse(row.payload_json) as AgentEvent;
  } catch (err) {
    // Opaque forward-compat: skip an unparseable row rather than throwing. A value
    // this app wrote always parses; this only guards genuinely corrupt/foreign data.
    console.warn(
      `events: skipping unparseable payload_json for event ${row.id} (turn ${row.turn_id})`,
      err,
    );
    return null;
  }
  return {
    id: row.id,
    turnId: row.turn_id,
    kind: row.kind,
    event,
    ts: row.ts,
  };
}

/**
 * Repository for the `events` table. Constructed with the shared `AppDatabase` handle.
 */
export class EventsRepo {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Append one `AgentEvent` to a turn and return the created DTO. `kind` is stored
   * from `event.kind` and the full event is serialized into `payload_json`.
   */
  async append(input: AppendEventInput): Promise<TurnEventRecord> {
    const row: EventsTable = {
      id: uuidv7(),
      turn_id: input.turnId,
      kind: input.event.kind,
      payload_json: JSON.stringify(input.event),
      ts: input.ts ?? Date.now(),
    };

    await this.db.insertInto('events').values(row).execute();
    return {
      id: row.id,
      turnId: row.turn_id,
      kind: row.kind,
      event: input.event,
      ts: row.ts,
    };
  }

  /**
   * List a turn's events in stable chronological order (`ts ASC, id ASC`). UUIDv7 ids
   * are time-sortable so the id tiebreak keeps same-millisecond events in insert order.
   * Rows with an unparseable payload are skipped (forward-compat, see `rowToEvent`).
   */
  async listByTurn(turnId: string): Promise<TurnEventRecord[]> {
    const rows = await this.db
      .selectFrom('events')
      .selectAll()
      .where('turn_id', '=', turnId)
      .orderBy('ts', 'asc')
      .orderBy('id', 'asc')
      .execute();
    // Drop nulls from unparseable rows without breaking the whole read.
    return rows.map(rowToEvent).filter((e): e is TurnEventRecord => e !== null);
  }
}
