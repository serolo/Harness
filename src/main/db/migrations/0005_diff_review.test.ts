// Migration 0005 round-trip (Phase 4 — diff review + checkpoints).
//
// Opens a real better-sqlite3 file in os.tmpdir() (path injected into `openDb`, so
// no Electron `app.getPath` is touched) — proving migration 0005 applies on a fresh
// DB, the three new tables + indexes exist, `turns.reverted_at` is present and
// nullable, and re-opening the same file is idempotent (mirrors index.test.ts /
// repos/turns.test.ts). Repos for `checkpoints`/`diff_comments`/`todos` land in a
// later task, so rows are inserted directly via the Kysely handle `openDb` returns.

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
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-diff-review-'));
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

describe('migration 0005 (fresh temp DB)', () => {
  it('applies all migrations: user_version becomes 7 (latest)', () => {
    db = openDb(dbFile);

    // Inspect the raw file with a fresh handle (asserts persisted state, not the
    // Kysely cache) — mirrors index.test.ts's version assertion for 0001-0003.
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
    } finally {
      raw.close();
    }
  });

  it('creates checkpoints, diff_comments, todos tables + their workspace_id indexes', () => {
    db = openDb(dbFile);
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      const tables = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toContain('checkpoints');
      expect(tables).toContain('diff_comments');
      expect(tables).toContain('todos');

      const indexes = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(indexes).toContain('idx_checkpoints_workspace_id');
      expect(indexes).toContain('idx_diff_comments_workspace_id');
      expect(indexes).toContain('idx_todos_workspace_id');
    } finally {
      raw.close();
    }
  });

  it('round-trips an insert/select on all three new tables (FK parents satisfied)', async () => {
    db = openDb(dbFile);
    const { workspaceId, turnId } = await seedTurn(db);
    const now = Date.now();

    await db
      .insertInto('checkpoints')
      .values({
        id: 'ckpt-1',
        workspace_id: workspaceId,
        turn_id: turnId,
        ref_name: `refs/checkpoints/${workspaceId}/0`,
        sha: 'deadbeef',
        created_at: now,
      })
      .execute();
    const checkpoint = await db
      .selectFrom('checkpoints')
      .selectAll()
      .where('id', '=', 'ckpt-1')
      .executeTakeFirst();
    expect(checkpoint).toMatchObject({
      workspace_id: workspaceId,
      turn_id: turnId,
      ref_name: `refs/checkpoints/${workspaceId}/0`,
      sha: 'deadbeef',
    });

    await db
      .insertInto('diff_comments')
      .values({
        id: 'comment-1',
        workspace_id: workspaceId,
        file_path: 'src/x.ts',
        line_start: 10,
        line_end: 12,
        side: 'new',
        body: 'please fix',
        state: 'open',
        created_at: now,
      })
      .execute();
    const comment = await db
      .selectFrom('diff_comments')
      .selectAll()
      .where('id', '=', 'comment-1')
      .executeTakeFirst();
    expect(comment).toMatchObject({
      workspace_id: workspaceId,
      file_path: 'src/x.ts',
      line_start: 10,
      line_end: 12,
      side: 'new',
      body: 'please fix',
      state: 'open',
    });

    // File-level comment: nullable line_start/line_end/side round-trip as null.
    await db
      .insertInto('diff_comments')
      .values({
        id: 'comment-2',
        workspace_id: workspaceId,
        file_path: 'src/y.ts',
        line_start: null,
        line_end: null,
        side: null,
        body: 'file-level note',
        state: 'open',
        created_at: now,
      })
      .execute();
    const fileLevelComment = await db
      .selectFrom('diff_comments')
      .selectAll()
      .where('id', '=', 'comment-2')
      .executeTakeFirst();
    expect(fileLevelComment).toMatchObject({
      line_start: null,
      line_end: null,
      side: null,
    });

    await db
      .insertInto('todos')
      .values({
        id: 'todo-1',
        workspace_id: workspaceId,
        body: 'write tests',
        done: 0,
        source: 'agent',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const todo = await db
      .selectFrom('todos')
      .selectAll()
      .where('id', '=', 'todo-1')
      .executeTakeFirst();
    expect(todo).toMatchObject({
      workspace_id: workspaceId,
      body: 'write tests',
      done: 0,
      source: 'agent',
    });
  });

  it('adds turns.reverted_at as a nullable column defaulting to NULL', async () => {
    db = openDb(dbFile);
    const { turnId } = await seedTurn(db);

    const turn = await db
      .selectFrom('turns')
      .selectAll()
      .where('id', '=', turnId)
      .executeTakeFirst();
    expect(turn).toBeDefined();
    expect(turn?.reverted_at).toBeNull();

    // The column accepts a write too (revert flow will use this — Task 8).
    await db
      .updateTable('turns')
      .set({ reverted_at: 999 })
      .where('id', '=', turnId)
      .execute();
    const reverted = await db
      .selectFrom('turns')
      .selectAll()
      .where('id', '=', turnId)
      .executeTakeFirst();
    expect(reverted?.reverted_at).toBe(999);
  });

  it('is idempotent: re-opening the same DB does not double-apply or throw', async () => {
    db = openDb(dbFile);
    await db.destroy();
    db = undefined;

    // Second open of the SAME file must be a clean no-op (already at the latest version).
    expect(() => {
      db = openDb(dbFile);
    }).not.toThrow();

    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
      // Exactly one checkpoints table — a double-apply would have thrown
      // "table already exists".
      const count = raw
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='checkpoints'",
        )
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      raw.close();
    }
  });
});
