import type { Migration } from './index';

/**
 * Additive and rollback-compatible: older binaries ignore this nullable column.
 * Manual rollback may rebuild `scheduled_tasks` without `harness_override`; values
 * in that column are the only data lost.
 */
export const migration0012TaskHarnessOverride: Migration = {
  version: 12,
  isApplied(db) {
    return (
      db
        .prepare(
          "SELECT 1 FROM pragma_table_info('scheduled_tasks') WHERE name = ?",
        )
        .get('harness_override') !== undefined
    );
  },
  up(db) {
    db.exec(
      'ALTER TABLE scheduled_tasks ADD COLUMN harness_override TEXT NULL;',
    );
  },
};
