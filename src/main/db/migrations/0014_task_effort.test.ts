import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from './index';

let tmpDir: string;
let db: BetterSqlite3.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-task-effort-migration-'));
  db = new BetterSqlite3(join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 0014 task effort', () => {
  it('preserves existing tasks with an inherited null effort', () => {
    runMigrations(db);
    db.exec('ALTER TABLE scheduled_tasks DROP COLUMN effort;');
    db.pragma('user_version = 13');

    db.prepare(
      `INSERT INTO projects
        (id, name, origin_url, default_branch, repo_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('project-1', 'Harness', '', 'main', '/repo', 1);
    db.prepare(
      `INSERT INTO workspaces
        (id, project_id, name, branch, base_branch, worktree_path, status,
         source_kind, source_ref, harness, port, created_at, archived_at,
         pr_number, location, is_unread, is_pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'workspace-1',
      'project-1',
      'current',
      'current',
      'main',
      '/repo/current',
      'idle',
      null,
      null,
      'claude_code',
      null,
      1,
      null,
      null,
      'worktree',
      0,
      0,
    );
    db.prepare(
      `INSERT INTO scheduled_tasks
        (id, workspace_id, prompt, model, mode, scheduled_at, state, origin,
         turn_id, error_message, created_at, updated_at, harness_override,
         attachments_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'task-1',
      'workspace-1',
      'preserve me',
      null,
      null,
      null,
      'pending',
      'user',
      null,
      null,
      1,
      1,
      null,
      '[]',
    );

    runMigrations(db);

    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(
      db
        .prepare('SELECT prompt, effort FROM scheduled_tasks WHERE id = ?')
        .get('task-1'),
    ).toEqual({ prompt: 'preserve me', effort: null });
  });
});
