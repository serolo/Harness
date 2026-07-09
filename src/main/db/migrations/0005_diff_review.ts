// Migration 0005 — diff review + checkpoints (Phase 4).
//
// Three new tables backing the review loop: `checkpoints` (per-turn `git commit-tree`
// snapshots used for revert, spec §9), `diff_comments` (inline review comments that
// become `diff_comment` agent attachments), and `todos` (fed by agent `todo_update`
// events, README §6.3). Also widens `turns` with a nullable `reverted_at` so a revert
// can mark a turn as excluded from history/`latestSessionId` without deleting its row
// (Phase-4 plan, design decision 3). DDL is a verbatim transcription executed as raw
// SQL on the underlying better-sqlite3 handle (mirroring 0001_core / 0003_turns_events)
// — reads 1:1 against the spec and stays synchronous inside the runner's single
// transaction (see ./index.ts).
//
// ROLLBACK / BACK-COMPAT NOTE (README §5.3): all three tables are NEW and purely
// additive — 0001/0003 are untouched. Manual rollback is `DROP TABLE todos;` THEN
// `DROP TABLE diff_comments;` THEN `DROP TABLE checkpoints;` (no FK dependencies
// between them, so order doesn't matter for these three, but this order undoes the
// DDL below in reverse). The `turns.reverted_at` column is additive (nullable, no
// default needed beyond SQLite's implicit NULL) — leaving it in place on a downgrade
// is harmless: older code that doesn't know about the column simply never reads or
// writes it, and existing rows are unaffected because SQLite's `ALTER TABLE ADD
// COLUMN` backfills NULL for every existing row rather than rewriting them.

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Create the three Phase-4 tables plus their `workspace_id` indexes, and widen
 * `turns` with the nullable `reverted_at` column:
 *   - checkpoints(workspace_id)     — per-workspace checkpoint timeline lookups
 *   - diff_comments(workspace_id)   — per-workspace inline comment lookups
 *   - todos(workspace_id)           — per-workspace todo list lookups
 */
function up(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE checkpoints (
      id           TEXT PRIMARY KEY,                 -- UUIDv7
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      turn_id      TEXT NOT NULL REFERENCES turns(id),
      ref_name     TEXT NOT NULL,                     -- refs/checkpoints/<ws>/<idx>
      sha          TEXT NOT NULL,                     -- commit-tree SHA
      created_at   INTEGER NOT NULL                   -- epoch millis
    );

    CREATE TABLE diff_comments (
      id           TEXT PRIMARY KEY,                  -- UUIDv7
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      file_path    TEXT NOT NULL,
      line_start   INTEGER,                            -- NULL for a file-level comment
      line_end     INTEGER,                            -- NULL for a file-level comment
      side         TEXT,                               -- old|new, NULL for a file-level comment
      body         TEXT NOT NULL,
      state        TEXT NOT NULL,                      -- open|sent|resolved
      created_at   INTEGER NOT NULL                     -- epoch millis
    );

    CREATE TABLE todos (
      id           TEXT PRIMARY KEY,                  -- UUIDv7
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      body         TEXT NOT NULL,
      done         INTEGER NOT NULL,                   -- 0/1 — SQLite has no boolean
      source       TEXT NOT NULL,                       -- user|agent
      created_at   INTEGER NOT NULL,                    -- epoch millis
      updated_at   INTEGER NOT NULL                      -- epoch millis
    );

    CREATE INDEX idx_checkpoints_workspace_id
      ON checkpoints (workspace_id);

    CREATE INDEX idx_diff_comments_workspace_id
      ON diff_comments (workspace_id);

    CREATE INDEX idx_todos_workspace_id
      ON todos (workspace_id);

    ALTER TABLE turns ADD COLUMN reverted_at INTEGER; -- epoch millis, NULL unless reverted
  `);
}

/** Migration 0005. Registered in the ordered array in ./index.ts. */
export const migration0005DiffReview: Migration = {
  version: 5,
  up,
};
