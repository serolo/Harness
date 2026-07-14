// Migration 0008 round-trip (Phase 12 — scheduled tasks).
//
// Opens a real better-sqlite3 file in os.tmpdir() (path injected into `openDb`, so no
// Electron `app.getPath` is touched) — proving migration 0008 applies on a fresh DB, the
// new `scheduled_tasks` table + its two indexes exist, a row round-trips (FK parents
// satisfied), and re-opening the same file is idempotent (mirrors
// 0005_diff_review.test.ts). Rows are inserted via the Kysely handle `openDb` returns.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from '../repos/projects';
import { WorkspacesRepo } from '../repos/workspaces';
import { TurnsRepo } from '../repos/turns';

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-scheduled-tasks-'));
  dbFile = join(tmpDir, 'test.db');
  db = undefined;
});

afterEach(async () => {
  if (db) {
    await db.destroy();
    db = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a project + workspace + turn (FK parents) and return their ids. */
async function seedTurn(
  handle: AppDatabase,
): Promise<{ workspaceId: string; turnId: string }> {
  const project = await new ProjectsRepo(handle).create({
    name: 'demo',
    originUrl: 'git@github.com:acme/demo.git',
    defaultBranch: 'main',
    repoPath: '/tmp/repo/demo',
  });
  const workspace = await new WorkspacesRepo(handle).create({
    projectId: project.id,
    name: 'paris',
    branch: 'agent/paris',
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'idle',
  });
  const turn = await new TurnsRepo(handle).create({
    workspaceId: workspace.id,
    idx: 0,
    status: 'streaming',
  });
  return { workspaceId: workspace.id, turnId: turn.id };
}

describe('migration 0008 (fresh temp DB)', () => {
  it('applies all migrations: user_version becomes 8 (latest)', () => {
    db = openDb(dbFile);
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(8);
    } finally {
      raw.close();
    }
  });

  it('creates the scheduled_tasks table + its two indexes', () => {
    db = openDb(dbFile);
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      const tables = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toContain('scheduled_tasks');

      const indexes = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(indexes).toContain('idx_scheduled_tasks_workspace_id');
      expect(indexes).toContain('idx_scheduled_tasks_due');
    } finally {
      raw.close();
    }
  });

  it('round-trips an insert/select (FK parents satisfied; nullable columns as null)', async () => {
    db = openDb(dbFile);
    const { workspaceId, turnId } = await seedTurn(db);
    const now = Date.now();

    // A fully-populated timed task referencing a turn.
    await db
      .insertInto('scheduled_tasks')
      .values({
        id: 'task-1',
        workspace_id: workspaceId,
        prompt: 'continue the work',
        model: 'sonnet',
        mode: 'plan',
        scheduled_at: now + 60_000,
        state: 'scheduled',
        origin: 'user',
        turn_id: turnId,
        error_message: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const timed = await db
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('id', '=', 'task-1')
      .executeTakeFirst();
    expect(timed).toMatchObject({
      workspace_id: workspaceId,
      prompt: 'continue the work',
      model: 'sonnet',
      mode: 'plan',
      scheduled_at: now + 60_000,
      state: 'scheduled',
      origin: 'user',
      turn_id: turnId,
    });

    // An untimed pending task: model/mode/scheduled_at/turn_id/error_message all null.
    await db
      .insertInto('scheduled_tasks')
      .values({
        id: 'task-2',
        workspace_id: workspaceId,
        prompt: 'run later',
        model: null,
        mode: null,
        scheduled_at: null,
        state: 'pending',
        origin: 'limit_resume',
        turn_id: null,
        error_message: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const untimed = await db
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('id', '=', 'task-2')
      .executeTakeFirst();
    expect(untimed).toMatchObject({
      model: null,
      mode: null,
      scheduled_at: null,
      state: 'pending',
      origin: 'limit_resume',
      turn_id: null,
      error_message: null,
    });
  });

  it('is idempotent: re-opening the same DB does not double-apply or throw', async () => {
    db = openDb(dbFile);
    await db.destroy();
    db = undefined;

    expect(() => {
      db = openDb(dbFile);
    }).not.toThrow();

    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(8);
      const count = raw
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'",
        )
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      raw.close();
    }
  });
});
