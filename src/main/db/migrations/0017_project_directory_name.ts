import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

function isApplied(db: SqliteDb): boolean {
  const projectsTableExists =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
      )
      .get() !== undefined;
  // Some migration-unit fixtures intentionally model only a later table. There is
  // nothing for this additive project migration to repair in those partial schemas.
  if (!projectsTableExists) return true;
  return (
    db
      .prepare(
        "SELECT 1 FROM pragma_table_info('projects') WHERE name = 'directory_name'",
      )
      .get() !== undefined
  );
}

function up(db: SqliteDb): void {
  // Backward compatible: legacy rows remain NULL until startup reconciliation moves
  // their files successfully. Rollback is dropping the index/column after moving the
  // name-based directories back to their recorded legacy locations.
  db.exec(`
    ALTER TABLE projects ADD COLUMN directory_name TEXT;
    CREATE UNIQUE INDEX uidx_projects_directory_name
      ON projects (directory_name COLLATE NOCASE)
      WHERE directory_name IS NOT NULL;
  `);
}

export const migration0017ProjectDirectoryName: Migration = {
  version: 17,
  isApplied,
  up,
};
