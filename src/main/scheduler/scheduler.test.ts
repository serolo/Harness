// TaskScheduler tests (Phase 12, design doc §8). A REAL ScheduledTasksRepo over a temp
// better-sqlite3 DB (so state transitions are exercised end-to-end) plus a FAKE harness
// supervisor that records `startTurn` calls and exposes the sink so a scripted event
// sequence can be replayed. An injected clock keeps timing deterministic.
//
// Covers: a due task fires → done; a busy workspace queues; `onWorkspaceTurnEnd` drains
// FIFO; `AppError('conflict')` from startTurn re-queues; an error terminal → error +
// message; `turn:event` ordering (incl. buffered-until-turnId); boot reconcile → missed;
// stop() halts ticking; and opts assembly (mode default, model passthrough, resume
// sessionId).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type AppDatabase } from '../db';
import { ProjectsRepo } from '../db/repos/projects';
import { WorkspacesRepo } from '../db/repos/workspaces';
import { ScheduledTasksRepo } from '../db/repos/tasks';
import { TurnsRepo } from '../db/repos/turns';
import { TaskScheduler, type TaskSchedulerDeps } from './index';
import { AppError } from '@shared/errors';
import type { AgentEvent, StartTurnOpts } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import type { EffectiveSettings } from '@shared/settings';
import type { Workspace } from '@shared/models';

/** A minimal settings snapshot exposing just what runTask reads. */
const SETTINGS = {
  agent: { mode: 'default', permissionPolicy: {} },
  mcp: [],
} as unknown as EffectiveSettings;

/** Records startTurn calls + exposes each sink; scriptable for conflict/error paths. */
class FakeHarness {
  active = new Set<string>();
  activeTurnId = new Map<string, string>();
  calls: {
    workspaceId: string;
    opts: StartTurnOpts;
    sink: StreamSink<AgentEvent>;
  }[] = [];
  nextTurnId = 'turn-1';
  conflictOnce = false;
  /** When set, called synchronously inside startTurn (to test buffered-until-turnId). */
  onStart?: (sink: StreamSink<AgentEvent>) => void;

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  getActiveTurnId(id: string): string | undefined {
    return this.activeTurnId.get(id);
  }

  async startTurn(
    workspaceId: string,
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<{ sessionId: string; interrupt: () => Promise<void> }> {
    if (this.conflictOnce) {
      this.conflictOnce = false;
      throw new AppError('conflict', 'a turn is already active');
    }
    const turnId = this.nextTurnId;
    this.activeTurnId.set(workspaceId, turnId);
    this.active.add(workspaceId);
    this.calls.push({ workspaceId, opts, sink });
    this.onStart?.(sink);
    return { sessionId: opts.sessionId ?? 'sess', interrupt: async () => {} };
  }
}

let tmpDir: string;
let db: AppDatabase;
let repo: ScheduledTasksRepo;
let workspaceId: string;
let worktreePath: string;
let fakeTurnId: string;
let harness: FakeHarness;
let emitted: { event: string; payload: unknown }[];
let scheduler: TaskScheduler;
const NOW = 1_000_000;

function makeScheduler(overrides?: Partial<TaskSchedulerDeps>): TaskScheduler {
  return new TaskScheduler({
    repo,
    harness: harness as unknown as TaskSchedulerDeps['harness'],
    getWorkspace: async (id): Promise<Workspace | null> =>
      id === workspaceId
        ? ({ id, worktreePath, harness: 'claude_code' } as unknown as Workspace)
        : null,
    settings: { get: () => SETTINGS },
    latestSessionId: async () => 'sess-123',
    emit: (event, payload) => emitted.push({ event, payload }),
    now: () => NOW,
    tickIntervalMs: 10_000,
    ...overrides,
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-scheduler-'));
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
  worktreePath = workspace.worktreePath ?? '/tmp/worktree/paris';

  // A real turn row so the scheduler's `turn_id` FK is satisfied (in production the
  // supervisor creates the turn before `getActiveTurnId` returns its id).
  const turn = await new TurnsRepo(db).create({
    workspaceId,
    idx: 0,
    status: 'streaming',
  });
  fakeTurnId = turn.id;

  harness = new FakeHarness();
  harness.nextTurnId = fakeTurnId;
  emitted = [];
  scheduler = makeScheduler();
});

afterEach(async () => {
  scheduler.stop();
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** turn:event payloads emitted for the given turnId, in order. */
function turnEvents(turnId: string): AgentEvent[] {
  return emitted
    .filter((e) => e.event === 'turn:event')
    .map((e) => e.payload as { turnId: string; event: AgentEvent })
    .filter((p) => p.turnId === turnId)
    .map((p) => p.event);
}

describe('TaskScheduler.runNow — fire path', () => {
  it('fires an idle task → running, then a turn_end drives it to done', async () => {
    const task = await repo.create({ workspaceId, prompt: 'go' });

    const after = await scheduler.runNow(task.id);
    expect(after.state).toBe('running');
    expect(harness.calls).toHaveLength(1);

    // Drive the terminal event through the recorded sink.
    harness.calls[0].sink.push({ kind: 'turn_end' });
    await vi.waitFor(async () =>
      expect((await repo.get(task.id)).state).toBe('done'),
    );
  });

  it('queues instead of firing when the workspace is busy', async () => {
    harness.active.add(workspaceId);
    const task = await repo.create({ workspaceId, prompt: 'go' });

    const after = await scheduler.runNow(task.id);
    expect(after.state).toBe('queued');
    expect(harness.calls).toHaveLength(0);
  });

  it('re-queues when startTurn reports a conflict (a user turn raced the fire)', async () => {
    harness.conflictOnce = true;
    const task = await repo.create({ workspaceId, prompt: 'go' });

    const after = await scheduler.runNow(task.id);
    expect(after.state).toBe('queued');
  });

  it('marks the task error (with the message) on an error terminal', async () => {
    const task = await repo.create({ workspaceId, prompt: 'go' });
    await scheduler.runNow(task.id);

    harness.calls[0].sink.push({
      kind: 'error',
      message: 'usage limit reached',
    });
    await vi.waitFor(async () => {
      const t = await repo.get(task.id);
      expect(t.state).toBe('error');
      expect(t.errorMessage).toBe('usage limit reached');
    });
  });
});

describe('TaskScheduler — opts assembly', () => {
  it('threads the resume sessionId, model, and the settings default mode', async () => {
    const task = await repo.create({
      workspaceId,
      prompt: 'go',
      model: 'sonnet',
    });
    await scheduler.runNow(task.id);

    const opts = harness.calls[0].opts;
    expect(opts.sessionId).toBe('sess-123'); // the resume mechanism
    expect(opts.model).toBe('sonnet');
    expect(opts.mode).toBe('default'); // task.mode null → settings default
    expect(opts.prompt).toBe('go');
    expect(opts.workspaceDir).toBe(worktreePath);
  });
});

describe('TaskScheduler — turn:event mirroring', () => {
  it('buffers events pushed before the turnId is known, then emits in order', async () => {
    // A text event pushed DURING startTurn (turnId not yet resolved) must be buffered and
    // flushed with the resolved turnId, ahead of the later terminal event.
    harness.onStart = (sink) => sink.push({ kind: 'text', delta: 'hello' });
    const task = await repo.create({ workspaceId, prompt: 'go' });

    await scheduler.runNow(task.id);
    harness.calls[0].sink.push({ kind: 'turn_end' });

    await vi.waitFor(async () =>
      expect((await repo.get(task.id)).state).toBe('done'),
    );
    expect(turnEvents(fakeTurnId)).toEqual([
      { kind: 'text', delta: 'hello' },
      { kind: 'turn_end' },
    ]);
  });
});

describe('TaskScheduler.onWorkspaceTurnEnd — FIFO drain', () => {
  it('drains the oldest queued task when a turn ends', async () => {
    const first = await repo.create({ workspaceId, prompt: 'first' });
    const second = await repo.create({ workspaceId, prompt: 'second' });
    await repo.setState(first.id, 'queued');
    await repo.setState(second.id, 'queued');

    scheduler.onWorkspaceTurnEnd(workspaceId);

    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    expect(harness.calls[0].opts.prompt).toBe('first'); // oldest drains first
    expect((await repo.get(first.id)).state).toBe('running');
    expect((await repo.get(second.id)).state).toBe('queued'); // still waiting
  });
});

describe('TaskScheduler.start — boot reconcile + tick', () => {
  it('reconciles an overdue scheduled task to missed and emits task:changed', async () => {
    const overdue = await repo.create({
      workspaceId,
      prompt: 'overdue',
      scheduledAt: NOW - 1,
    });
    // Force it back to `scheduled` with a past time (create already did) — reconcile flips it.
    await scheduler.start();
    scheduler.stop();

    expect((await repo.get(overdue.id)).state).toBe('missed');
    expect(
      emitted.some(
        (e) =>
          e.event === 'task:changed' &&
          (e.payload as { workspaceId: string }).workspaceId === workspaceId,
      ),
    ).toBe(true);
  });
});

describe('TaskScheduler.stop — halts ticking', () => {
  it('stops running ticks after stop() (listDue is not called again)', async () => {
    const listDue = vi.spyOn(repo, 'listDue');
    scheduler = makeScheduler({ tickIntervalMs: 15 });
    await scheduler.start(); // one immediate tick
    const callsAfterStart = listDue.mock.calls.length;
    scheduler.stop();

    await new Promise((r) => setTimeout(r, 90)); // ~6 intervals would have elapsed
    expect(listDue.mock.calls.length).toBe(callsAfterStart);
  });

  it('is idempotent', () => {
    expect(() => {
      scheduler.stop();
      scheduler.stop();
    }).not.toThrow();
  });
});
