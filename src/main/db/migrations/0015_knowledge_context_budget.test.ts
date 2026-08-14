import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from './index';

let tmpDir: string;
let db: BetterSqlite3.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-knowledge-budget-migration-'));
  db = new BetterSqlite3(join(tmpDir, 'test.db'));
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertProject(id: string, settings: unknown): void {
  db.prepare(
    `INSERT INTO projects
       (id, name, origin_url, default_branch, repo_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, id, '', 'main', `/repo/${id}`, 1);
  db.prepare(
    `INSERT INTO project_settings (project_id, settings_json, updated_at)
     VALUES (?, ?, ?)`,
  ).run(id, JSON.stringify(settings), 123);
}

function settingsFor(projectId: string): unknown {
  const row = db
    .prepare('SELECT settings_json FROM project_settings WHERE project_id = ?')
    .get(projectId) as { settings_json: string };
  return JSON.parse(row.settings_json) as unknown;
}

describe('migration 0015 knowledge context budget', () => {
  it('changes only the exact legacy 12000-token value and preserves the rest of each settings document', () => {
    insertProject('legacy-default', {
      agent: { mode: 'plan' },
      knowledge: {
        enabled: true,
        search: {
          provider: 'qmd',
          max_context_tokens: 12_000,
          rerank: false,
        },
      },
      env: { FEATURE_FLAG: 'kept' },
    });
    insertProject('custom-budget', {
      knowledge: { search: { max_context_tokens: 8_000 } },
      scripts: { run: 'npm test' },
    });
    insertProject('missing-budget', {
      knowledge: { enabled: false, search: { provider: 'none' } },
    });

    // Reproduce an installed pre-0015 database regardless of later migrations in
    // this checkout. The new migration must be a narrow data repair, not a reset.
    db.pragma('user_version = 14');
    runMigrations(db);

    expect(db.pragma('user_version', { simple: true })).toBe(17);
    expect(settingsFor('legacy-default')).toEqual({
      agent: { mode: 'plan' },
      knowledge: {
        enabled: true,
        search: {
          provider: 'qmd',
          max_context_tokens: 4_000,
          rerank: false,
        },
      },
      env: { FEATURE_FLAG: 'kept' },
    });
    expect(settingsFor('custom-budget')).toEqual({
      knowledge: { search: { max_context_tokens: 8_000 } },
      scripts: { run: 'npm test' },
    });
    expect(settingsFor('missing-budget')).toEqual({
      knowledge: { enabled: false, search: { provider: 'none' } },
    });
  });
});
