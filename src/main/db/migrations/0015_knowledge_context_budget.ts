import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

function hasLegacyDefault(db: SqliteDb): boolean {
  const tableExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_settings'",
    )
    .get();
  if (!tableExists) return false;
  const rows = db
    .prepare('SELECT settings_json FROM project_settings')
    .all() as Array<{
    settings_json: string;
  }>;
  return rows.some((row) => {
    try {
      const settings = JSON.parse(row.settings_json) as {
        knowledge?: { search?: { max_context_tokens?: unknown } };
      };
      return settings.knowledge?.search?.max_context_tokens === 12_000;
    } catch {
      return false;
    }
  });
}

/**
 * Narrow data migration for the former 12k default. Custom budgets are preserved.
 * Rollback is data-only: older binaries accept 4k; restoring 12k could overwrite a later choice.
 */
export const migration0015KnowledgeContextBudget: Migration = {
  version: 15,
  // Version 15 is shared with the meta-agent schema migration. The probe lets the
  // runner repair databases where that sibling advanced user_version first.
  isApplied: (db) => !hasLegacyDefault(db),
  up(db) {
    const rows = db
      .prepare('SELECT project_id, settings_json FROM project_settings')
      .all() as Array<{
      project_id: string;
      settings_json: string;
    }>;
    const update = db.prepare(
      'UPDATE project_settings SET settings_json = ? WHERE project_id = ?',
    );
    for (const row of rows) {
      try {
        const settings: unknown = JSON.parse(row.settings_json);
        if (!settings || typeof settings !== 'object') continue;
        const knowledge = (settings as Record<string, unknown>).knowledge;
        if (!knowledge || typeof knowledge !== 'object') continue;
        const search = (knowledge as Record<string, unknown>).search;
        if (!search || typeof search !== 'object') continue;
        const record = search as Record<string, unknown>;
        if (record.max_context_tokens !== 12_000) continue;
        record.max_context_tokens = 4_000;
        update.run(JSON.stringify(settings), row.project_id);
      } catch {
        // Invalid stored JSON remains untouched; settings validation reports it separately.
      }
    }
  },
};
