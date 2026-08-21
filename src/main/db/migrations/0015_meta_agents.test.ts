import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from './index';

let tmpDir: string;
let db: BetterSqlite3.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-meta-agent-migration-'));
  db = new BetterSqlite3(join(tmpDir, 'test.db'));
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function columns(table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((row) => row.name);
}

function rollback0015(): void {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    ALTER TABLE scheduled_tasks RENAME TO scheduled_tasks_v15;
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      prompt TEXT NOT NULL,
      model TEXT,
      mode TEXT,
      scheduled_at INTEGER,
      state TEXT NOT NULL,
      origin TEXT NOT NULL,
      turn_id TEXT REFERENCES turns(id),
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      harness_override TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      effort TEXT
    );
    INSERT INTO scheduled_tasks
      (id, workspace_id, prompt, model, mode, scheduled_at, state, origin,
       turn_id, error_message, created_at, updated_at, harness_override,
       attachments_json, effort)
    SELECT id, workspace_id, prompt, model, mode, scheduled_at, state, origin,
       turn_id, error_message, created_at, updated_at, harness_override,
       attachments_json, effort
    FROM scheduled_tasks_v15;
    DROP TABLE scheduled_tasks_v15;
    CREATE INDEX idx_scheduled_tasks_workspace_id
      ON scheduled_tasks (workspace_id);
    CREATE INDEX idx_scheduled_tasks_due
      ON scheduled_tasks (state, scheduled_at);
    DROP TABLE agent_dispatches;
    DROP TABLE agent_runs;
  `);
  db.pragma('user_version = 14');
  db.pragma('foreign_keys = ON');
}

function seedExistingTask(): void {
  db.exec(`
    INSERT INTO projects (id, name, origin_url, default_branch, repo_path, created_at)
    VALUES ('p', 'Project', '', 'main', '/repo', 1);
    INSERT INTO workspaces
    (id, project_id, name, branch, base_branch, worktree_path, status, source_kind,
     source_ref, harness, port, created_at, archived_at, pr_number, location, is_unread, is_pinned)
    VALUES ('w', 'p', 'main', 'main', 'main', '/repo', 'idle', NULL, NULL,
     'claude_code', NULL, 1, NULL, NULL, 'worktree', 0, 0);
    INSERT INTO scheduled_tasks
    (id, workspace_id, prompt, model, mode, scheduled_at, state, origin, turn_id,
     error_message, created_at, updated_at, harness_override, attachments_json, effort)
    VALUES ('t', 'w', 'preserve me', NULL, NULL, NULL, 'pending', 'user', NULL,
     NULL, 1, 1, NULL, '[]', NULL);
  `);
}

describe('migration 0015 meta agents', () => {
  it('creates the run/dispatch tables, task snapshot columns, and expected indexes', () => {
    runMigrations(db);

    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(columns('agent_runs')).toContain('snapshot_digest');
    expect(columns('agent_runs')).not.toEqual(
      expect.arrayContaining(['debate_stage', 'debate_round']),
    );
    expect(columns('agent_dispatches')).toContain('changed_files_json');
    expect(columns('agent_dispatches')).toEqual(
      expect.arrayContaining(['debate_stage', 'debate_round']),
    );
    expect(columns('scheduled_tasks')).toEqual(
      expect.arrayContaining([
        'agent_id',
        'agent_name',
        'agent_revision',
        'agent_snapshot_json',
        'agent_snapshot_digest',
        'meta_run_id',
      ]),
    );
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[];
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'agent_runs_project_created_idx',
        'agent_runs_status_idx',
        'agent_dispatches_run_created_idx',
        'agent_dispatches_status_idx',
      ]),
    );
  });

  it('is idempotent at application startup', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE name = 'agent_runs'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it('preserves existing scheduled tasks with null agent metadata', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO projects (id, name, origin_url, default_branch, repo_path, created_at)
       VALUES ('p', 'Project', '', 'main', '/repo', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO workspaces
       (id, project_id, name, branch, base_branch, worktree_path, status, source_kind,
        source_ref, harness, port, created_at, archived_at, pr_number, location, is_unread, is_pinned)
       VALUES ('w', 'p', 'main', 'main', 'main', '/repo', 'idle', NULL, NULL,
        'claude_code', NULL, 1, NULL, NULL, 'worktree', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO scheduled_tasks
       (id, workspace_id, prompt, model, mode, scheduled_at, state, origin, turn_id,
        error_message, created_at, updated_at, harness_override, attachments_json, effort)
       VALUES ('t', 'w', 'preserve me', NULL, NULL, NULL, 'pending', 'user', NULL,
        NULL, 1, 1, NULL, '[]', NULL)`,
    ).run();

    runMigrations(db);
    expect(
      db
        .prepare(
          `SELECT prompt, agent_id, agent_snapshot_json, meta_run_id
         FROM scheduled_tasks WHERE id = 't'`,
        )
        .get(),
    ).toEqual({
      prompt: 'preserve me',
      agent_id: null,
      agent_snapshot_json: null,
      meta_run_id: null,
    });
  });

  it('enforces closed run, dispatch, consent, provider, and ownership constraints', () => {
    runMigrations(db);
    db.exec(`
      INSERT INTO projects (id, name, origin_url, default_branch, repo_path, created_at)
      VALUES ('p', 'Project', '', 'main', '/repo', 1);
      INSERT INTO workspaces
      (id, project_id, name, branch, base_branch, worktree_path, status, source_kind,
       source_ref, harness, port, created_at, archived_at, pr_number, location, is_unread, is_pinned)
      VALUES ('w', 'p', 'main', 'main', 'main', '/repo', 'idle', NULL, NULL,
       'claude_code', NULL, 1, NULL, NULL, 'worktree', 0, 0);
    `);
    const insertRun = db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, source_workspace_id, coordinator_workspace_id, agent_id,
        agent_name, agent_revision, snapshot_json, snapshot_digest, goal, allow_push,
        allow_open_pr, status, created_at)
       VALUES (?, 'p', 'w', NULL, 'builtin:test', 'Test', 'r', '{}', 'd', 'goal', ?, 0, ?, 1)`,
    );
    expect(() => insertRun.run('bad-consent', 2, 'starting')).toThrow();
    expect(() => insertRun.run('bad-status', 0, 'unknown')).toThrow();
    insertRun.run('run', 0, 'starting');
    const insertDispatch = db.prepare(
      `INSERT INTO agent_dispatches
       (id, run_id, role, purpose, child_agent_slug, harness, status,
        changed_files_json, created_at)
       VALUES (?, ?, 'worker', ?, 'worker', ?, 'pending', '[]', 1)`,
    );
    expect(() =>
      insertDispatch.run('d1', 'missing', 'implement', 'codex'),
    ).toThrow();
    expect(() => insertDispatch.run('d2', 'run', 'merge', 'codex')).toThrow();
    expect(() =>
      insertDispatch.run('d3', 'run', 'implement', 'bash'),
    ).toThrow();
  });

  it('upgrades a true pre-0015 database and preserves its existing task', () => {
    runMigrations(db);
    rollback0015();
    seedExistingTask();

    runMigrations(db);

    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(columns('scheduled_tasks')).toContain('agent_snapshot_digest');
    expect(
      db
        .prepare("SELECT prompt, agent_id FROM scheduled_tasks WHERE id = 't'")
        .get(),
    ).toEqual({ prompt: 'preserve me', agent_id: null });
  });

  it('documents an executable rollback that loses only meta-agent metadata', () => {
    runMigrations(db);
    seedExistingTask();
    db.prepare(
      `UPDATE scheduled_tasks
       SET agent_id = 'project:p:a', agent_name = 'Agent', agent_revision = 'r',
           agent_snapshot_json = '{}', agent_snapshot_digest = 'digest'
       WHERE id = 't'`,
    ).run();

    rollback0015();

    expect(columns('scheduled_tasks')).not.toContain('agent_id');
    expect(
      db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 't'").get(),
    ).toEqual({ prompt: 'preserve me' });
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'agent_runs'")
        .get(),
    ).toBeUndefined();
  });
});
