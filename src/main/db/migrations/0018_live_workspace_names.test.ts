// Regression coverage for upgrading the legacy all-rows workspace-name uniqueness
// rule. Archived history may retain a display name, while the database must still
// enforce that at most one live workspace per project uses that name.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { openDb, type AppDatabase } from '../index';
import { WorkspacesRepo } from '../repos/workspaces';

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-live-workspace-name-'));
  dbFile = join(tmpDir, 'test.db');

  // Reproduce an installed v17 database, including an archived workspace whose
  // name the user now wants to reuse. Later migrations are intentionally skipped
  // via user_version so this fixture isolates the v18 index/data upgrade.
  const legacy = new BetterSqlite3(dbFile);
  legacy.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      origin_url TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      directory_name TEXT
    );

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      worktree_path TEXT,
      status TEXT NOT NULL,
      source_kind TEXT,
      source_ref TEXT,
      harness TEXT NOT NULL,
      port INTEGER,
      created_at INTEGER NOT NULL,
      archived_at INTEGER,
      pr_number INTEGER,
      location TEXT NOT NULL DEFAULT 'worktree',
      is_unread INTEGER NOT NULL DEFAULT 0,
      is_pinned INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_workspaces_project_id ON workspaces (project_id);
    CREATE UNIQUE INDEX uidx_workspaces_project_id_name
      ON workspaces (project_id, name);

    INSERT INTO projects
      (id, name, origin_url, default_branch, repo_path, created_at, directory_name)
    VALUES
      ('project-1', 'demo', '', 'main', '/tmp/demo', 1, 'demo');

    INSERT INTO workspaces
      (id, project_id, name, branch, base_branch, worktree_path, status,
       source_kind, source_ref, harness, port, created_at, archived_at,
       pr_number, location, is_unread, is_pinned)
    VALUES
      ('archived-1', 'project-1', 'PR 7544', 'pr-7544', 'main', NULL,
       'archived', 'pr', '7544', 'claude_code', NULL, 1, 2, 7544,
       'worktree', 0, 0);

    PRAGMA user_version = 17;
  `);
  legacy.close();
});

afterEach(async () => {
  await db?.destroy();
  db = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 0018 live workspace name uniqueness', () => {
  it('preserves archived duplicates while allowing exactly one live row per project and name', async () => {
    db = openDb(dbFile);
    const workspaces = new WorkspacesRepo(db);

    const firstReplacement = await workspaces.create({
      projectId: 'project-1',
      name: 'PR 7544',
      branch: 'replacement-1',
      baseBranch: 'main',
      harness: 'claude_code',
      status: 'idle',
    });
    await workspaces.update(firstReplacement.id, {
      status: 'archived',
      archivedAt: 3,
      worktreePath: null,
    });

    const live = await workspaces.create({
      projectId: 'project-1',
      name: 'PR 7544',
      branch: 'replacement-2',
      baseBranch: 'main',
      harness: 'claude_code',
      status: 'idle',
    });

    const rows = await workspaces.listByProject('project-1');
    expect(
      rows.filter((workspace) => workspace.status === 'archived'),
    ).toHaveLength(2);
    expect(rows.filter((workspace) => workspace.status !== 'archived')).toEqual(
      [expect.objectContaining({ id: live.id, name: 'PR 7544' })],
    );

    await expect(
      workspaces.create({
        projectId: 'project-1',
        name: 'PR 7544',
        branch: 'replacement-3',
        baseBranch: 'main',
        harness: 'claude_code',
        status: 'idle',
      }),
    ).rejects.toThrow(/unique/i);
  });
});
