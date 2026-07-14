// Turns + events repo round-trip (migration 0003, Phase 2). Opens a real
// better-sqlite3 file in os.tmpdir() (path injected into `openDb`, so no Electron
// `app.getPath` is touched) — proving migration 0003 applies on a fresh DB and the
// TurnsRepo/EventsRepo round-trip DTOs, including forward-compat opaque event storage.
//
// A parent `projects` + `workspaces` row is created first (foreign_keys is ON, so the
// turns→workspaces FK is enforced), reusing the existing repos as fixture builders.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '@shared/harness';
import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from './projects';
import { WorkspacesRepo } from './workspaces';
import { TurnsRepo } from './turns';
import { EventsRepo } from './events';

// A UUIDv7 shape check: 8-4-4-4-12 hex with version nibble '7'.
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-turns-'));
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

/** Create a project + workspace and return the workspace id (FK parent for turns). */
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

describe('migration 0003 (fresh temp DB)', () => {
  it('applies: a turn insert + an event append both succeed', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const turns = new TurnsRepo(db);
    const events = new EventsRepo(db);

    const turn = await turns.create({
      workspaceId: wsId,
      idx: 0,
      status: 'streaming',
    });
    expect(turn.id).toMatch(UUID_V7);
    expect(turn.status).toBe('streaming');
    expect(turn.events).toEqual([]);

    const appended = await events.append({
      turnId: turn.id,
      event: { kind: 'text', delta: 'hello' },
    });
    expect(appended.id).toMatch(UUID_V7);
    expect(appended.turnId).toBe(turn.id);
    expect(appended.kind).toBe('text');
  });
});

describe('TurnsRepo', () => {
  it('nextIdx increments per workspace, independently', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const wsA = await seedWorkspace(db, 'paris');
    const wsB = await seedWorkspace(db, 'lyon');

    expect(await turns.nextIdx(wsA)).toBe(0);
    await turns.create({ workspaceId: wsA, idx: 0, status: 'streaming' });
    expect(await turns.nextIdx(wsA)).toBe(1);
    await turns.create({ workspaceId: wsA, idx: 1, status: 'streaming' });
    expect(await turns.nextIdx(wsA)).toBe(2);

    // A different workspace keeps its own ordinal sequence.
    expect(await turns.nextIdx(wsB)).toBe(0);
  });

  it('setStatus writes the transition plus terminal bookkeeping', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const wsId = await seedWorkspace(db);
    const turn = await turns.create({
      workspaceId: wsId,
      idx: 0,
      status: 'streaming',
    });

    await turns.setStatus(turn.id, 'completed', {
      endedAt: 12345,
      inputTokens: 10,
      outputTokens: 20,
    });

    const fetched = await turns.getById(turn.id);
    expect(fetched?.status).toBe('completed');
    expect(fetched?.endedAt).toBe(12345);
    expect(fetched?.inputTokens).toBe(10);
    expect(fetched?.outputTokens).toBe(20);
  });

  it('listByWorkspace returns turns ordered by idx ASC', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const wsId = await seedWorkspace(db);
    await turns.create({ workspaceId: wsId, idx: 2, status: 'completed' });
    await turns.create({ workspaceId: wsId, idx: 0, status: 'completed' });
    await turns.create({ workspaceId: wsId, idx: 1, status: 'completed' });

    const list = await turns.listByWorkspace(wsId);
    expect(list.map((t) => t.idx)).toEqual([0, 1, 2]);
  });

  it('rejects a duplicate (workspace_id, idx) via the unique index', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const wsId = await seedWorkspace(db);
    await turns.create({ workspaceId: wsId, idx: 0, status: 'streaming' });

    await expect(
      turns.create({ workspaceId: wsId, idx: 0, status: 'streaming' }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it('clears history and resume context without reusing turn indexes', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const wsId = await seedWorkspace(db);
    const turn = await turns.create({
      workspaceId: wsId,
      idx: 0,
      status: 'completed',
    });
    await turns.setSessionId(turn.id, 'session-before-clear');

    await turns.clearWorkspaceHistory(wsId);

    expect(await turns.listByWorkspace(wsId)).toEqual([]);
    expect(await turns.latestSessionId(wsId)).toBeUndefined();
    expect(await turns.nextIdx(wsId)).toBe(1);
  });
});

describe('TurnsRepo revert semantics (Phase 4)', () => {
  it('markRevertedAfter drops later turns from history + latestSessionId, keeps nextIdx climbing', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const wsId = await seedWorkspace(db);

    // Three turns; each captures a session id so latestSessionId has something to pick.
    for (let idx = 0; idx < 3; idx++) {
      const t = await turns.create({
        workspaceId: wsId,
        idx,
        status: 'completed',
      });
      await turns.setSessionId(t.id, `sess-${idx}`);
    }
    expect(await turns.latestSessionId(wsId)).toBe('sess-2');
    expect((await turns.listByWorkspace(wsId)).map((t) => t.idx)).toEqual([
      0, 1, 2,
    ]);

    // Revert to turn 0: turns 1 and 2 are marked reverted.
    await turns.markRevertedAfter(wsId, 0);

    // History + latestSessionId now ignore the reverted turns (fresh session next).
    expect((await turns.listByWorkspace(wsId)).map((t) => t.idx)).toEqual([0]);
    expect(await turns.latestSessionId(wsId)).toBe('sess-0');

    // nextIdx must NOT filter — ordinals keep climbing so ref names never collide.
    expect(await turns.nextIdx(wsId)).toBe(3);
  });

  it('markRevertedAfter is idempotent + excludes the target idx itself', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const wsId = await seedWorkspace(db);
    for (let idx = 0; idx < 3; idx++) {
      await turns.create({ workspaceId: wsId, idx, status: 'completed' });
    }

    await turns.markRevertedAfter(wsId, 1); // reverts idx 2 only (1 is retained)
    expect((await turns.listByWorkspace(wsId)).map((t) => t.idx)).toEqual([
      0, 1,
    ]);

    // A second call is a harmless no-op (already-reverted turns are left untouched).
    await turns.markRevertedAfter(wsId, 1);
    expect((await turns.listByWorkspace(wsId)).map((t) => t.idx)).toEqual([
      0, 1,
    ]);
  });

  it('clearWorkspaceHistory hides all turns without deleting FK-referenced rows', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const wsId = await seedWorkspace(db);
    const turn = await turns.create({
      workspaceId: wsId,
      idx: 0,
      status: 'completed',
    });
    await db
      .insertInto('checkpoints')
      .values({
        id: 'cp-clear',
        workspace_id: wsId,
        turn_id: turn.id,
        ref_name: `refs/checkpoints/${wsId}/0`,
        sha: 'abc123',
        created_at: Date.now(),
      })
      .execute();

    await turns.clearWorkspaceHistory(wsId);

    expect(await turns.listByWorkspace(wsId)).toEqual([]);
    expect(await turns.getById(turn.id)).not.toBeNull();
    const checkpoint = await db
      .selectFrom('checkpoints')
      .select('id')
      .where('id', '=', 'cp-clear')
      .executeTakeFirst();
    expect(checkpoint?.id).toBe('cp-clear');
    expect(await turns.latestSessionId(wsId)).toBeUndefined();
  });
});

describe('EventsRepo round-trip', () => {
  it('appends several AgentEvents and lists them in order with exact payloads', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const events = new EventsRepo(db);
    const wsId = await seedWorkspace(db);
    const turn = await turns.create({
      workspaceId: wsId,
      idx: 0,
      status: 'streaming',
    });

    // A representative spread of the frozen AgentEvent union — including nested/unknown
    // payload shapes (tool_use.input is `unknown`) to prove opaque JSON round-trip.
    const sequence: AgentEvent[] = [
      { kind: 'text', delta: 'Working on it…' },
      {
        kind: 'tool_use',
        name: 'read_file',
        input: { path: '/a/b.ts', lines: [1, 40] },
      },
      { kind: 'tool_result', output: { ok: true, bytes: 123 } },
      { kind: 'file_edit', path: 'src/x.ts', op: 'modify' },
      {
        kind: 'todo_update',
        todos: [{ id: 't1', body: 'do it', done: false, source: 'agent' }],
      },
      { kind: 'turn_end', usage: { inputTokens: 5, outputTokens: 7 } },
    ];

    // Append with strictly increasing ts so ordering is deterministic.
    let ts = 1000;
    for (const event of sequence) {
      await events.append({ turnId: turn.id, event, ts: ts++ });
    }

    const listed = await events.listByTurn(turn.id);
    expect(listed).toHaveLength(sequence.length);
    expect(listed.map((e) => e.kind)).toEqual(sequence.map((e) => e.kind));
    // Deserialized payloads must equal what was written, verbatim.
    expect(listed.map((e) => e.event)).toEqual(sequence);
  });

  it('scopes listByTurn to the given turn', async () => {
    db = openDb(dbFile);
    const turns = new TurnsRepo(db);
    const events = new EventsRepo(db);
    const wsId = await seedWorkspace(db);
    const t1 = await turns.create({
      workspaceId: wsId,
      idx: 0,
      status: 'streaming',
    });
    const t2 = await turns.create({
      workspaceId: wsId,
      idx: 1,
      status: 'streaming',
    });

    await events.append({
      turnId: t1.id,
      event: { kind: 'text', delta: 'one' },
    });
    await events.append({
      turnId: t2.id,
      event: { kind: 'text', delta: 'two' },
    });

    const forT1 = await events.listByTurn(t1.id);
    expect(forT1).toHaveLength(1);
    expect(forT1[0].event).toEqual({ kind: 'text', delta: 'one' });
  });
});
