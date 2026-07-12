// QueuedMessagesRepo round-trip (migration 0008, Phase 9 — mid-turn steer & message
// queue). Opens a real better-sqlite3 file in os.tmpdir() (path injected into `openDb`,
// mirroring todos.test.ts) and exercises `list`/`enqueue`/`update`/`reorder`/`remove`
// against the shared `QueuedMessage` DTO — independent of the repo's internal SQL.
//
// The queue is durable + per-workspace + strictly ordered by `order_idx`. The
// load-bearing acceptance criteria live here: `enqueue` appends contiguous order
// indices, `reorder` rewrites 0..n-1 AND rejects any non-permutation (missing / extra /
// duplicate id) WITHOUT mutating the stored order, and `remove` is idempotent.
//
// `enqueue`'s `created_at` comes from `Date.now()`; ordering is by `order_idx`, not the
// clock, so timing is deterministic without fake timers — but we use `vi.setSystemTime`
// where a stable `createdAt` value is asserted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppError } from '@shared/errors';
import type { Attachment } from '@shared/harness';
import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from './projects';
import { WorkspacesRepo } from './workspaces';
import { QueuedMessagesRepo } from './queued-messages';

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-queue-'));
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

/** Create a project + workspace and return the workspace id (FK parent for queued_messages). */
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

describe('QueuedMessagesRepo.enqueue + list', () => {
  it('appends with contiguous 0-based order indices; list is head-first', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new QueuedMessagesRepo(db);

    const first = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'first',
      attachments: [],
    });
    const second = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'second',
      attachments: [],
    });
    const third = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'third',
      attachments: [],
    });

    expect([first.orderIdx, second.orderIdx, third.orderIdx]).toEqual([
      0, 1, 2,
    ]);

    const list = await repo.list(wsId);
    expect(list.map((m) => m.prompt)).toEqual(['first', 'second', 'third']);
    expect(list.map((m) => m.orderIdx)).toEqual([0, 1, 2]);
    // The DTO round-trips exactly through the real row.
    expect(list[0]).toEqual(first);
  });

  it('round-trips attachments and both set/unset mode', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new QueuedMessagesRepo(db);

    const attachments: Attachment[] = [
      { type: 'file', path: '/tmp/a.ts' },
      {
        type: 'diff_comment',
        file: 'src/x.ts',
        lineStart: 3,
        lineEnd: 5,
        side: 'new',
        excerpt: 'const x = 1;',
        body: 'why?',
      },
    ];
    const withMode = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'with attachments',
      attachments,
      mode: 'plan',
    });
    const withoutMode = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'no mode',
      attachments: [],
    });

    expect(withMode.attachments).toEqual(attachments);
    expect(withMode.mode).toBe('plan');
    // An unset mode is `undefined` in the DTO (NULL column), not null.
    expect(withoutMode.mode).toBeUndefined();

    // Persisted, not just the in-memory return value.
    const [row0, row1] = await repo.list(wsId);
    expect(row0.attachments).toEqual(attachments);
    expect(row0.mode).toBe('plan');
    expect(row1.mode).toBeUndefined();
  });

  it('numbers each workspace queue independently (per-workspace order)', async () => {
    db = openDb(dbFile);
    const wsA = await seedWorkspace(db, 'paris');
    const wsB = await seedWorkspace(db, 'lyon');
    const repo = new QueuedMessagesRepo(db);

    await repo.enqueue({ workspaceId: wsA, prompt: 'a0', attachments: [] });
    const b0 = await repo.enqueue({
      workspaceId: wsB,
      prompt: 'b0',
      attachments: [],
    });
    await repo.enqueue({ workspaceId: wsA, prompt: 'a1', attachments: [] });

    // wsB's first message starts at index 0 regardless of wsA's rows.
    expect(b0.orderIdx).toBe(0);
    expect((await repo.list(wsA)).map((m) => m.orderIdx)).toEqual([0, 1]);
    expect((await repo.list(wsB)).map((m) => m.prompt)).toEqual(['b0']);
  });

  it('stamps createdAt from the clock', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new QueuedMessagesRepo(db);

    vi.useFakeTimers();
    vi.setSystemTime(1_234_000);
    const msg = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'stamped',
      attachments: [],
    });
    vi.useRealTimers();

    expect(msg.createdAt).toBe(1_234_000);
  });
});

describe('QueuedMessagesRepo.update', () => {
  it('patches only the provided fields', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new QueuedMessagesRepo(db);

    const created = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'original',
      attachments: [{ type: 'file', path: '/tmp/orig.ts' }],
      mode: 'default',
    });

    // Patch prompt only → attachments + mode untouched.
    const patched = await repo.update(created.id, { prompt: 'edited' });
    expect(patched.prompt).toBe('edited');
    expect(patched.attachments).toEqual([
      { type: 'file', path: '/tmp/orig.ts' },
    ]);
    expect(patched.mode).toBe('default');
    expect(patched.orderIdx).toBe(created.orderIdx);

    // Patch attachments only.
    const newAttachments: Attachment[] = [
      { type: 'image', path: '/tmp/x.png' },
    ];
    const patched2 = await repo.update(created.id, {
      attachments: newAttachments,
    });
    expect(patched2.attachments).toEqual(newAttachments);
    expect(patched2.prompt).toBe('edited');

    // Persisted round-trip.
    const [listed] = await repo.list(wsId);
    expect(listed.prompt).toBe('edited');
    expect(listed.attachments).toEqual(newAttachments);
    expect(listed.mode).toBe('default');
  });

  it('clears mode when the patch includes mode:undefined (present key)', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new QueuedMessagesRepo(db);

    const created = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'has mode',
      attachments: [],
      mode: 'plan',
    });
    expect(created.mode).toBe('plan');

    // A present `mode` key with value `undefined` maps to NULL → cleared.
    const cleared = await repo.update(created.id, { mode: undefined });
    expect(cleared.mode).toBeUndefined();

    const [listed] = await repo.list(wsId);
    expect(listed.mode).toBeUndefined();
  });

  it('throws not_found for a missing id', async () => {
    db = openDb(dbFile);
    const repo = new QueuedMessagesRepo(db);

    let caught: unknown;
    try {
      await repo.update('missing-id', { prompt: 'x' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('not_found');
  });
});

describe('QueuedMessagesRepo.reorder', () => {
  it('rewrites order_idx to a contiguous 0..n-1 in the given order', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new QueuedMessagesRepo(db);

    const a = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'a',
      attachments: [],
    });
    const b = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'b',
      attachments: [],
    });
    const c = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'c',
      attachments: [],
    });

    // Reverse the order.
    await repo.reorder(wsId, [c.id, b.id, a.id]);

    const list = await repo.list(wsId);
    expect(list.map((m) => m.prompt)).toEqual(['c', 'b', 'a']);
    expect(list.map((m) => m.orderIdx)).toEqual([0, 1, 2]);
  });

  it('rejects a non-permutation and does NOT mutate the stored order', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new QueuedMessagesRepo(db);

    const a = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'a',
      attachments: [],
    });
    const b = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'b',
      attachments: [],
    });
    const c = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'c',
      attachments: [],
    });

    const originalOrder = ['a', 'b', 'c'];

    // (1) Missing an id (too short / not covering the set).
    await expectInvalidInput(() => repo.reorder(wsId, [a.id, b.id]));
    expect((await repo.list(wsId)).map((m) => m.prompt)).toEqual(originalOrder);

    // (2) An extra/unknown id.
    await expectInvalidInput(() =>
      repo.reorder(wsId, [a.id, b.id, c.id, 'ghost-id']),
    );
    expect((await repo.list(wsId)).map((m) => m.prompt)).toEqual(originalOrder);

    // (3) A duplicate id (right length, wrong set).
    await expectInvalidInput(() => repo.reorder(wsId, [a.id, b.id, b.id]));
    expect((await repo.list(wsId)).map((m) => m.prompt)).toEqual(originalOrder);

    // Order indices are still the untouched 0,1,2.
    expect((await repo.list(wsId)).map((m) => m.orderIdx)).toEqual([0, 1, 2]);
  });

  /** Assert a call rejects with AppError('invalid_input'). */
  async function expectInvalidInput(fn: () => Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('invalid_input');
  }
});

describe('QueuedMessagesRepo.remove', () => {
  it('deletes a queued message', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new QueuedMessagesRepo(db);

    const a = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'a',
      attachments: [],
    });
    const b = await repo.enqueue({
      workspaceId: wsId,
      prompt: 'b',
      attachments: [],
    });

    await repo.remove(a.id);

    const list = await repo.list(wsId);
    expect(list.map((m) => m.prompt)).toEqual(['b']);
    expect(list.map((m) => m.id)).toEqual([b.id]);
  });

  it('is a no-op (no throw) when removing an absent id', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const repo = new QueuedMessagesRepo(db);

    await repo.enqueue({ workspaceId: wsId, prompt: 'a', attachments: [] });

    await expect(repo.remove('missing-id')).resolves.toBeUndefined();
    expect(await repo.list(wsId)).toHaveLength(1);
  });
});
