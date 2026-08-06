// TaskScheduler tests (Phase 12, design doc §8). A REAL ScheduledTasksRepo over a temp
// better-sqlite3 DB (so state transitions are exercised end-to-end) plus a FAKE harness
// supervisor that records `startTurn` calls and exposes the sink so a scripted event
// sequence can be replayed. An injected clock keeps timing deterministic.
//
// Covers: a due task fires → done; a busy workspace queues; `onWorkspaceTurnEnd` drains
// FIFO; `AppError('conflict')` from startTurn re-queues; an error terminal → error +
// message; `turn:event` ordering (incl. buffered-until-turnId); boot reconcile → missed;
// stop() halts ticking; and opts assembly (fresh sessions with mode/model/harness
// passthrough).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type AppDatabase } from '../db';
import { ProjectsRepo } from '../db/repos/projects';
import { WorkspacesRepo } from '../db/repos/workspaces';
import { ScheduledTasksRepo } from '../db/repos/tasks';
import { AgentRunsRepo } from '../db/repos/agentRuns';
import { TurnsRepo } from '../db/repos/turns';
import { TaskScheduler, type TaskSchedulerDeps } from './index';
import { AppError } from '@shared/errors';
import type { AgentEvent, StartTurnOpts } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import type { EffectiveSettings } from '@shared/settings';
import type { Workspace } from '@shared/models';
import type {
  MetaRunDetail,
  MetaRunSummary,
  NormalizedAgentSnapshot,
} from '@shared/agents';

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
  harnessOverrides: Array<string | undefined> = [];
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
    harnessOverride?: string,
  ): Promise<{ sessionId: string; interrupt: () => Promise<void> }> {
    if (this.conflictOnce) {
      this.conflictOnce = false;
      throw new AppError('conflict', 'a turn is already active');
    }
    const turnId = this.nextTurnId;
    this.activeTurnId.set(workspaceId, turnId);
    this.active.add(workspaceId);
    this.calls.push({ workspaceId, opts, sink });
    this.harnessOverrides.push(harnessOverride);
    this.onStart?.(sink);
    return { sessionId: opts.sessionId ?? 'sess', interrupt: async () => {} };
  }
}

let tmpDir: string;
let db: AppDatabase;
let repo: ScheduledTasksRepo;
let projectId: string;
let workspaceId: string;
let worktreePath: string;
let fakeTurnId: string;
let harness: FakeHarness;
let emitted: { event: string; payload: unknown }[];
let scheduler: TaskScheduler;
const NOW = 1_000_000;

const META_SNAPSHOT: NormalizedAgentSnapshot = {
  schemaVersion: 1,
  slug: 'scheduled-agent',
  name: 'Scheduled agent',
  description: 'Runs scheduled work',
  revision: 'revision-1',
  prompt: 'Coordinate the task.',
  coordinator: { harness: 'claude_code', mode: 'plan' },
  roles: [],
  skills: [],
  capabilities: ['delegate'],
  requiredProviders: ['claude_code'],
  policy: {
    maxDispatches: 1,
    maxParallel: 1,
    maxDepth: 1,
    turnTimeoutMs: 10_000,
    runTimeoutMs: 60_000,
    maxRequestBytes: 1_024,
    maxResultBytes: 1_024,
    critiqueRounds: 0,
  },
};

async function metaRun(
  status: MetaRunSummary['status'],
): Promise<MetaRunDetail> {
  const runRepo = new AgentRunsRepo(db);
  const durable = await runRepo.create({
    projectId,
    sourceWorkspaceId: workspaceId,
    agentId: 'project:demo:scheduled-agent',
    snapshot: META_SNAPSHOT,
    goal: 'go',
    allowPush: false,
    allowOpenPr: false,
  });
  if (status === 'running') {
    await runRepo.setCoordinator(durable.id, workspaceId);
  } else if (status !== 'starting') {
    await runRepo.transition(
      durable.id,
      status,
      status === 'completed'
        ? { summary: 'done' }
        : status === 'failed'
          ? { error: 'provider failed' }
          : {},
    );
  }
  const stored = await runRepo.get(durable.id);
  return {
    ...stored,
    dispatches: [],
  };
}

function agentRecord() {
  const snapshotJson = JSON.stringify(META_SNAPSHOT);
  return {
    id: 'project:demo:scheduled-agent',
    name: META_SNAPSHOT.name,
    revision: META_SNAPSHOT.revision,
    snapshotJson,
    digest: createHash('sha256').update(snapshotJson).digest('hex'),
  };
}

function makeScheduler(overrides?: Partial<TaskSchedulerDeps>): TaskScheduler {
  return new TaskScheduler({
    repo,
    harness: harness as unknown as TaskSchedulerDeps['harness'],
    getWorkspace: async (id): Promise<Workspace | null> =>
      id === workspaceId
        ? ({
            id,
            projectId,
            worktreePath,
            harness: 'claude_code',
          } as unknown as Workspace)
        : null,
    settings: { get: () => SETTINGS },
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
  projectId = project.id;
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
  it('starts run-now tasks fresh while preserving model, harness, and settings mode', async () => {
    const task = await repo.create({
      workspaceId,
      prompt: 'go',
      model: 'sonnet',
      harnessOverride: 'codex',
      attachments: [{ type: 'file', path: '/tmp/spec.md' }],
      effort: 'high',
    });
    await scheduler.runNow(task.id);

    const opts = harness.calls[0].opts;
    expect(opts.sessionId).toBeUndefined();
    expect(opts.model).toBe('sonnet');
    expect(opts.mode).toBe('default'); // task.mode null → settings default
    expect(opts.prompt).toBe('go');
    expect(opts.attachments).toEqual([{ type: 'file', path: '/tmp/spec.md' }]);
    expect(opts.effort).toBe('high');
    expect(opts.workspaceDir).toBe(worktreePath);
    expect(harness.harnessOverrides).toEqual(['codex']);
  });

  it('starts due tasks fresh even when the workspace has a latest session', async () => {
    await new TurnsRepo(db).setSessionId(fakeTurnId, 'existing-session');
    const task = await repo.create({
      workspaceId,
      prompt: 'due',
      scheduledAt: NOW,
      model: 'opus',
      mode: 'plan',
      harnessOverride: 'cursor',
    });

    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));

    expect(harness.calls[0].opts).toMatchObject({
      prompt: 'due',
      sessionId: undefined,
      model: 'opus',
      mode: 'plan',
    });
    expect(harness.harnessOverrides).toEqual(['cursor']);
    expect((await repo.get(task.id)).state).toBe('running');
  });

  it('starts each sequential queued task with fresh provider context', async () => {
    await new TurnsRepo(db).setSessionId(fakeTurnId, 'existing-session');
    const first = await repo.create({
      workspaceId,
      prompt: 'first',
      model: 'sonnet',
      mode: 'plan',
      harnessOverride: 'codex',
    });
    const second = await repo.create({
      workspaceId,
      prompt: 'second',
      model: 'opus',
      mode: 'auto_accept',
      harnessOverride: 'cursor',
    });
    await repo.setState(first.id, 'queued');
    await repo.setState(second.id, 'queued');

    scheduler.onWorkspaceTurnEnd(workspaceId);
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    harness.calls[0].sink.push({ kind: 'turn_end' });
    await vi.waitFor(async () =>
      expect((await repo.get(first.id)).state).toBe('done'),
    );
    harness.active.delete(workspaceId);
    scheduler.onWorkspaceTurnEnd(workspaceId);
    await vi.waitFor(() => expect(harness.calls).toHaveLength(2));

    expect(
      harness.calls.map(({ opts }) => ({
        prompt: opts.prompt,
        sessionId: opts.sessionId,
        model: opts.model,
        mode: opts.mode,
      })),
    ).toEqual([
      {
        prompt: 'first',
        sessionId: undefined,
        model: 'sonnet',
        mode: 'plan',
      },
      {
        prompt: 'second',
        sessionId: undefined,
        model: 'opus',
        mode: 'auto_accept',
      },
    ]);
    expect(harness.harnessOverrides).toEqual(['codex', 'cursor']);
  });
});

describe('TaskScheduler — turn:event mirroring', () => {
  it('announces a dedicated resumable session before mirroring task output', async () => {
    harness.onStart = (sink) => sink.push({ kind: 'text', delta: 'working' });
    const task = await repo.create({
      workspaceId,
      prompt: 'Audit the release workflow',
    });

    await scheduler.runNow(task.id);

    const sessionStartedIndex = emitted.findIndex(
      ({ event }) => event === 'task:turnStarted',
    );
    const firstTurnEventIndex = emitted.findIndex(
      ({ event }) => event === 'turn:event',
    );
    expect(sessionStartedIndex).toBeGreaterThanOrEqual(0);
    expect(sessionStartedIndex).toBeLessThan(firstTurnEventIndex);
    expect(emitted[sessionStartedIndex]?.payload).toEqual({
      workspaceId,
      taskId: task.id,
      turnId: fakeTurnId,
      sessionId: 'sess',
      prompt: 'Audit the release workflow',
    });
  });

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

describe('TaskScheduler — scheduled meta agents', () => {
  it('rejects a digest-valid but structurally invalid stored snapshot before meta start', async () => {
    const meta = {
      start: vi.fn(),
      onTerminal: vi.fn(async () => () => {}),
      onClaimsReleased: vi.fn(() => () => {}),
      isWorkspaceClaimed: vi.fn(() => false),
    };
    scheduler.setMetaHarness(
      meta as unknown as Parameters<TaskScheduler['setMetaHarness']>[0],
    );
    const task = await repo.create(
      {
        workspaceId,
        prompt: 'must not run malformed config',
        agentId: agentRecord().id,
      },
      agentRecord(),
    );
    const malformed = JSON.stringify({
      ...META_SNAPSHOT,
      coordinator: { ...META_SNAPSHOT.coordinator, command: '/bin/sh' },
    });
    await db
      .updateTable('scheduled_tasks')
      .set({
        agent_snapshot_json: malformed,
        agent_snapshot_digest: createHash('sha256')
          .update(malformed)
          .digest('hex'),
      })
      .where('id', '=', task.id)
      .execute();

    await scheduler.runNow(task.id);

    expect(await repo.get(task.id)).toMatchObject({
      state: 'error',
      errorMessage: 'scheduled agent snapshot schema is invalid',
      metaRunId: null,
    });
    expect(meta.start).not.toHaveBeenCalled();
    expect(harness.calls).toHaveLength(0);
  });

  it('cannot miss a meta run that completes before terminal-listener registration returns', async () => {
    const completed = await metaRun('completed');
    const meta = {
      start: vi.fn(async () => completed),
      onTerminal: vi.fn(
        async (_runId: string, listener: (run: MetaRunSummary) => void) => {
          listener(completed);
          return () => {};
        },
      ),
      onClaimsReleased: vi.fn(() => () => {}),
      isWorkspaceClaimed: vi.fn(() => false),
    };
    scheduler.setMetaHarness(
      meta as unknown as Parameters<TaskScheduler['setMetaHarness']>[0],
    );
    const task = await repo.create(
      {
        workspaceId,
        prompt: 'go',
        agentId: agentRecord().id,
      },
      agentRecord(),
    );

    await scheduler.runNow(task.id);

    await vi.waitFor(async () =>
      expect(await repo.get(task.id)).toMatchObject({
        state: 'done',
        metaRunId: completed.id,
        errorMessage: null,
      }),
    );
    expect(meta.start).toHaveBeenCalledWith(
      {
        projectId,
        agentId: agentRecord().id,
        sourceWorkspaceId: workspaceId,
        goal: 'go',
      },
      META_SNAPSHOT,
    );
    expect(meta.onTerminal).toHaveBeenCalledWith(
      completed.id,
      expect.any(Function),
    );
    expect(harness.calls).toHaveLength(0);
  });

  it('queues behind a claimed workspace and drains after the meta service releases it', async () => {
    let claimed = true;
    let releaseClaims: ((workspaceIds: string[]) => void) | undefined;
    const running = await metaRun('running');
    const meta = {
      start: vi.fn(async () => running),
      onTerminal: vi.fn(async () => () => {}),
      onClaimsReleased: vi.fn((listener: (workspaceIds: string[]) => void) => {
        releaseClaims = listener;
        return () => {};
      }),
      isWorkspaceClaimed: vi.fn(() => claimed),
    };
    scheduler.setMetaHarness(
      meta as unknown as Parameters<TaskScheduler['setMetaHarness']>[0],
    );
    const task = await repo.create(
      {
        workspaceId,
        prompt: 'queued meta task',
        agentId: agentRecord().id,
      },
      agentRecord(),
    );

    expect((await scheduler.runNow(task.id)).state).toBe('queued');
    expect(meta.start).not.toHaveBeenCalled();

    claimed = false;
    releaseClaims?.([workspaceId]);

    await vi.waitFor(() => expect(meta.start).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () =>
      expect(await repo.get(task.id)).toMatchObject({
        state: 'running',
        metaRunId: running.id,
        errorMessage: null,
      }),
    );
  });
});

describe('TaskScheduler.start — boot reconcile + tick', () => {
  it('maps terminal meta_run_id states without resuming them and preserves ordinary-turn reconciliation', async () => {
    const meta = {
      start: vi.fn(),
      onTerminal: vi.fn(async () => () => {}),
      onClaimsReleased: vi.fn(() => () => {}),
      isWorkspaceClaimed: vi.fn(() => false),
    };
    scheduler.setMetaHarness(
      meta as unknown as Parameters<TaskScheduler['setMetaHarness']>[0],
    );
    const statuses = [
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'taken_over',
    ] as const;
    const metaTasks = new Map<
      (typeof statuses)[number],
      Awaited<ReturnType<ScheduledTasksRepo['create']>>
    >();
    for (const status of statuses) {
      const run = await metaRun(status);
      const task = await repo.create(
        {
          workspaceId,
          prompt: `recover ${status}`,
          agentId: agentRecord().id,
        },
        agentRecord(),
      );
      await repo.setState(task.id, 'running');
      await repo.setMetaRunId(task.id, run.id);
      metaTasks.set(status, task);
    }
    const completedTurn = await new TurnsRepo(db).create({
      workspaceId,
      idx: 99,
      status: 'completed',
    });
    const ordinary = await repo.create({
      workspaceId,
      prompt: 'ordinary completed turn',
    });
    await repo.setState(ordinary.id, 'running', {
      turnId: completedTurn.id,
    });

    await scheduler.start();
    scheduler.stop();

    expect(await repo.get(metaTasks.get('completed')!.id)).toMatchObject({
      state: 'done',
      errorMessage: null,
    });
    expect(await repo.get(metaTasks.get('failed')!.id)).toMatchObject({
      state: 'error',
      errorMessage: 'provider failed',
    });
    for (const status of ['cancelled', 'interrupted', 'taken_over'] as const) {
      expect(await repo.get(metaTasks.get(status)!.id)).toMatchObject({
        state: 'error',
        errorMessage: `meta run ${status.replaceAll('_', ' ')}`,
      });
    }
    expect(await repo.get(ordinary.id)).toMatchObject({
      state: 'done',
      errorMessage: null,
      metaRunId: null,
    });
    expect(meta.start).not.toHaveBeenCalled();
    expect(harness.calls).toHaveLength(0);
  });

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
