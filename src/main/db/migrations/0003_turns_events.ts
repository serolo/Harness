// Migration 0003 — `turns` and `events` tables (Phase 2, harness + chat).
//
// A `turn` is one agent request/response cycle scoped to a workspace; `events` are
// the frozen `AgentEvent`s emitted during that turn, stored as opaque JSON so chat
// history reconstructs exactly what streamed (README §6.3 / spec §4.2). DDL is a
// verbatim transcription executed as raw SQL on the underlying better-sqlite3 handle
// (mirroring 0001_core) — reads 1:1 against the spec and stays synchronous inside the
// runner's single transaction (see ./index.ts).
//
// ROLLBACK / BACK-COMPAT NOTE (README §5.3): both tables are NEW and purely additive —
// 0001/0002 are untouched. Manual rollback is `DROP TABLE events;` THEN `DROP TABLE
// turns;` (events → turns FK order). FORWARD-COMPAT: `events.kind` is intentionally an
// un-narrowed TEXT column and `payload_json` is the full serialized event. Unknown
// future `AgentEvent` kinds MUST round-trip as opaque JSON — readers do not enum-narrow
// or drop rows on an unrecognized `kind` (the EventsRepo parses `payload_json` back
// verbatim). This lets a newer app write kinds an older reader can still store/return.

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Create the two Phase-2 tables plus their indexes:
 *   - events(turn_id)                    — history assembly lookups per turn
 *   - UNIQUE turns(workspace_id, idx)    — one turn per (workspace, ordinal) slot
 */
function up(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE turns (
      id            TEXT PRIMARY KEY,                     -- UUIDv7
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
      idx           INTEGER NOT NULL,                     -- 0-based ordinal within the workspace
      status        TEXT NOT NULL,                        -- streaming|completed|interrupted|error
      session_id    TEXT,                                 -- harness resume handle, NULL until known
      mode          TEXT,                                 -- plan|default|auto_accept
      started_at    INTEGER NOT NULL,                     -- epoch millis
      ended_at      INTEGER,                              -- epoch millis, NULL while streaming
      input_tokens  INTEGER,                              -- usage at turn end, NULL until reported
      output_tokens INTEGER
    );

    CREATE TABLE events (
      id           TEXT PRIMARY KEY,                      -- UUIDv7
      turn_id      TEXT NOT NULL REFERENCES turns(id),
      kind         TEXT NOT NULL,                         -- AgentEvent.kind — NOT narrowed (forward-compat)
      payload_json TEXT NOT NULL,                         -- JSON.stringify(AgentEvent) — opaque round-trip
      ts           INTEGER NOT NULL                       -- epoch millis
    );

    CREATE INDEX idx_events_turn_id
      ON events (turn_id);

    CREATE UNIQUE INDEX uidx_turns_workspace_idx
      ON turns (workspace_id, idx);
  `);
}

/** Migration 0003. Registered in the ordered array in ./index.ts. */
export const migration0003TurnsEvents: Migration = {
  version: 3,
  up,
};
