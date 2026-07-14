import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from '../repos/projects';
import { WorkspacesRepo } from '../repos/workspaces';

let tmpDir: string;
let dbFile: string;
let db: AppDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-workspace-menu-'));
  dbFile = join(tmpDir, 'test.db');
  db = openDb(dbFile);
});

afterEach(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 0009 workspace menu metadata', () => {
  it('defaults existing workspaces to read and unpinned and persists toggles', async () => {
    const projects = new ProjectsRepo(db);
    const workspaces = new WorkspacesRepo(db);
    const project = await projects.create({
      name: 'demo',
      originUrl: '',
      defaultBranch: 'main',
      repoPath: '/tmp/demo',
    });
    const workspace = await workspaces.create({
      projectId: project.id,
      name: 'demo',
      branch: 'agent/demo',
      baseBranch: 'main',
      harness: 'claude_code',
      status: 'idle',
    });

    expect(workspace).toMatchObject({ isUnread: false, isPinned: false });
    await workspaces.update(workspace.id, {
      isUnread: true,
      isPinned: true,
    });
    await expect(workspaces.getById(workspace.id)).resolves.toMatchObject({
      isUnread: true,
      isPinned: true,
    });
  });

  it('adds both non-null integer columns', () => {
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      const columns = raw.pragma('table_info(workspaces)') as Array<{
        name: string;
        notnull: number;
      }>;
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'is_unread', notnull: 1 }),
          expect.objectContaining({ name: 'is_pinned', notnull: 1 }),
        ]),
      );
    } finally {
      raw.close();
    }
  });
});
