import type { Migration } from './index';

export const migration0011ProjectSettings: Migration = {
  version: 11,
  isApplied(db) {
    const row = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_settings'",
      )
      .get();
    return row !== undefined;
  },
  up(db) {
    db.exec(`
      CREATE TABLE project_settings (
        project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        settings_json TEXT NOT NULL,
        updated_at    INTEGER NOT NULL
      );
    `);
  },
};
