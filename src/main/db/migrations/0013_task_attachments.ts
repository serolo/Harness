import type { Migration } from './index';

/**
 * Additive and rollback-compatible: existing tasks receive an empty JSON attachment
 * array. Older binaries ignore the new column. Manual rollback may rebuild
 * `scheduled_tasks` without `attachments_json`; attached-file metadata is the only
 * data lost.
 */
export const migration0013TaskAttachments: Migration = {
  version: 13,
  isApplied(db) {
    return (
      db
        .prepare(
          "SELECT 1 FROM pragma_table_info('scheduled_tasks') WHERE name = ?",
        )
        .get('attachments_json') !== undefined
    );
  },
  up(db) {
    db.exec(
      "ALTER TABLE scheduled_tasks ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';",
    );
  },
};
