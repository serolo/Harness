// ChatContextsRepo round-trip (migration 0016). Opens a real better-sqlite3 file in
// os.tmpdir() (path injected into `openDb`, mirroring turns.test.ts / todos.test.ts)
// and exercises `listOrBootstrap`/`create`/`rename`/`close`/`get` against the shared
// `ChatContextRecord` DTO — independent of the repo's own implementation choices.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppError } from '@shared/errors';
import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from './projects';
import { WorkspacesRepo } from './workspaces';
import { TurnsRepo } from './turns';
import { ChatContextsRepo } from './chatContexts';

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-chat-contexts-'));
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

/** Create a project + workspace and return the workspace id (FK parent for chat_contexts). */
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

describe('ChatContextsRepo.listOrBootstrap', () => {
  it('creates exactly one Untitled context for an empty workspace and is idempotent', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);

    const first = await contexts.listOrBootstrap(wsId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      workspaceId: wsId,
      label: 'Untitled',
      initialSessionId: null,
      position: 0,
    });
    expect(first[0].id).toEqual(expect.any(String));
    expect(first[0].id.length).toBeGreaterThan(0);

    // A second call must NOT invent a second default tab — this is the exact race the
    // repo-level bootstrap exists to close (two panel mounts on the same workspace).
    const second = await contexts.listOrBootstrap(wsId);
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual(first[0]);
  });

  it('returns existing contexts without bootstrapping when the workspace already has one', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);

    const created = await contexts.create({
      workspaceId: wsId,
      label: 'API work',
    });
    const listed = await contexts.listOrBootstrap(wsId);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);
  });

  it('scopes to the given workspace only', async () => {
    db = openDb(dbFile);
    const wsA = await seedWorkspace(db, 'paris');
    const wsB = await seedWorkspace(db, 'lyon');
    const contexts = new ChatContextsRepo(db);

    const bootstrappedA = await contexts.listOrBootstrap(wsA);
    const bootstrappedB = await contexts.listOrBootstrap(wsB);

    expect(bootstrappedA).toHaveLength(1);
    expect(bootstrappedB).toHaveLength(1);
    expect(bootstrappedA[0].id).not.toBe(bootstrappedB[0].id);
  });
});

describe('ChatContextsRepo.create', () => {
  it('assigns increasing position across multiple calls for the same workspace', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);

    const first = await contexts.create({ workspaceId: wsId, label: 'First' });
    const second = await contexts.create({
      workspaceId: wsId,
      label: 'Second',
    });
    const third = await contexts.create({ workspaceId: wsId, label: 'Third' });

    expect([first.position, second.position, third.position]).toEqual([
      0, 1, 2,
    ]);
  });

  it('keeps position sequences independent per workspace', async () => {
    db = openDb(dbFile);
    const wsA = await seedWorkspace(db, 'paris');
    const wsB = await seedWorkspace(db, 'lyon');
    const contexts = new ChatContextsRepo(db);

    await contexts.create({ workspaceId: wsA, label: 'A1' });
    const bFirst = await contexts.create({ workspaceId: wsB, label: 'B1' });

    expect(bFirst.position).toBe(0);
  });

  it('defaults a blank or omitted label to Untitled', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);

    const omitted = await contexts.create({ workspaceId: wsId });
    const blank = await contexts.create({ workspaceId: wsId, label: '   ' });
    const explicit = await contexts.create({
      workspaceId: wsId,
      label: 'Named tab',
    });

    expect(omitted.label).toBe('Untitled');
    expect(blank.label).toBe('Untitled');
    expect(explicit.label).toBe('Named tab');
  });

  it('defaults initialSessionId to null and round-trips a resume id when given', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);

    const fresh = await contexts.create({ workspaceId: wsId });
    expect(fresh.initialSessionId).toBeNull();

    const resumed = await contexts.create({
      workspaceId: wsId,
      initialSessionId: 'session-abc',
    });
    expect(resumed.initialSessionId).toBe('session-abc');
  });

  it('assigns a fresh generated id even when called repeatedly', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);

    const a = await contexts.create({ workspaceId: wsId });
    const b = await contexts.create({ workspaceId: wsId });
    expect(a.id).not.toBe(b.id);
  });
});

describe('ChatContextsRepo.rename', () => {
  it('updates the label of an existing context', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);
    const created = await contexts.create({ workspaceId: wsId, label: 'Old' });

    await contexts.rename(created.id, 'New label');

    const fetched = await contexts.get(created.id);
    expect(fetched?.label).toBe('New label');
  });

  it('throws a not_found AppError for an unknown id', async () => {
    db = openDb(dbFile);
    const contexts = new ChatContextsRepo(db);

    let caught: unknown;
    try {
      await contexts.rename('missing-id', 'New label');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('not_found');
  });
});

describe('ChatContextsRepo.close', () => {
  it('nulls context_id on its turns and deletes the row', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);
    const turns = new TurnsRepo(db);

    const context = await contexts.create({
      workspaceId: wsId,
      label: 'Closing',
    });
    const owned = await turns.create({
      workspaceId: wsId,
      idx: 0,
      status: 'completed',
      contextId: context.id,
    });
    const unrelated = await turns.create({
      workspaceId: wsId,
      idx: 1,
      status: 'completed',
    });

    await contexts.close(context.id);

    expect(await contexts.get(context.id)).toBeNull();
    // Turn history itself is never deleted — only orphaned.
    const ownedAfter = await turns.getById(owned.id);
    expect(ownedAfter).not.toBeNull();
    expect(ownedAfter?.contextId).toBeNull();
    // A turn that never belonged to the closed context is untouched.
    const unrelatedAfter = await turns.getById(unrelated.id);
    expect(unrelatedAfter?.contextId).toBeNull();
  });

  it('is a no-op (does not throw) when the context is already gone', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);
    const context = await contexts.create({ workspaceId: wsId });

    await contexts.close(context.id);
    await expect(contexts.close(context.id)).resolves.toBeUndefined();
    await expect(contexts.close('never-existed')).resolves.toBeUndefined();
  });

  it('only orphans turns belonging to the closed context, leaving other contexts intact', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);
    const turns = new TurnsRepo(db);

    const contextA = await contexts.create({ workspaceId: wsId, label: 'A' });
    const contextB = await contexts.create({ workspaceId: wsId, label: 'B' });
    const turnA = await turns.create({
      workspaceId: wsId,
      idx: 0,
      status: 'completed',
      contextId: contextA.id,
    });
    const turnB = await turns.create({
      workspaceId: wsId,
      idx: 1,
      status: 'completed',
      contextId: contextB.id,
    });

    await contexts.close(contextA.id);

    expect(await contexts.get(contextA.id)).toBeNull();
    expect(await contexts.get(contextB.id)).not.toBeNull();
    expect((await turns.getById(turnA.id))?.contextId).toBeNull();
    expect((await turns.getById(turnB.id))?.contextId).toBe(contextB.id);
  });
});

describe('ChatContextsRepo.get', () => {
  it('returns null for an unknown id', async () => {
    db = openDb(dbFile);
    const contexts = new ChatContextsRepo(db);

    expect(await contexts.get('missing-id')).toBeNull();
  });

  it('returns the record for a known id', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const contexts = new ChatContextsRepo(db);
    const created = await contexts.create({
      workspaceId: wsId,
      label: 'Findable',
    });

    expect(await contexts.get(created.id)).toEqual(created);
  });
});
