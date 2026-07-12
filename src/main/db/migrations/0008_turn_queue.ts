// Migration 0008 — queued_messages (Phase 9).
//
// Adds the `queued_messages` table backing the durable, per-workspace follow-up message
// queue (spec — mid-turn steer & message queue §3.2). Each row is one unsent follow-up
// prompt; `order_idx` is the 0-based, contiguous position within a workspace's queue.
// DDL is a verbatim transcription executed as raw SQL on the underlying better-sqlite3
// handle (mirroring 0007_workspace_pr) — stays synchronous inside the runner's single
// transaction (see ./index.ts).
//
// ROLLBACK / BACK-COMPAT NOTE (README §5.3): the table is additive and self-contained (a
// NEW table + index, with no change to any existing table). Leaving it in place on a
// downgrade is harmless — older code never reads or writes `queued_messages`. Dropping it
// on a rollback loses only unsent queued follow-up messages (no core data: turns/events/
// workspaces are untouched), so there is no destructive redo to reconcile.

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Create the `queued_messages` table + its per-workspace ordering index. `mode` is
 * nullable (falls back to the settings default at send time); `attachments_json` stores
 * the serialized `Attachment[]` (defaults to an empty array).
 */
function up(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE queued_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      prompt TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      mode TEXT,
      order_idx INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_queued_messages_workspace ON queued_messages(workspace_id, order_idx);
  `);
}

/** Migration 0008. Registered in the ordered array in ./index.ts. */
export const migration0008TurnQueue: Migration = {
  version: 8,
  up,
};
