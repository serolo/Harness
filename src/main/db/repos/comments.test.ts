// DiffCommentsRepo round-trip (migration 0005, Phase 4). Opens a real
// better-sqlite3 file in os.tmpdir() (path injected into `openDb`, so no Electron
// `app.getPath` is touched) — mirrors turns.test.ts / 0005_diff_review.test.ts.
//
// A parent `projects` + `workspaces` row is created first (foreign_keys is ON, so
// the diff_comments→workspaces FK is enforced), reusing the existing repos as
// fixture builders — the same idiom as turns.test.ts's `seedWorkspace`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from './projects';
import { WorkspacesRepo } from './workspaces';
import { DiffCommentsRepo } from './comments';

// A UUIDv7 shape check: 8-4-4-4-12 hex with version nibble '7'.
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-comments-'));
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

/** Create a project + workspace and return the workspace id (FK parent for diff_comments). */
async function seedWorkspace(
  handle: AppDatabase,
  name = 'paris',
): Promise<string> {
  const project = await new ProjectsRepo(handle).create({
    name: 'demo',
    originUrl: 'git@github.com:acme/demo.git',
    defaultBranch: 'main',
    repoPath: '/tmp/repo/demo',
  });
  const workspace = await new WorkspacesRepo(handle).create({
    projectId: project.id,
    name,
    branch: `agent/${name}`,
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'idle',
  });
  return workspace.id;
}

describe('DiffCommentsRepo', () => {
  it('create returns a DTO in open state with a UUIDv7 id and camelCase fields', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new DiffCommentsRepo(db);

    const before = Date.now();
    const comment = await repo.create({
      workspaceId: wsId,
      filePath: 'src/x.ts',
      lineStart: 10,
      lineEnd: 12,
      side: 'new',
      body: 'please fix',
    });
    const after = Date.now();

    expect(comment.id).toMatch(UUID_V7);
    expect(comment.state).toBe('open');
    expect(comment.workspaceId).toBe(wsId);
    expect(comment.filePath).toBe('src/x.ts');
    expect(comment.lineStart).toBe(10);
    expect(comment.lineEnd).toBe(12);
    expect(comment.side).toBe('new');
    expect(comment.body).toBe('please fix');
    expect(comment.createdAt).toBeGreaterThanOrEqual(before);
    expect(comment.createdAt).toBeLessThanOrEqual(after);

    // Confirm it's actually persisted (not just an in-memory echo).
    const fetched = await repo.getById(comment.id);
    expect(fetched).toEqual(comment);
  });

  it('round-trips a file-level comment with null lineStart/lineEnd/side', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new DiffCommentsRepo(db);

    const comment = await repo.create({
      workspaceId: wsId,
      filePath: 'src/y.ts',
      lineStart: null,
      lineEnd: null,
      side: null,
      body: 'file-level note',
    });

    expect(comment.lineStart).toBeNull();
    expect(comment.lineEnd).toBeNull();
    expect(comment.side).toBeNull();

    const fetched = await repo.getById(comment.id);
    expect(fetched?.lineStart).toBeNull();
    expect(fetched?.lineEnd).toBeNull();
    expect(fetched?.side).toBeNull();
  });

  it('list orders by created_at ASC, filters by state, and scopes to workspace', async () => {
    db = openDb(dbFile);
    const wsA = await seedWorkspace(db, 'paris');
    const wsB = await seedWorkspace(db, 'lyon');
    const repo = new DiffCommentsRepo(db);

    const c1 = await repo.create({
      workspaceId: wsA,
      filePath: 'a.ts',
      lineStart: 1,
      lineEnd: 1,
      side: 'new',
      body: 'first',
    });
    const c2 = await repo.create({
      workspaceId: wsA,
      filePath: 'b.ts',
      lineStart: 2,
      lineEnd: 2,
      side: 'new',
      body: 'second',
    });
    const c3 = await repo.create({
      workspaceId: wsA,
      filePath: 'c.ts',
      lineStart: 3,
      lineEnd: 3,
      side: 'old',
      body: 'third',
    });
    // A comment in a different workspace must never leak into wsA's list.
    await repo.create({
      workspaceId: wsB,
      filePath: 'd.ts',
      lineStart: 4,
      lineEnd: 4,
      side: 'new',
      body: 'other workspace',
    });

    await repo.setState(c2.id, 'sent');
    await repo.setState(c3.id, 'resolved');

    const all = await repo.list(wsA);
    expect(all.map((c) => c.id)).toEqual([c1.id, c2.id, c3.id]);

    const open = await repo.list(wsA, 'open');
    expect(open.map((c) => c.id)).toEqual([c1.id]);

    const sent = await repo.list(wsA, 'sent');
    expect(sent.map((c) => c.id)).toEqual([c2.id]);

    const resolved = await repo.list(wsA, 'resolved');
    expect(resolved.map((c) => c.id)).toEqual([c3.id]);

    const otherWsList = await repo.list(wsB);
    expect(otherWsList).toHaveLength(1);
    expect(otherWsList[0].workspaceId).toBe(wsB);
  });

  it('list(workspaceId) with no state filter returns comments in every state', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new DiffCommentsRepo(db);

    const c1 = await repo.create({
      workspaceId: wsId,
      filePath: 'a.ts',
      lineStart: null,
      lineEnd: null,
      side: null,
      body: 'note',
    });
    await repo.setState(c1.id, 'sent');
    await repo.setState(c1.id, 'resolved');

    const all = await repo.list(wsId);
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe('resolved');
  });

  it('setState transitions open -> sent -> resolved, reflected by getById', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new DiffCommentsRepo(db);

    const comment = await repo.create({
      workspaceId: wsId,
      filePath: 'a.ts',
      lineStart: 1,
      lineEnd: 1,
      side: 'new',
      body: 'note',
    });
    expect((await repo.getById(comment.id))?.state).toBe('open');

    await repo.setState(comment.id, 'sent');
    expect((await repo.getById(comment.id))?.state).toBe('sent');

    await repo.setState(comment.id, 'resolved');
    expect((await repo.getById(comment.id))?.state).toBe('resolved');
  });

  it('getById returns null for a nonexistent id', async () => {
    db = openDb(dbFile);
    const repo = new DiffCommentsRepo(db);
    expect(await repo.getById('does-not-exist')).toBeNull();
  });

  it('remove deletes the row: getById returns null and list omits it', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new DiffCommentsRepo(db);

    const keep = await repo.create({
      workspaceId: wsId,
      filePath: 'keep.ts',
      lineStart: 1,
      lineEnd: 1,
      side: 'new',
      body: 'keep me',
    });
    const doomed = await repo.create({
      workspaceId: wsId,
      filePath: 'gone.ts',
      lineStart: 2,
      lineEnd: 2,
      side: 'new',
      body: 'delete me',
    });

    await repo.remove(doomed.id);

    expect(await repo.getById(doomed.id)).toBeNull();
    const list = await repo.list(wsId);
    expect(list.map((c) => c.id)).toEqual([keep.id]);
  });
});
