// Migration 0006 — integrations (Phase 5).
//
// One new table backing connected external accounts (`integrations`, spec §3): a
// GitHub or Linear connection (`kind`) with an optional human login label
// (`account_label`) and a `token_ref`. CRITICAL (spec §7): the raw OAuth/PAT token
// is NEVER a column here — `token_ref` holds ONLY the safeStorage ciphertext file
// id; the plaintext token lives encrypted at rest under `userData/secrets/` and is
// never persisted in SQLite. DDL is a verbatim transcription executed as raw SQL on
// the underlying better-sqlite3 handle (mirroring 0001_core / 0003_turns_events /
// 0005_diff_review) — reads 1:1 against the spec and stays synchronous inside the
// runner's single transaction (see ./index.ts).
//
// ROLLBACK / BACK-COMPAT NOTE (README §5.3): the `integrations` table is NEW and
// purely additive — 0001/0003/0005 are untouched. Manual rollback is
// `DROP TABLE integrations;` (drops the table and its `idx_integrations_kind` index
// together — SQLite drops an index with its table). Because no other shipped table
// references `integrations`, dropping it on a downgrade is self-contained and leaves
// the rest of the schema intact; older code that predates Phase 5 simply never reads
// or writes the table.

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Create the Phase-5 `integrations` table plus its `kind` index:
 *   - integrations(kind) — filter connected accounts by provider (github|linear)
 *
 * The token is stored ONLY as `token_ref` (safeStorage ciphertext id) — never as a
 * plaintext column (spec §7).
 */
function up(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE integrations (
      id            TEXT PRIMARY KEY,            -- UUIDv7
      kind          TEXT NOT NULL,              -- github|linear
      account_label TEXT,                        -- human login label, nullable
      token_ref     TEXT NOT NULL,              -- safeStorage ciphertext file id — NEVER the raw token
      created_at    INTEGER NOT NULL             -- epoch millis
    );

    CREATE INDEX idx_integrations_kind
      ON integrations (kind);
  `);
}

/** Migration 0006. Registered in the ordered array in ./index.ts. */
export const migration0006Integrations: Migration = {
  version: 6,
  up,
};
