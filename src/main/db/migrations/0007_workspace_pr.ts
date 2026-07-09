// Migration 0007 — workspaces.pr_number (Phase 5).
//
// Widens the `workspaces` table with a nullable `pr_number` so a workspace can record
// the GitHub pull request opened for its branch (spec §5.6). Additive column, no
// default beyond SQLite's implicit NULL — `pr_number` stays NULL until a PR is opened
// for the workspace. DDL is a verbatim transcription executed as raw SQL on the
// underlying better-sqlite3 handle (mirroring 0005_diff_review's `turns.reverted_at`
// widen) — stays synchronous inside the runner's single transaction (see ./index.ts).
//
// ROLLBACK / BACK-COMPAT NOTE (README §5.3): `workspaces.pr_number` is additive
// (nullable, no default needed beyond SQLite's implicit NULL) — leaving it in place on
// a downgrade is harmless: older code that doesn't know about the column simply never
// reads or writes it, and existing rows are unaffected because SQLite's `ALTER TABLE
// ADD COLUMN` backfills NULL for every existing row rather than rewriting them (same
// reasoning as 0005's `turns.reverted_at`).

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Widen `workspaces` with the nullable `pr_number` column (the GitHub PR number
 * opened for the workspace's branch, NULL until a PR exists).
 */
function up(db: SqliteDb): void {
  db.exec(`
    ALTER TABLE workspaces ADD COLUMN pr_number INTEGER; -- PR number, NULL until a PR is opened
  `);
}

/** Migration 0007. Registered in the ordered array in ./index.ts. */
export const migration0007WorkspacePr: Migration = {
  version: 7,
  up,
};
