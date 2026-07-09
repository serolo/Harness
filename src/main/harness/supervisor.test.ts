// HarnessSupervisor: lifecycle, single-turn invariant, status wiring, interrupt
// (Phase 2, Task 5). Driven by the MockHarness against a real temp DB + recorder, with
// spies on the injected status writer / emit / notifications. No child process, no
// Electron runtime.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import type { Workspace, WorkspaceStatus } from '@shared/models';
import { type AppError } from '@shared/errors';
import { openDb, type AppDatabase } from '../db/index';
import { ProjectsRepo } from '../db/repos/projects';
import { WorkspacesRepo } from '../db/repos/workspaces';
import { TurnsRepo } from '../db/repos/turns';
import { EventsRepo } from '../db/repos/events';
import { TurnRecorder } from './turns';
import { MockHarness } from './mock';
import { HarnessSupervisor } from './supervisor';
import type { NotificationService } from './notifications';

let tmpDir: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-supervisor-'));
  db = undefined;
});
afterEach(async () => {
  if (db) {
    await db.destroy();
    db = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedWorkspace(handle: AppDatabase): Promise<Workspace> {
  const project = await new ProjectsRepo(handle).create({
    name: 'demo',
    originUrl: 'git@github.com:acme/demo.git',
    defaultBranch: 'main',
    repoPath: '/tmp/repo/demo',
  });
  const ws = await new WorkspacesRepo(handle).create({
    projectId: project.id,
    name: 'paris',
    branch: 'agent/paris',
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'idle',
    worktreePath: '/tmp/repo/demo-paris',
  });
  return ws;
}

interface Harness2 {
  supervisor: HarnessSupervisor;
  recorder: TurnRecorder;
  statusCalls: WorkspaceStatus[];
  emitCalls: { event: string; payload: unknown }[];
  notify: { turnDone: ReturnType<typeof vi.fn> };
  workspace: Workspace;
}

async function makeHarness(
  handle: AppDatabase,
  mock: MockHarness,
): Promise<Harness2> {
  const workspace = await seedWorkspace(handle);
  const recorder = new TurnRecorder({
    turns: new TurnsRepo(handle),
    events: new EventsRepo(handle),
  });
  const statusCalls: WorkspaceStatus[] = [];
  const emitCalls: { event: string; payload: unknown }[] = [];
  const notify = { turnDone: vi.fn() };
  const supervisor = new HarnessSupervisor({
    recorder,
    getWorkspace: async (id) => (id === workspace.id ? workspace : null),
    setStatus: async (_id, status) => {
      statusCalls.push(status);
    },
    emit: (event, payload) => {
      emitCalls.push({ event, payload });
    },
    notifications: notify as unknown as NotificationService,
  });
  supervisor.register(mock);
  return { supervisor, recorder, statusCalls, emitCalls, notify, workspace };
}

/** A sink that resolves `done` when the stream ends/errors. */
function collectSink(): {
  sink: StreamSink<AgentEvent>;
  events: AgentEvent[];
  done: Promise<void>;
} {
  const events: AgentEvent[] = [];
  let resolveEnd!: () => void;
  const done = new Promise<void>((r) => (resolveEnd = r));
  return {
    events,
    done,
    sink: {
      push: (e) => events.push(e),
      end: () => resolveEnd(),
      error: () => resolveEnd(),
    },
  };
}

/** Poll until `predicate()` is true (real timers), up to `timeoutMs`. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Wait until a workspace's latest turn has left `streaming` — i.e. the async finalize
 * (endTurn's DB write) has committed. Prevents a teardown race where the DB is closed
 * mid-finalize (the last write in the terminal path is `endTurn`).
 */
async function waitForFinalized(
  recorder: TurnRecorder,
  workspaceId: string,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const turns = await recorder.history(workspaceId);
    const last = turns[turns.length - 1];
    if (last && last.status !== 'streaming') return;
    if (Date.now() - start > 1000) throw new Error('turn did not finalize');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const baseOpts = {
  workspaceDir: '/tmp/repo/demo-paris',
  prompt: 'do the thing',
  attachments: [],
  mcpConfig: [],
  permissionPolicy: {},
};

describe('HarnessSupervisor turn lifecycle', () => {
  it('runs a turn: idle→working→needs_attention, records completed, clears registry', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    const h = await makeHarness(db, new MockHarness({ defaultDelayMs: 0 }));
    const { sink, done } = collectSink();

    const handle = await h.supervisor.startTurn(h.workspace.id, baseOpts, sink);
    expect(handle.sessionId).toBe('mock-session-1');
    expect(h.supervisor.isActive(h.workspace.id)).toBe(true);

    await done;
    await waitUntil(() => h.statusCalls.includes('needs_attention'));

    // Status machine: working first, then needs_attention.
    expect(h.statusCalls[0]).toBe('working');
    expect(h.statusCalls).toContain('needs_attention');
    // Registry cleared → single-turn invariant restored.
    expect(h.supervisor.isActive(h.workspace.id)).toBe(false);
    // Attention event + notification fired.
    expect(h.emitCalls.some((c) => c.event === 'notify:needsAttention')).toBe(
      true,
    );
    expect(h.notify.turnDone).toHaveBeenCalled();

    // Persisted turn is completed with usage.
    const turns = await h.recorder.history(h.workspace.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe('completed');
    expect(turns[0].outputTokens).toBe(34);
  });

  it('rejects a concurrent turn with AppError(conflict)', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    // Long-running script so the first turn stays active.
    const mock = new MockHarness({
      defaultDelayMs: 50,
      script: () => [
        { event: { kind: 'text', delta: 'a' } },
        { event: { kind: 'text', delta: 'b' } },
        { event: { kind: 'turn_end' } },
      ],
    });
    const h = await makeHarness(db, mock);
    const first = collectSink();
    await h.supervisor.startTurn(h.workspace.id, baseOpts, first.sink);
    expect(h.supervisor.isActive(h.workspace.id)).toBe(true);

    const second = collectSink();
    await expect(
      h.supervisor.startTurn(h.workspace.id, baseOpts, second.sink),
    ).rejects.toMatchObject({ code: 'conflict' } as Partial<AppError>);

    await first.done;
    await waitForFinalized(h.recorder, h.workspace.id);
  });

  it('interrupt records an interrupted turn and clears the registry', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    const mock = new MockHarness({
      defaultDelayMs: 30,
      script: () => [
        { event: { kind: 'text', delta: 'a' } },
        { event: { kind: 'text', delta: 'b' } },
        { event: { kind: 'text', delta: 'c' } },
        { event: { kind: 'turn_end' } },
      ],
    });
    const h = await makeHarness(db, mock);
    const { sink, done } = collectSink();

    await h.supervisor.startTurn(h.workspace.id, baseOpts, sink);
    await h.supervisor.interrupt(h.workspace.id);
    await done;
    await waitForFinalized(h.recorder, h.workspace.id);

    const turns = await h.recorder.history(h.workspace.id);
    expect(turns[0].status).toBe('interrupted');
    expect(h.supervisor.isActive(h.workspace.id)).toBe(false);
  });

  it('persists the captured session id and forwards an explicit resume id', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    const seen: (string | undefined)[] = [];
    const mock = new MockHarness({
      defaultDelayMs: 0,
      script: (opts) => {
        seen.push(opts.sessionId);
        return [{ event: { kind: 'turn_end' } }];
      },
    });
    const h = await makeHarness(db, mock);

    // Turn 1: no resume id supplied → the supervisor persists the captured session id
    // onto the turn row (so the IPC layer can `--resume` it next time).
    const s1 = collectSink();
    await h.supervisor.startTurn(h.workspace.id, baseOpts, s1.sink);
    await s1.done;
    await waitForFinalized(h.recorder, h.workspace.id);

    expect(seen[0]).toBeUndefined();
    const afterFirst = await h.recorder.history(h.workspace.id);
    expect(afterFirst[0].sessionId).toBe('mock-session-1');
    // The recorder can surface it for the next turn's resume.
    expect(await h.recorder.latestSessionId(h.workspace.id)).toBe(
      'mock-session-1',
    );

    // Turn 2: an explicit resume id (what the producer would resolve) reaches the adapter.
    const s2 = collectSink();
    await h.supervisor.startTurn(
      h.workspace.id,
      { ...baseOpts, sessionId: 'mock-session-1' },
      s2.sink,
    );
    await s2.done;
    await waitForFinalized(h.recorder, h.workspace.id);

    expect(seen[1]).toBe('mock-session-1');
  });
});
