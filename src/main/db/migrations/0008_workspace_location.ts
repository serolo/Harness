// Migration 0008 — distinguish managed worktrees from the project's checkout.
//
// Existing rows are managed worktrees, so the NOT NULL default preserves their
// archive/restore behaviour. Project-checkout workspaces store `project` and are
// never removed from disk by WorkspaceManager.
//
// ROLLBACK / BACK-COMPAT: this is an additive column with a conservative default,
// so older builds can still read the table and existing rows remain worktrees. Before
// downgrading, archive every `project`-location workspace in the newer build: an older
// build does not understand the ownership flag and may otherwise try to manage that
// checkout as a removable worktree. Leaving the column itself in place is harmless.

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

function isApplied(db: SqliteDb): boolean {
  const columns = db.pragma('table_info(workspaces)') as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === 'location');
}

function up(db: SqliteDb): void {
  db.exec(`
    ALTER TABLE workspaces
      ADD COLUMN location TEXT NOT NULL DEFAULT 'worktree';
  `);
}

export const migration0008WorkspaceLocation: Migration = {
  version: 8,
  isApplied,
  up,
};
