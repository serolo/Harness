import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

const INDEX_NAME = 'uidx_workspaces_project_id_name';

function isApplied(db: SqliteDb): boolean {
  const workspacesTableExists =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'",
      )
      .get() !== undefined;
  // Partial-schema migration fixtures may intentionally omit the core tables.
  if (!workspacesTableExists) return true;
  const columns = new Set(
    (db.pragma('table_info(workspaces)') as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (
    !columns.has('project_id') ||
    !columns.has('name') ||
    !columns.has('status')
  ) {
    return true;
  }

  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(INDEX_NAME) as { sql?: string | null } | undefined;
  const normalized = row?.sql?.replace(/\s+/g, ' ').toLowerCase() ?? '';
  return normalized.includes("where status <> 'archived'");
}

function up(db: SqliteDb): void {
  // Archive preserves workspace rows and their related history, but it releases the
  // display name. Keep SQLite as the concurrency guard for live rows while allowing
  // any number of archived records to retain that name.
  //
  // Rollback note: recreating the former all-row unique index is only safe after any
  // duplicate archived names have been renamed. Never delete archived rows implicitly.
  db.exec(`
    DROP INDEX IF EXISTS ${INDEX_NAME};
    CREATE UNIQUE INDEX ${INDEX_NAME}
      ON workspaces (project_id, name)
      WHERE status <> 'archived';
  `);
}

export const migration0018LiveWorkspaceNames: Migration = {
  version: 18,
  isApplied,
  up,
};
