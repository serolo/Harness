// ScheduledTasksRepo tests (Phase 12). Opens a real temp better-sqlite3 DB (path injected
// into `openDb`), seeds FK parents (project + workspace [+ turns]), and exercises the repo
// against a live schema — mirroring repos/todos.test.ts / repos/turns.test.ts.
//
// Covers: create state derivation (timed → scheduled, untimed → pending) + rowToTask
// round-trip; update field patch + reschedule derivation (missed → scheduled, clear →
// pending); update/delete `conflict` while running; setState turnId/errorMessage;
// `listDue` boundary (`<= now`, scheduled-only); `nextQueued` FIFO; and all four
// `reconcileOnBoot` branches.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from './projects';
import { WorkspacesRepo } from './workspaces';
import { TurnsRepo } from './turns';
import { ScheduledTasksRepo } from './tasks';
import type { TurnStatus } from '@shared/models';

let tmpDir: string;
let db: AppDatabase;
let repo: ScheduledTasksRepo;
let workspaceId: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-tasks-repo-'));
  db = openDb(join(tmpDir, 'test.db'));
  repo = new ScheduledTasksRepo(db);

  const project = await new ProjectsRepo(db).create({
    name: 'demo',
    originUrl: 'git@github.com:acme/demo.git',
    defaultBranch: 'main',
    repoPath: '/tmp/repo/demo',
  });
  const workspace = await new WorkspacesRepo(db).create({
    projectId: project.id,
    name: 'paris',
    branch: 'agent/paris',
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'idle',
  });
  workspaceId = workspace.id;
});

afterEach(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a turn row in a terminal/streaming state and return its id (FK for turn_id). */
async function makeTurn(status: TurnStatus, idx: number): Promise<string> {
  const turn = await new TurnsRepo(db).create({
    workspaceId,
    idx,
    status,
  });
  return turn.id;
}

describe('ScheduledTasksRepo.create — state derivation', () => {
  it('derives "scheduled" for a timed task and round-trips through rowToTask', async () => {
    const at = Date.now() + 60_000;
    const task = await repo.create({
      workspaceId,
      prompt: 'do it',
      model: 'sonnet',
      mode: 'plan',
      scheduledAt: at,
    });
    expect(task).toMatchObject({
      workspaceId,
      prompt: 'do it',
      model: 'sonnet',
      mode: 'plan',
      scheduledAt: at,
      state: 'scheduled',
      origin: 'user',
      turnId: null,
      errorMessage: null,
    });
    expect(await repo.get(task.id)).toEqual(task);
  });

  it('derives "pending" for an untimed task and defaults nulls + origin', async () => {
    const task = await repo.create({ workspaceId, prompt: 'later' });
    expect(task).toMatchObject({
      state: 'pending',
      model: null,
      mode: null,
      scheduledAt: null,
      origin: 'user',
    });
  });

  it('honors an explicit origin', async () => {
    const task = await repo.create({
      workspaceId,
      prompt: 'resume',
      origin: 'limit_resume',
    });
    expect(task.origin).toBe('limit_resume');
  });
});

describe('ScheduledTasksRepo.get', () => {
  it('throws not_found for a missing id', async () => {
    await expect(repo.get('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('ScheduledTasksRepo.update — patch + state re-derivation', () => {
  it('patches prompt/model/mode without touching state when scheduledAt is absent', async () => {
    const task = await repo.create({ workspaceId, prompt: 'a' });
    const updated = await repo.update(task.id, {
      prompt: 'b',
      model: 'opus',
      mode: 'auto_accept',
    });
    expect(updated).toMatchObject({
      prompt: 'b',
      model: 'opus',
      mode: 'auto_accept',
      state: 'pending', // unchanged — no schedule in the patch
    });
  });

  it('reschedules a missed task to "scheduled" when a time is set', async () => {
    const task = await repo.create({ workspaceId, prompt: 'a' });
    await repo.setState(task.id, 'missed');
    const at = Date.now() + 120_000;
    const updated = await repo.update(task.id, { scheduledAt: at });
    expect(updated).toMatchObject({ state: 'scheduled', scheduledAt: at });
  });

  it('clears the schedule (null) back to "pending"', async () => {
    const task = await repo.create({
      workspaceId,
      prompt: 'a',
      scheduledAt: Date.now() + 1000,
    });
    const updated = await repo.update(task.id, { scheduledAt: null });
    expect(updated).toMatchObject({ state: 'pending', scheduledAt: null });
  });

  it('rejects an update while running with conflict', async () => {
    const task = await repo.create({ workspaceId, prompt: 'a' });
    await repo.setState(task.id, 'running');
    await expect(repo.update(task.id, { prompt: 'b' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('rejects an update on a queued task (must not leave the FIFO drain)', async () => {
    const task = await repo.create({ workspaceId, prompt: 'a' });
    await repo.setState(task.id, 'queued');
    await expect(
      repo.update(task.id, { scheduledAt: Date.now() + 1000 }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects an update on a done task (must not resurrect it)', async () => {
    const task = await repo.create({ workspaceId, prompt: 'a' });
    await repo.setState(task.id, 'done');
    await expect(
      repo.update(task.id, { scheduledAt: Date.now() + 1000 }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('ScheduledTasksRepo.setState', () => {
  it('records turnId + clears an errorMessage', async () => {
    const task = await repo.create({ workspaceId, prompt: 'a' });
    const turnId = await makeTurn('completed', 0);
    const updated = await repo.setState(task.id, 'done', {
      turnId,
      errorMessage: null,
    });
    expect(updated).toMatchObject({
      state: 'done',
      turnId,
      errorMessage: null,
    });
  });

  it('records an errorMessage', async () => {
    const task = await repo.create({ workspaceId, prompt: 'a' });
    const updated = await repo.setState(task.id, 'error', {
      errorMessage: 'boom',
    });
    expect(updated).toMatchObject({ state: 'error', errorMessage: 'boom' });
  });
});

describe('ScheduledTasksRepo.delete', () => {
  it('deletes a non-running task', async () => {
    const task = await repo.create({ workspaceId, prompt: 'a' });
    await repo.delete(task.id);
    await expect(repo.get(task.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects a delete while running with conflict', async () => {
    const task = await repo.create({ workspaceId, prompt: 'a' });
    await repo.setState(task.id, 'running');
    await expect(repo.delete(task.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('ScheduledTasksRepo.listDue — boundary', () => {
  it('returns only scheduled tasks with scheduled_at <= now, ascending', async () => {
    const now = 10_000;
    const past = await repo.create({
      workspaceId,
      prompt: 'past',
      scheduledAt: now - 1,
    });
    const exact = await repo.create({
      workspaceId,
      prompt: 'exact',
      scheduledAt: now, // boundary is inclusive
    });
    await repo.create({
      workspaceId,
      prompt: 'future',
      scheduledAt: now + 1,
    });
    // A pending (untimed) task must never appear in listDue.
    await repo.create({ workspaceId, prompt: 'untimed' });

    const due = await repo.listDue(now);
    expect(due.map((t) => t.id)).toEqual([past.id, exact.id]);
  });
});

describe('ScheduledTasksRepo.nextQueued — FIFO', () => {
  it('returns the oldest queued task by created_at', async () => {
    const first = await repo.create({ workspaceId, prompt: 'first' });
    const second = await repo.create({ workspaceId, prompt: 'second' });
    await repo.setState(second.id, 'queued');
    await repo.setState(first.id, 'queued');

    const next = await repo.nextQueued(workspaceId);
    expect(next?.id).toBe(first.id); // created first, drains first
  });

  it('returns undefined when nothing is queued', async () => {
    await repo.create({ workspaceId, prompt: 'a' });
    expect(await repo.nextQueued(workspaceId)).toBeUndefined();
  });
});

describe('ScheduledTasksRepo.reconcileOnBoot — all four branches', () => {
  it('scheduled(overdue) → missed, queued → missed, running(completed) → done, running(stale) → error', async () => {
    const now = 100_000;

    const overdue = await repo.create({
      workspaceId,
      prompt: 'overdue',
      scheduledAt: now - 1,
    });
    const future = await repo.create({
      workspaceId,
      prompt: 'future',
      scheduledAt: now + 60_000,
    });
    const queued = await repo.create({ workspaceId, prompt: 'queued' });
    await repo.setState(queued.id, 'queued');

    const completedTurn = await makeTurn('completed', 0);
    const runningDone = await repo.create({ workspaceId, prompt: 'ran-ok' });
    await repo.setState(runningDone.id, 'running', { turnId: completedTurn });

    const staleTurn = await makeTurn('streaming', 1);
    const runningStale = await repo.create({
      workspaceId,
      prompt: 'ran-stale',
    });
    await repo.setState(runningStale.id, 'running', { turnId: staleTurn });

    const affected = await repo.reconcileOnBoot(now);
    expect(affected).toEqual([workspaceId]);

    expect((await repo.get(overdue.id)).state).toBe('missed');
    expect((await repo.get(queued.id)).state).toBe('missed');
    expect((await repo.get(runningDone.id)).state).toBe('done');

    const stale = await repo.get(runningStale.id);
    expect(stale.state).toBe('error');
    expect(stale.errorMessage).toBe('app closed while the task was running');

    // A future scheduled task is left untouched.
    expect((await repo.get(future.id)).state).toBe('scheduled');
  });

  it('running(error turn) → error', async () => {
    const now = 100_000;
    const errorTurn = await makeTurn('error', 0);
    const task = await repo.create({ workspaceId, prompt: 'ran-error' });
    await repo.setState(task.id, 'running', { turnId: errorTurn });

    await repo.reconcileOnBoot(now);
    expect((await repo.get(task.id)).state).toBe('error');
  });

  it('running with no turn_id (crashed before startTurn) → error + app-closed message', async () => {
    const now = 100_000;
    // A task that reached `running` (that write precedes startTurn) but never recorded a
    // turn id must still be reconciled, not left dangling.
    const task = await repo.create({ workspaceId, prompt: 'ran-no-turn' });
    await repo.setState(task.id, 'running');

    await repo.reconcileOnBoot(now);
    const reconciled = await repo.get(task.id);
    expect(reconciled.state).toBe('error');
    expect(reconciled.errorMessage).toBe(
      'app closed while the task was running',
    );
  });
});
