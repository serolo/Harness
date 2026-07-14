// Migration runner — tiny, explicit, idempotent.
//
// Applied version is tracked via SQLite's built-in `PRAGMA user_version` (a 32-bit
// int stored in the DB header) rather than a bookkeeping table — no extra schema,
// and it survives WAL checkpoints. On startup we apply every migration whose
// `version` is greater than the current `user_version`, IN ORDER, each inside its
// own transaction, bumping `user_version` at the end of each.
//
// Guarantees the round-trip test (Task 10) asserts:
//   - Fresh DB (user_version 0): all pending migrations apply exactly once.
//   - Re-run on an up-to-date DB: no migration re-applies (no double-apply / errors).

import type { Database as SqliteDb } from 'better-sqlite3';
import { migration0001Core } from './0001_core';
import { migration0003TurnsEvents } from './0003_turns_events';
import { migration0005DiffReview } from './0005_diff_review';
import { migration0006Integrations } from './0006_integrations';
import { migration0007WorkspacePr } from './0007_workspace_pr';
import { migration0008ScheduledTasks } from './0008_scheduled_tasks';

/**
 * One numbered migration. `up` receives the raw better-sqlite3 handle and runs
 * synchronously; the runner wraps each call in a transaction, so `up` must not
 * open its own. `version` MUST be unique, contiguous, and strictly increasing.
 */
export interface Migration {
  version: number;
  up(db: SqliteDb): void;
}

/**
 * The ordered migration list. APPEND-ONLY: later phases add their migration at
 * the end (version 2, 3, …) and never edit a shipped one (README §5.3).
 * Kept sorted by `version` at construction; the runner also sorts defensively.
 */
const migrations: readonly Migration[] = [
  migration0001Core,
  migration0003TurnsEvents,
  migration0005DiffReview,
  migration0006Integrations,
  migration0007WorkspacePr,
  migration0008ScheduledTasks,
];

/** Read the current schema version from `PRAGMA user_version`. */
function getUserVersion(db: SqliteDb): number {
  // pragma() returns [{ user_version: N }] for a value pragma.
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : 0;
}

/**
 * Apply all pending migrations in ascending version order. Idempotent and
 * re-runnable: a DB already at (or above) a migration's version skips it.
 *
 * Each migration is applied inside its own transaction and the `user_version` is
 * bumped in the SAME transaction — so a mid-migration crash leaves the version
 * unchanged and the migration is retried cleanly on next boot (all-or-nothing).
 */
export function runMigrations(db: SqliteDb): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const current = getUserVersion(db);

  for (const migration of ordered) {
    if (migration.version <= current) {
      continue; // already applied — skip (idempotent re-run)
    }

    // better-sqlite3 transaction: throws → rolls back, leaving user_version intact.
    const apply = db.transaction((m: Migration) => {
      m.up(db);
      // PRAGMA can't be parameterized; version is an integer we control (not user input).
      db.pragma(`user_version = ${m.version}`);
    });
    apply(migration);
  }
}
