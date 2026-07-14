// Migration 0008 — scheduled tasks (Phase 12).
//
// One new table backing the per-workspace scheduled-task system (design doc §5.2): a
// task carries a prompt + optional model + optional permission mode + an OPTIONAL
// one-shot `scheduled_at`, a lifecycle `state`, an `origin` (user vs limit-resume), and a
// nullable `turn_id` back-reference once it has produced a turn. DDL is a verbatim
// transcription executed as raw SQL on the better-sqlite3 handle (mirroring
// 0005_diff_review), staying synchronous inside the runner's single transaction
// (see ./index.ts).
//
// ROLLBACK / BACK-COMPAT NOTE (README §5.3 / .claude/rules/security.md): purely additive —
// ONE new table, no existing table touched, and older app versions never read it. Manual
// rollback is `DROP INDEX idx_scheduled_tasks_due; DROP INDEX
// idx_scheduled_tasks_workspace_id; DROP TABLE scheduled_tasks;` (drop the indexes first,
// then the table — the reverse of the DDL below). There is no data to migrate back: an
// older binary simply stops writing/reading the table.

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Create the `scheduled_tasks` table plus two indexes:
 *   - idx_scheduled_tasks_workspace_id — per-workspace list lookups (`task:list`).
 *   - idx_scheduled_tasks_due — the (state, scheduled_at) index the tick's `listDue`
 *     scan uses to find due `scheduled` rows cheaply.
 */
function up(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id            TEXT PRIMARY KEY,                 -- UUIDv7
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
      prompt        TEXT NOT NULL,
      model         TEXT,                             -- NULL = CLI default
      mode          TEXT,                             -- plan|default|auto_accept; NULL = settings default
      scheduled_at  INTEGER,                          -- epoch millis; NULL = untimed
      state         TEXT NOT NULL,                    -- pending|scheduled|queued|running|done|missed|error
      origin        TEXT NOT NULL,                    -- user|limit_resume
      turn_id       TEXT REFERENCES turns(id),        -- NULL until the task has run
      error_message TEXT,
      created_at    INTEGER NOT NULL,                 -- epoch millis
      updated_at    INTEGER NOT NULL                  -- epoch millis
    );

    CREATE INDEX idx_scheduled_tasks_workspace_id
      ON scheduled_tasks (workspace_id);

    CREATE INDEX idx_scheduled_tasks_due
      ON scheduled_tasks (state, scheduled_at);
  `);
}

/** Migration 0008. Registered in the ordered array in ./index.ts. */
export const migration0008ScheduledTasks: Migration = {
  version: 8,
  up,
};
