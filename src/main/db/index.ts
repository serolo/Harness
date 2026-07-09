// Database entry point: open better-sqlite3, configure pragmas, run migrations,
// and hand back a typed Kysely instance.
//
// better-sqlite3 is SYNCHRONOUS (README §7.3). At Phase-0 scale that is a feature:
// queries are fast, transactional, and simple to reason about. Keep individual
// queries small and never iterate huge result sets on the main thread. ESCAPE HATCH
// (documented, NOT built here): if DB work ever blocks the event loop under load,
// move the SQLite handle into an Electron `utilityProcess` and marshal queries over
// a port — the Kysely `Database` type below is the seam that would move with it.

import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { dbPath } from '../paths';
import type { Database } from './schema';
import { runMigrations } from './migrations';

/**
 * The typed database handle. `AppContext` (Task 5) imports THIS type (type-only)
 * so every subsystem shares one contract. Re-exported so callers depend on the
 * alias, not on `Kysely` + the schema module directly.
 */
export type AppDatabase = Kysely<Database>;

export type { Database } from './schema';

/**
 * Open the SQLite database, apply pragmas + migrations, and return the Kysely handle.
 *
 * @param path Optional filesystem path to the DB file. When omitted, falls back to
 *   `paths.dbPath()` (the real `<userData>/app.db`). The injectable path mirrors the
 *   `paths.ts` test seam and is CRITICAL for tests: main-process unit tests (Task 10)
 *   run under node/vitest with NO Electron runtime, so they open a temp-file DB by
 *   passing a path here instead of triggering `app.getPath('userData')`.
 *
 * Pragmas (set on the raw handle before Kysely wraps it):
 *   - `journal_mode = WAL`  — concurrent readers alongside a writer; better crash safety.
 *   - `foreign_keys = ON`   — enforce the workspaces→projects FK (off by default in SQLite).
 */
export function openDb(path?: string): AppDatabase {
  const file = path ?? dbPath();

  const sqlite = new BetterSqlite3(file);
  // WAL must be set before other writes to take effect for the connection.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Run migrations directly against the raw handle (synchronous, transactional).
  runMigrations(sqlite);

  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}
