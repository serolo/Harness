// HarnessSupervisor: lifecycle, single-turn invariant, status wiring, interrupt
// (Phase 2, Task 5). Driven by the MockHarness against a real temp DB + recorder, with
// spies on the injected status writer / emit / notifications. No child process, no
// Electron runtime.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent, Harness, TurnHandle } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import type { Workspace, WorkspaceStatus } from '@shared/models';
import { AppError } from '@shared/errors';
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
  mock: Harness,
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
  errors: unknown[];
  done: Promise<void>;
} {
  const events: AgentEvent[] = [];
  const errors: unknown[] = [];
  let resolveEnd!: () => void;
  const done = new Promise<void>((r) => (resolveEnd = r));
  return {
    events,
    errors,
    done,
    sink: {
      push: (e) => events.push(e),
      end: () => resolveEnd(),
      error: (error) => {
        errors.push(error);
        resolveEnd();
      },
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
    expect(turns[0].events[0]?.event).toEqual({
      kind: 'user_message',
      text: 'do the thing',
    });
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

  it('sanitizes adapter stream failures before forwarding them to consumers', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    const adapter: Harness = {
      id: 'claude_code',
      capabilities: () => ({
        supportsResume: true,
        supportsMcp: true,
        supportsPlanMode: true,
        rawTerminalFallback: false,
      }),
      detect: async () => ({ installed: true, authenticated: true }),
      startTurn: async (_opts, sink) => {
        setTimeout(
          () =>
            sink.error(
              new AppError(
                'harness',
                'Authorization: Bearer provider-secret at /tmp/private-turn',
              ),
            ),
          0,
        );
        return { sessionId: 'error-session', interrupt: vi.fn() };
      },
    };
    const h = await makeHarness(db, adapter);
    const collected = collectSink();

    await h.supervisor.startTurn(h.workspace.id, baseOpts, collected.sink);
    await collected.done;
    await waitForFinalized(h.recorder, h.workspace.id);

    expect(collected.errors).toHaveLength(1);
    expect(collected.errors[0]).toMatchObject({
      code: 'harness',
      message: 'Authorization: Bearer [redacted] at [private path]',
    });
    expect(JSON.stringify(collected.errors[0])).not.toContain(
      'provider-secret',
    );
  });

  it('enforces meta workspace ownership at the definitive start boundary', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    const h = await makeHarness(db, new MockHarness({ defaultDelayMs: 0 }));
    const guard = vi.fn((workspaceId: string, metaRunId?: string) => {
      expect(workspaceId).toBe(h.workspace.id);
      if (metaRunId !== 'run-owner') {
        throw new Error('workspace is claimed by an active meta run');
      }
    });
    h.supervisor.setWorkspaceClaimGuard(guard);

    await expect(
      h.supervisor.startTurn(h.workspace.id, baseOpts, collectSink().sink),
    ).rejects.toThrow('workspace is claimed by an active meta run');
    expect(await h.recorder.history(h.workspace.id)).toEqual([]);

    const internal = collectSink();
    await h.supervisor.startTurn(
      h.workspace.id,
      { ...baseOpts, metaRunId: 'run-owner' },
      internal.sink,
    );
    await internal.done;
    await waitForFinalized(h.recorder, h.workspace.id);
    expect(guard).toHaveBeenLastCalledWith(h.workspace.id, 'run-owner');
    expect(await h.recorder.history(h.workspace.id)).toHaveLength(1);
  });

  it('persists the display prompt and selected knowledge separately', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    const h = await makeHarness(db, new MockHarness());
    const { sink, done, events } = collectSink();

    await h.supervisor.startTurn(
      h.workspace.id,
      {
        ...baseOpts,
        prompt:
          'hello\n\n<project_knowledge>private context</project_knowledge>',
        displayPrompt: 'hello',
        knowledgeSources: [{ path: 'index.md', title: 'Project knowledge' }],
      },
      sink,
    );
    await done;

    const turns = await h.recorder.history(h.workspace.id);
    expect(turns[0].events[0]?.event).toEqual({
      kind: 'user_message',
      text: 'hello',
    });
    expect(turns[0].events[1]?.event).toEqual({
      kind: 'knowledge_context',
      sources: [{ path: 'index.md', title: 'Project knowledge' }],
    });
    expect(events).toContainEqual({
      kind: 'knowledge_context',
      sources: [{ path: 'index.md', title: 'Project knowledge' }],
    });
  });

  it('sanitizes auth, workspace, control, and MCP temp paths before stream and persistence', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    const mock = new MockHarness({
      script: () => [
        {
          event: {
            kind: 'error',
            message:
              'token=super-secret /tmp/repo/demo-paris /private/control.json /tmp/harness-mcp-123/mcp.json',
          },
        },
      ],
    });
    const h = await makeHarness(db, mock);
    const { sink, done, events } = collectSink();

    await h.supervisor.startTurn(h.workspace.id, baseOpts, sink);
    await done;
    await waitForFinalized(h.recorder, h.workspace.id);

    const visibleError = events.find((event) => event.kind === 'error');
    expect(visibleError).toEqual({
      kind: 'error',
      message: 'token=[redacted] [private path] [private path] [private path]',
    });
    const history = await h.recorder.history(h.workspace.id);
    expect(history[0].events).toContainEqual(
      expect.objectContaining({ event: visibleError }),
    );
    expect(JSON.stringify(history)).not.toContain('super-secret');
    expect(JSON.stringify(history)).not.toMatch(/\/(?:private|tmp)\//);
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

  it('delivers an interrupt requested while the adapter is still starting', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    let resolveStart!: (handle: TurnHandle) => void;
    let activeSink: StreamSink<AgentEvent> | undefined;
    const started = new Promise<TurnHandle>((resolve) => {
      resolveStart = resolve;
    });
    const interrupt = vi.fn(async () => {
      activeSink?.push({ kind: 'turn_end' });
      activeSink?.end();
    });
    const adapter: Harness = {
      id: 'claude_code',
      capabilities: () => ({
        supportsResume: true,
        supportsMcp: true,
        supportsPlanMode: true,
        rawTerminalFallback: false,
      }),
      detect: async () => ({ installed: true, authenticated: true }),
      startTurn: async (_opts, sink) => {
        activeSink = sink;
        return started;
      },
    };
    const h = await makeHarness(db, adapter);
    const collected = collectSink();
    const startPromise = h.supervisor.startTurn(
      h.workspace.id,
      baseOpts,
      collected.sink,
    );

    await waitUntil(
      () => h.supervisor.getActiveTurnId(h.workspace.id) !== undefined,
    );
    await h.supervisor.interrupt(h.workspace.id);
    expect(interrupt).not.toHaveBeenCalled();

    resolveStart({ sessionId: 'late-session', interrupt });
    await startPromise;
    await collected.done;
    await waitForFinalized(h.recorder, h.workspace.id);

    expect(interrupt).toHaveBeenCalledOnce();
    expect((await h.recorder.history(h.workspace.id))[0]?.status).toBe(
      'interrupted',
    );
  });

  it('delivers one provider interrupt across repeated interrupt and quit requests', async () => {
    db = openDb(join(tmpDir, 'test.db'));
    const interrupt = vi.fn(async () => undefined);
    const adapter: Harness = {
      id: 'claude_code',
      capabilities: () => ({
        supportsResume: true,
        supportsMcp: true,
        supportsPlanMode: true,
        rawTerminalFallback: false,
      }),
      detect: async () => ({ installed: true, authenticated: true }),
      startTurn: async () => ({ sessionId: 'held-session', interrupt }),
    };
    const h = await makeHarness(db, adapter);
    const collected = collectSink();
    await h.supervisor.startTurn(h.workspace.id, baseOpts, collected.sink);

    await Promise.all([
      h.supervisor.interrupt(h.workspace.id),
      h.supervisor.interrupt(h.workspace.id),
    ]);
    await h.supervisor.quitAll();

    expect(interrupt).toHaveBeenCalledOnce();
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
