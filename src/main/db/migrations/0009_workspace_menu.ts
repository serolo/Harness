// Migration 0009 — persistent workspace context-menu metadata.
//
// Both flags are additive, non-null booleans represented as SQLite INTEGER 0/1.
// Defaults preserve the existing list: every current workspace starts read + unpinned.
// The schema probe and per-column guards make this safe to retry after a partial/manual
// repair and protect databases whose user_version was advanced by a parallel branch.
//
// ROLLBACK / BACK-COMPAT: older builds ignore both additive columns. Leaving them in
// place on downgrade is harmless; their values become visible again after upgrading.

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

function columns(db: SqliteDb): Set<string> {
  return new Set(
    (db.pragma('table_info(workspaces)') as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
}

function isApplied(db: SqliteDb): boolean {
  const names = columns(db);
  return names.has('is_unread') && names.has('is_pinned');
}

function up(db: SqliteDb): void {
  const names = columns(db);
  if (!names.has('is_unread')) {
    db.exec(
      'ALTER TABLE workspaces ADD COLUMN is_unread INTEGER NOT NULL DEFAULT 0;',
    );
  }
  if (!names.has('is_pinned')) {
    db.exec(
      'ALTER TABLE workspaces ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;',
    );
  }
}

export const migration0009WorkspaceMenu: Migration = {
  version: 9,
  isApplied,
  up,
};
