// Migration 0016 — durable chat contexts (chat tabs) per workspace.
//
// A workspace's chat panel shows several parallel sessions as tabs. Tab identity and
// membership were pure renderer state, so remounting the panel (or leaving a workspace
// and returning) collapsed every previously-separate tab's history into one. This
// migration gives a tab a real row and gives a turn a durable owner:
//
//   - ONE new table `chat_contexts` (id + workspace + label + optional resume session id
//     + 0-based tab `position` + created_at), indexed by workspace for the per-workspace
//     tab list.
//   - ONE new nullable column `turns.context_id` — the turn→context ownership edge,
//     deliberately in the same direction as the existing task→turn edge
//     (`scheduled_tasks.turn_id`) so the two never collide: a scheduler-fired turn never
//     carries a context, so a task-owned turn keeps `context_id = NULL` forever.
//
// DDL is a verbatim transcription executed as raw SQL on the better-sqlite3 handle
// (mirroring 0008_scheduled_tasks), staying synchronous inside the runner's single
// transaction (see ./index.ts). Each step is individually guarded (`hasTable`/
// `hasTurnsContextId`), so `up` is safe to call unconditionally even against a database
// that already has some or all of this migration's schema from a partial/manual repair
// or a parallel feature branch that advanced `user_version` out of band.
//
// DELIBERATELY NO `isApplied` SCHEMA PROBE, unlike 0009_workspace_menu/0014_task_effort.
// The runner (./index.ts) skips calling `up` entirely whenever `isApplied` reports the
// schema already present — but this migration's `up` does more than DDL: it also runs a
// one-time data backfill (below). A schema-only probe cannot distinguish "schema exists
// because this migration already fully ran" from "schema exists because a parallel branch
// created it out of band and the backfill never happened" — reporting `true` for the
// latter would skip the backfill forever (the version bump alone would then make every
// later boot skip this migration for good, per the routine `version <= current` fast
// path). Since `up`'s own per-step guards already make it idempotent and cheap to call
// unconditionally, omitting the probe is strictly safer than a probe that can't tell
// those two cases apart — do not add one back without solving that first.
//
// BACKFILL: pre-existing turns have no recoverable tab boundary — that flattening IS the
// bug being fixed. So every workspace that still has non-task turns with `context_id IS
// NULL` gets ONE synthesized context (`label = 'Untitled'`, `position = 0`) and those
// turns are pointed at it. This reproduces exactly what users already see today (one flat
// tab), now backed by a real, closeable row — and it removes any later "legacy vs.
// closed" ambiguity: AFTER this migration, `context_id IS NULL` on a non-task turn means
// only "this tab was explicitly closed". The backfill is self-idempotent (a re-run finds
// no NULL-context non-task turns left, so it inserts nothing).
//
// ROLLBACK / BACK-COMPAT NOTE (README §5.3 / .claude/rules/security.md): fully additive —
// one new table, one new NULLABLE column, two indexes — plus the data backfill above.
// No turn or event row is ever deleted, so the correct rollback is to DOWNGRADE THE BINARY
// AND CHANGE NOTHING: an older build never reads either object, and its turn INSERTs omit
// the nullable `context_id` (NULL) and keep working. Only tab grouping goes dormant.
//
// **Do NOT just `DROP TABLE chat_contexts`.** `openDb` runs with `PRAGMA foreign_keys = ON`,
// and `turns.context_id` carries a `REFERENCES chat_contexts(id)` clause. Verified SQLite
// behaviour with the parent table missing: SELECT still works, but any INSERT or DELETE on
// `turns` fails with `no such table: main.chat_contexts` — EVEN when `context_id` is NULL.
// So dropping the table alone leaves an app that can read history but can never record
// another turn. If the table genuinely must go, `turns` has to be rebuilt WITHOUT the
// column first (SQLite's create-new → copy → drop → rename procedure; it cannot cheaply
// drop a column added via `ALTER TABLE ADD COLUMN`), and only then
// `DROP INDEX idx_turns_context_id; DROP INDEX idx_chat_contexts_workspace_id;
// DROP TABLE chat_contexts;` (indexes first, then the table — the reverse of the DDL below).

import type { Database as SqliteDb } from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import type { Migration } from './index';

function hasTable(db: SqliteDb, name: string): boolean {
  const row = db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name) as { n: number };
  return row.n > 0;
}

function hasTurnsContextId(db: SqliteDb): boolean {
  return (
    db
      .prepare("SELECT 1 FROM pragma_table_info('turns') WHERE name = ?")
      .get('context_id') !== undefined
  );
}

/**
 * `AND`-able predicate excluding turns owned by a scheduled task, identified through the
 * EXISTING task→turn edge. `turn_id IS NOT NULL` is load-bearing, not cosmetic: SQLite's
 * `x NOT IN (…)` evaluates to NULL (i.e. never true) as soon as the list contains a NULL,
 * so without that filter a single untimed task row would silently exclude EVERY turn from
 * the backfill. Degrades to always-true when `scheduled_tasks` is absent (a repair-path DB
 * with no `turns` table either — see the early return in `up` — where by definition no
 * turn can be task-owned).
 */
function notTaskOwnedClause(db: SqliteDb): string {
  return hasTable(db, 'scheduled_tasks')
    ? 'AND id NOT IN (SELECT turn_id FROM scheduled_tasks WHERE turn_id IS NOT NULL)'
    : '';
}

/**
 * Create `chat_contexts` + `turns.context_id` (each step guarded so a partially-applied
 * database is repaired rather than erroring), then backfill one synthesized 'Untitled'
 * context per workspace that still has unowned non-task turns.
 */
function up(db: SqliteDb): void {
  if (!hasTable(db, 'chat_contexts')) {
    db.exec(`
      CREATE TABLE chat_contexts (
        id                 TEXT PRIMARY KEY,                 -- UUIDv7
        workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
        label              TEXT NOT NULL,
        initial_session_id TEXT,                             -- NULL = fresh session (no resume)
        position           INTEGER NOT NULL,                 -- 0-based tab order
        created_at         INTEGER NOT NULL                  -- epoch millis
      );

      CREATE INDEX idx_chat_contexts_workspace_id
        ON chat_contexts (workspace_id);
    `);
  }

  // A repair-path DB can lack `turns` entirely (its schema was force-advanced past 0003
  // without that table); it then has nothing to alter and nothing to backfill, and a
  // migration that throws is fatal (it runs inside `openDb`, so the app cannot boot).
  if (!hasTable(db, 'turns')) {
    return;
  }

  if (!hasTurnsContextId(db)) {
    // SQLite allows a REFERENCES clause on an added column only when its default is
    // NULL — which it is. Close semantics are enforced transactionally in the repo
    // (null-then-delete), NOT via an ON DELETE action on this column.
    db.exec(`
      ALTER TABLE turns ADD COLUMN context_id TEXT REFERENCES chat_contexts(id);

      CREATE INDEX idx_turns_context_id ON turns (context_id);
    `);
  }

  backfillUntitledContexts(db);
}

/**
 * One 'Untitled' context per workspace with pre-existing, unowned, non-task turns.
 * Self-idempotent: after this runs those turns have a `context_id`, so a second call
 * sees no candidate workspaces and inserts nothing.
 */
function backfillUntitledContexts(db: SqliteDb): void {
  const notTaskOwned = notTaskOwnedClause(db);
  const workspaceIds = db
    .prepare(
      `SELECT DISTINCT workspace_id
         FROM turns
        WHERE context_id IS NULL
          ${notTaskOwned}`,
    )
    .all() as Array<{ workspace_id: string }>;
  if (workspaceIds.length === 0) {
    return;
  }

  const insertContext = db.prepare(
    `INSERT INTO chat_contexts
       (id, workspace_id, label, initial_session_id, position, created_at)
     VALUES (?, ?, 'Untitled', NULL, 0, ?)`,
  );
  const adoptTurns = db.prepare(
    `UPDATE turns
        SET context_id = ?
      WHERE workspace_id = ?
        AND context_id IS NULL
        ${notTaskOwned}`,
  );

  const now = Date.now();
  for (const { workspace_id } of workspaceIds) {
    const contextId = uuidv7();
    insertContext.run(contextId, workspace_id, now);
    adoptTurns.run(contextId, workspace_id);
  }
}

/**
 * Migration 0016. Registered in the ordered array in ./index.ts. No `isApplied` — see the
 * header comment for why a schema-only probe would be unsafe for a migration that also
 * carries a one-time data backfill.
 */
export const migration0016ChatContexts: Migration = {
  version: 16,
  up,
};
