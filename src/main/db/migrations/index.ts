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
import { migration0008WorkspaceLocation } from './0008_workspace_location';
import { migration0009WorkspaceMenu } from './0009_workspace_menu';

/**
 * One numbered migration. `up` receives the raw better-sqlite3 handle and runs
 * synchronously; the runner wraps each call in a transaction, so `up` must not
 * open its own. Additive migrations may provide `isApplied` when they can safely
 * verify their schema change independently of `user_version`. This repairs databases
 * produced by parallel feature branches that temporarily reused a version number.
 */
export interface Migration {
  version: number;
  isApplied?(db: SqliteDb): boolean;
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
  migration0008WorkspaceLocation,
  migration0009WorkspaceMenu,
];

/** Read the current schema version from `PRAGMA user_version`. */
function getUserVersion(db: SqliteDb): number {
  // pragma() returns [{ user_version: N }] for a value pragma.
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : 0;
}

/**
 * Apply all pending migrations in ascending version order. Idempotent and
 * re-runnable: migrations normally skip by version; migrations with a schema probe
 * can repair a missing additive change even when user_version is already at or above it.
 *
 * Each migration is applied inside its own transaction and the `user_version` is
 * bumped in the SAME transaction — so a mid-migration crash leaves the version
 * unchanged and the migration is retried cleanly on next boot (all-or-nothing).
 */
export function runMigrations(db: SqliteDb): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  let current = getUserVersion(db);

  for (const migration of ordered) {
    const hasSchemaProbe = migration.isApplied !== undefined;
    const schemaApplied = migration.isApplied?.(db) ?? false;
    if (migration.version <= current && (!hasSchemaProbe || schemaApplied)) {
      continue;
    }

    // better-sqlite3 transaction: throws → rolls back, leaving user_version intact.
    const apply = db.transaction((m: Migration) => {
      // A schema probe can report that an additive change already exists even when
      // user_version is behind. In that case only advance the version marker.
      if (!schemaApplied) {
        m.up(db);
      }
      const nextVersion = Math.max(current, m.version);
      // PRAGMA can't be parameterized; versions are integers controlled by migrations.
      db.pragma(`user_version = ${nextVersion}`);
      current = nextVersion;
    });
    apply(migration);
  }
}
