// Database migration + repo CRUD round-trip (Task 10 / phase doc §7).
//
// These are the tests that MUST load the real native `better-sqlite3` — they open an
// actual sqlite file in os.tmpdir() (path injected into `openDb`, so no Electron
// `app.getPath` is touched). If the runner is on the wrong ABI, `openDb` throws a
// NODE_MODULE_VERSION error and these fail loudly — which is the point: they verify the
// Electron-ABI test runner is wired correctly.
//
// Behavior under test (from the plan's Validation Gate + Acceptance Criteria):
//   - Fresh DB: all migrations apply, user_version → latest (9), projects/workspaces + indexes exist.
//   - Idempotent: re-opening the same file does not re-apply / error.
//   - CRUD: insert+read a Project and a Workspace via the repos; fields + id/timestamp shape.
//   - Constraints: unique (project_id, name) rejects duplicates; FK rejects a bogus project_id.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { openDb, type AppDatabase } from './index';
import { ProjectsRepo } from './repos/projects';
import { WorkspacesRepo } from './repos/workspaces';
import type { CreateProjectInput } from './repos/projects';
import type { CreateWorkspaceInput } from './repos/workspaces';

// --- temp-dir lifecycle -------------------------------------------------------

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-db-'));
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

// --- fixtures / builders ------------------------------------------------------

function projectInput(
  over: Partial<CreateProjectInput> = {},
): CreateProjectInput {
  return {
    name: 'demo',
    originUrl: 'git@github.com:acme/demo.git',
    defaultBranch: 'main',
    repoPath: '/tmp/repo/demo',
    ...over,
  };
}

function workspaceInput(
  projectId: string,
  over: Partial<CreateWorkspaceInput> = {},
): CreateWorkspaceInput {
  return {
    projectId,
    name: 'paris',
    branch: 'agent/paris',
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'idle',
    ...over,
  };
}

// A tiny UUIDv7 shape check: 8-4-4-4-12 hex with version nibble '7'.
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('migration runner (fresh temp DB)', () => {
  it('applies all migrations: user_version becomes 9 (latest) and core tables + indexes exist', () => {
    db = openDb(dbFile);
    expect(existsSync(dbFile)).toBe(true);

    // Inspect the raw file with a fresh handle (asserts persisted state, not the Kysely cache).
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      // A fresh database applies every registered migration through 0009.
      const version = raw.pragma('user_version', { simple: true });
      expect(version).toBe(9);

      const tables = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toContain('projects');
      expect(tables).toContain('workspaces');

      const indexes = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(indexes).toContain('idx_workspaces_project_id');
      expect(indexes).toContain('uidx_workspaces_project_id_name');
    } finally {
      raw.close();
    }
  });

  it('enables foreign_keys and WAL journal mode on the connection', () => {
    db = openDb(dbFile);
    const raw = new BetterSqlite3(dbFile);
    try {
      // foreign_keys is a per-connection pragma; assert openDb set it on ITS handle by
      // checking the FK-violation behavior below instead. Here assert WAL persisted.
      const mode = raw.pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
    } finally {
      raw.close();
    }
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
      expect(raw.pragma('user_version', { simple: true })).toBe(9);
      // Exactly one projects table — a double-apply would have thrown "table already exists".
      const count = raw
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='projects'",
        )
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      raw.close();
    }
  });
});

describe('ProjectsRepo CRUD round-trip', () => {
  it('inserts a project and reads it back with matching fields, a UUIDv7 id, numeric timestamp', async () => {
    db = openDb(dbFile);
    const repo = new ProjectsRepo(db);

    const before = Date.now();
    const created = await repo.create(projectInput({ name: 'acme' }));
    const after = Date.now();

    expect(created.id).toMatch(UUID_V7);
    expect(typeof created.createdAt).toBe('number');
    expect(created.createdAt).toBeGreaterThanOrEqual(before);
    expect(created.createdAt).toBeLessThanOrEqual(after);
    expect(created.name).toBe('acme');
    expect(created.originUrl).toBe('git@github.com:acme/demo.git');
    expect(created.defaultBranch).toBe('main');
    expect(created.repoPath).toBe('/tmp/repo/demo');

    const fetched = await repo.getById(created.id);
    expect(fetched).toEqual(created);
  });

  it('returns null for a missing project id', async () => {
    db = openDb(dbFile);
    const repo = new ProjectsRepo(db);
    expect(await repo.getById('does-not-exist')).toBeNull();
  });

  it('lists projects newest-first', async () => {
    db = openDb(dbFile);
    const repo = new ProjectsRepo(db);
    const a = await repo.create(
      projectInput({ name: 'a', repoPath: '/tmp/a' }),
    );
    const b = await repo.create(
      projectInput({ name: 'b', repoPath: '/tmp/b' }),
    );
    const list = await repo.list();
    // UUIDv7 is time-sortable and ordered created_at desc, id desc → newest first.
    expect(list.map((p) => p.id)).toEqual([b.id, a.id]);
  });
});

describe('WorkspacesRepo CRUD round-trip + constraints', () => {
  it('inserts a workspace referencing a project and reads it back (nullable cols → null)', async () => {
    db = openDb(dbFile);
    const projects = new ProjectsRepo(db);
    const workspaces = new WorkspacesRepo(db);

    const project = await projects.create(projectInput());
    const created = await workspaces.create(
      workspaceInput(project.id, { name: 'london' }),
    );

    expect(created.id).toMatch(UUID_V7);
    expect(created.projectId).toBe(project.id);
    expect(created.name).toBe('london');
    expect(created.branch).toBe('agent/paris');
    expect(created.baseBranch).toBe('main');
    expect(created.harness).toBe('claude_code');
    expect(created.status).toBe('idle');
    expect(created.location).toBe('worktree');
    // Omitted nullable inputs round-trip as null (not undefined).
    expect(created.worktreePath).toBeNull();
    expect(created.sourceKind).toBeNull();
    expect(created.sourceRef).toBeNull();
    expect(created.port).toBeNull();
    expect(created.archivedAt).toBeNull();
    expect(typeof created.createdAt).toBe('number');

    const fetched = await workspaces.getById(created.id);
    expect(fetched).toEqual(created);
  });

  it('persists supplied nullable/enum columns verbatim', async () => {
    db = openDb(dbFile);
    const projects = new ProjectsRepo(db);
    const workspaces = new WorkspacesRepo(db);
    const project = await projects.create(projectInput());

    const created = await workspaces.create(
      workspaceInput(project.id, {
        name: 'berlin',
        worktreePath: '/tmp/wt/berlin',
        sourceKind: 'pr',
        sourceRef: '42',
        port: 5173,
        status: 'working',
        location: 'project',
      }),
    );
    const fetched = await workspaces.getById(created.id);
    expect(fetched).toMatchObject({
      worktreePath: '/tmp/wt/berlin',
      sourceKind: 'pr',
      sourceRef: '42',
      port: 5173,
      status: 'working',
      location: 'project',
    });
  });

  it('lists workspaces by project only (scopes to the project_id)', async () => {
    db = openDb(dbFile);
    const projects = new ProjectsRepo(db);
    const workspaces = new WorkspacesRepo(db);
    const p1 = await projects.create(
      projectInput({ name: 'p1', repoPath: '/tmp/p1' }),
    );
    const p2 = await projects.create(
      projectInput({ name: 'p2', repoPath: '/tmp/p2' }),
    );

    await workspaces.create(workspaceInput(p1.id, { name: 'paris' }));
    await workspaces.create(workspaceInput(p1.id, { name: 'lyon' }));
    await workspaces.create(workspaceInput(p2.id, { name: 'paris' }));

    const forP1 = await workspaces.listByProject(p1.id);
    expect(forP1.map((w) => w.name).sort()).toEqual(['lyon', 'paris']);
    expect(forP1.every((w) => w.projectId === p1.id)).toBe(true);
  });

  it('setStatus transitions status and returns the updated DTO', async () => {
    db = openDb(dbFile);
    const projects = new ProjectsRepo(db);
    const workspaces = new WorkspacesRepo(db);
    const project = await projects.create(projectInput());
    const ws = await workspaces.create(
      workspaceInput(project.id, { status: 'idle' }),
    );

    const updated = await workspaces.setStatus(ws.id, 'working');
    expect(updated?.status).toBe('working');
    expect((await workspaces.getById(ws.id))?.status).toBe('working');
  });

  it('rejects a duplicate (project_id, name) via the unique index', async () => {
    db = openDb(dbFile);
    const projects = new ProjectsRepo(db);
    const workspaces = new WorkspacesRepo(db);
    const project = await projects.create(projectInput());

    await workspaces.create(workspaceInput(project.id, { name: 'paris' }));
    // Same name under the SAME project must violate uidx_workspaces_project_id_name.
    await expect(
      workspaces.create(workspaceInput(project.id, { name: 'paris' })),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it('allows the same workspace name under a DIFFERENT project (constraint is scoped)', async () => {
    db = openDb(dbFile);
    const projects = new ProjectsRepo(db);
    const workspaces = new WorkspacesRepo(db);
    const p1 = await projects.create(
      projectInput({ name: 'p1', repoPath: '/tmp/p1' }),
    );
    const p2 = await projects.create(
      projectInput({ name: 'p2', repoPath: '/tmp/p2' }),
    );

    await workspaces.create(workspaceInput(p1.id, { name: 'paris' }));
    await expect(
      workspaces.create(workspaceInput(p2.id, { name: 'paris' })),
    ).resolves.toBeDefined();
  });

  it('rejects a workspace with a bogus project_id (proves foreign_keys=ON)', async () => {
    db = openDb(dbFile);
    const workspaces = new WorkspacesRepo(db);
    // No such project row exists → FK violation IF foreign_keys is actually enforced.
    await expect(
      workspaces.create(workspaceInput('no-such-project', { name: 'ghost' })),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });
});
