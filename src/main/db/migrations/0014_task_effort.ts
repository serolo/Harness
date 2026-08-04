import type { Migration } from './index';

/**
 * Additive and rollback-compatible: existing tasks inherit the app's default effort
 * through NULL. Older binaries ignore the new column. Manual rollback may rebuild
 * `scheduled_tasks` without `effort`; only task-specific effort overrides are lost.
 */
export const migration0014TaskEffort: Migration = {
  version: 14,
  isApplied(db) {
    return (
      db
        .prepare(
          "SELECT 1 FROM pragma_table_info('scheduled_tasks') WHERE name = ?",
        )
        .get('effort') !== undefined
    );
  },
  up(db) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN effort TEXT;');
  },
};
