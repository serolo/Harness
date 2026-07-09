// TodosRepo round-trip (migration 0005, Phase 4). Opens a real better-sqlite3 file
// in os.tmpdir() (path injected into `openDb`, mirroring turns.test.ts /
// 0005_diff_review.test.ts) and exercises `list`/`create`/`toggle`/`replaceAgentTodos`
// against the shared `Todo` DTO — independent of TodosRepo's own implementation
// choices (source of truth is `src/shared/harness.ts`'s `Todo` + `src/shared/review.ts`'s
// `TodoInput`, not the repo's internals).
//
// `create`'s `created_at` comes from `Date.now()`, so ordering assertions use fake
// timers (`vi.setSystemTime`) to force distinct, controlled timestamps rather than
// relying on real-clock gaps between calls in the same test tick — see mock.test.ts
// for the same pattern in this repo.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppError } from '@shared/errors';
import type { Todo } from '@shared/harness';
import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from './projects';
import { WorkspacesRepo } from './workspaces';
import { TodosRepo } from './todos';

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-todos-'));
  dbFile = join(tmpDir, 'test.db');
  db = undefined;
});

afterEach(async () => {
  vi.useRealTimers();
  if (db) {
    await db.destroy();
    db = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a project + workspace and return the workspace id (FK parent for todos). */
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

describe('TodosRepo.create (user todo)', () => {
  it('returns a user todo with done:false and an assigned id', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const todos = new TodosRepo(db);

    const created = await todos.create({
      workspaceId: wsId,
      body: 'write tests',
    });

    expect(created.id).toEqual(expect.any(String));
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.body).toBe('write tests');
    expect(created.done).toBe(false);
    expect(created.source).toBe('user');

    // Confirm the DTO returned by create() matches what list() reads back (INTEGER
    // 0 -> boolean false round-trip via the real row, not just the in-memory value).
    const [listed] = await todos.list(wsId);
    expect(listed).toEqual(created);
  });
});

describe('TodosRepo.list', () => {
  it('orders multiple user todos by created_at ASC', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const todos = new TodosRepo(db);

    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = await todos.create({ workspaceId: wsId, body: 'first' });
    vi.setSystemTime(2_000);
    const second = await todos.create({ workspaceId: wsId, body: 'second' });
    vi.setSystemTime(3_000);
    const third = await todos.create({ workspaceId: wsId, body: 'third' });
    vi.useRealTimers();

    const list = await todos.list(wsId);
    expect(list.map((t) => t.id)).toEqual([first.id, second.id, third.id]);
    expect(list.map((t) => t.body)).toEqual(['first', 'second', 'third']);
  });

  it('scopes to the given workspace only', async () => {
    db = openDb(dbFile);
    const wsA = await seedWorkspace(db, 'paris');
    const wsB = await seedWorkspace(db, 'lyon');
    const todos = new TodosRepo(db);

    await todos.create({ workspaceId: wsA, body: 'in A' });
    await todos.create({ workspaceId: wsB, body: 'in B' });

    const listA = await todos.list(wsA);
    const listB = await todos.list(wsB);
    expect(listA).toHaveLength(1);
    expect(listA[0].body).toBe('in A');
    expect(listB).toHaveLength(1);
    expect(listB[0].body).toBe('in B');
  });
});

describe('TodosRepo.toggle', () => {
  it('flips done false -> true -> false and returns the updated Todo', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const todos = new TodosRepo(db);
    const created = await todos.create({
      workspaceId: wsId,
      body: 'toggle me',
    });
    expect(created.done).toBe(false);

    const toggledOn = await todos.toggle(created.id);
    expect(toggledOn.done).toBe(true);
    expect(toggledOn.id).toBe(created.id);
    expect(toggledOn.body).toBe('toggle me');
    expect(toggledOn.source).toBe('user');

    const toggledOff = await todos.toggle(created.id);
    expect(toggledOff.done).toBe(false);

    // Persisted, not just the in-memory return value.
    const [listed] = await todos.list(wsId);
    expect(listed.done).toBe(false);
  });

  it('throws a not_found AppError for a missing id', async () => {
    db = openDb(dbFile);
    const todos = new TodosRepo(db);

    let caught: unknown;
    try {
      await todos.toggle('missing-id');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('not_found');
  });
});

describe('TodosRepo.replaceAgentTodos', () => {
  it('replaces the full agent todo set, leaving user todos untouched', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const todos = new TodosRepo(db);

    const userTodo = await todos.create({
      workspaceId: wsId,
      body: 'user task',
    });

    const a: Todo = {
      id: 'agent-a',
      body: 'agent task a',
      done: false,
      source: 'agent',
    };
    const b: Todo = {
      id: 'agent-b',
      body: 'agent task b',
      done: true,
      source: 'agent',
    };
    await todos.replaceAgentTodos(wsId, [a, b]);

    let list = await todos.list(wsId);
    expect(list).toHaveLength(3);
    // Rows get FRESH server-generated ids (the agent-supplied id is not reused as the
    // PK — see the cross-workspace-collision regression below), so match by body.
    const agentBodiesAfterFirst = list
      .filter((t) => t.source === 'agent')
      .map((t) => t.body)
      .sort();
    expect(agentBodiesAfterFirst).toEqual(['agent task a', 'agent task b']);
    // done values round-trip through the INTEGER 0/1 column.
    expect(list.find((t) => t.body === 'agent task a')?.done).toBe(false);
    expect(list.find((t) => t.body === 'agent task b')?.done).toBe(true);

    // Second replace: only `c` should remain among agent todos; a/b are gone.
    const c: Todo = {
      id: 'agent-c',
      body: 'agent task c',
      done: false,
      source: 'agent',
    };
    await todos.replaceAgentTodos(wsId, [c]);

    list = await todos.list(wsId);
    const agentTodos = list.filter((t) => t.source === 'agent');
    expect(agentTodos).toHaveLength(1);
    expect(agentTodos[0]).toMatchObject({
      body: 'agent task c',
      done: false,
      source: 'agent',
    });

    // The user todo survived both replaces, untouched.
    const survivingUserTodo = list.find((t) => t.source === 'user');
    expect(survivingUserTodo).toEqual(userTodo);
  });

  it('replacing with an empty array clears all agent todos for the workspace', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const todos = new TodosRepo(db);

    await todos.replaceAgentTodos(wsId, [
      { id: 'agent-a', body: 'a', done: false, source: 'agent' },
    ]);
    expect(
      (await todos.list(wsId)).filter((t) => t.source === 'agent'),
    ).toHaveLength(1);

    await todos.replaceAgentTodos(wsId, []);
    expect(await todos.list(wsId)).toEqual([]);
  });

  it('scopes the replace to the given workspace only', async () => {
    db = openDb(dbFile);
    const wsA = await seedWorkspace(db, 'paris');
    const wsB = await seedWorkspace(db, 'lyon');
    const todos = new TodosRepo(db);

    await todos.replaceAgentTodos(wsA, [
      { id: 'a-agent-1', body: 'a1', done: false, source: 'agent' },
    ]);
    await todos.replaceAgentTodos(wsB, [
      { id: 'b-agent-1', body: 'b1', done: false, source: 'agent' },
    ]);

    // Replacing wsA's agent todos must not touch wsB's.
    await todos.replaceAgentTodos(wsA, [
      { id: 'a-agent-2', body: 'a2', done: false, source: 'agent' },
    ]);

    const listB = await todos.list(wsB);
    expect(listB.map((t) => t.body)).toEqual(['b1']);
  });

  it('does not collide across workspaces when agents reuse the same todo id', async () => {
    // Regression: harness todo ids are frequently session-local (not globally unique).
    // Reusing them as the global PRIMARY KEY would make the second workspace's INSERT
    // throw a UNIQUE violation and silently drop that workspace's agent todos. Fresh
    // server-generated ids make the two workspaces independent.
    db = openDb(dbFile);
    const wsA = await seedWorkspace(db, 'paris');
    const wsB = await seedWorkspace(db, 'lyon');
    const todos = new TodosRepo(db);

    const sameId: Todo = {
      id: '1',
      body: 'shared-id',
      done: false,
      source: 'agent',
    };
    await todos.replaceAgentTodos(wsA, [sameId]);
    await todos.replaceAgentTodos(wsB, [sameId]);

    // Both workspaces kept their agent todo — no collision, no silent drop.
    expect((await todos.list(wsA)).map((t) => t.body)).toEqual(['shared-id']);
    expect((await todos.list(wsB)).map((t) => t.body)).toEqual(['shared-id']);
    // And a single batch reusing an id across two entries doesn't self-collide either.
    await todos.replaceAgentTodos(wsA, [
      { id: '1', body: 'first', done: false, source: 'agent' },
      { id: '1', body: 'second', done: true, source: 'agent' },
    ]);
    expect((await todos.list(wsA)).map((t) => t.body).sort()).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('TodosRepo user + agent coexistence', () => {
  it('list returns both sources for the same workspace, distinguished by `source`', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const todos = new TodosRepo(db);

    const userTodo = await todos.create({
      workspaceId: wsId,
      body: 'from user',
    });
    await todos.replaceAgentTodos(wsId, [
      { id: 'agent-1', body: 'from agent', done: false, source: 'agent' },
    ]);

    const list = await todos.list(wsId);
    expect(list).toHaveLength(2);
    expect(list.find((t) => t.id === userTodo.id)).toMatchObject({
      source: 'user',
      body: 'from user',
    });
    expect(list.find((t) => t.body === 'from agent')).toMatchObject({
      source: 'agent',
      body: 'from agent',
    });
  });
});
