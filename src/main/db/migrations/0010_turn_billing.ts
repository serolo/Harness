// Migration 0010 — additive billing metadata for global usage reporting.
//
// Existing turns retain NULL billing fields and are reported as unpriced rather than
// guessed. Older application versions ignore the added columns. A manual schema rollback
// requires rebuilding `turns`, as portable SQLite cannot drop this column set in place.

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

function hasColumn(db: SqliteDb, name: string): boolean {
  const rows = db.pragma('table_info(turns)') as Array<{ name: string }>;
  // Some repair tests and very early development DBs contain only `workspaces`.
  // There is no turn usage to migrate in that shape, so advancing the marker is safe.
  if (rows.length === 0) return true;
  return rows.some((row) => row.name === name);
}

function up(db: SqliteDb): void {
  db.exec(`
    ALTER TABLE turns ADD COLUMN harness TEXT;
    ALTER TABLE turns ADD COLUMN model TEXT;
    ALTER TABLE turns ADD COLUMN cached_input_tokens INTEGER;
    ALTER TABLE turns ADD COLUMN cache_write_input_tokens INTEGER;
    ALTER TABLE turns ADD COLUMN cost_micros INTEGER;
    ALTER TABLE turns ADD COLUMN pricing_key TEXT;
    CREATE INDEX idx_turns_billing_month ON turns (started_at, reverted_at);
  `);
}

export const migration0010TurnBilling: Migration = {
  version: 10,
  isApplied: (db) => hasColumn(db, 'pricing_key'),
  up,
};
