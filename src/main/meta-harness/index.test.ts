import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import type {
  AgentDispatchSummary,
  MetaRunStatus,
  MetaRunSummary,
  NormalizedAgentSnapshot,
} from '@shared/agents';
import type { AgentEvent, StartTurnOpts } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import type { Workspace } from '@shared/models';
import { buildArgs as buildClaudeArgs } from '../harness/claude-code';
import { buildArgs as buildCodexArgs } from '../harness/codex';
import type { MetaHarnessServiceDeps } from './index';
import { MetaHarnessService } from './index';

const snapshot: NormalizedAgentSnapshot = {
  schemaVersion: 1,
  slug: 'orchestrator',
  name: 'Orchestrator',
  description: 'Test agent',
  revision: 'revision-1',
  prompt: 'Coordinate safely.',
  coordinator: { harness: 'claude_code', model: 'sonnet', mode: 'plan' },
  roles: [
    {
      slug: 'coder',
      name: 'Coder',
      prompt: 'Implement.',
      executor: { harness: 'claude_code', mode: 'default' },
      purposes: ['implement'],
    },
    {
      slug: 'reviewer',
      name: 'Reviewer',
      prompt: 'Review.',
      executor: { harness: 'codex', mode: 'default', readOnlyMode: true },
      purposes: ['review', 'verify'],
      independentProvider: true,
    },
  ],
  skills: [{ slug: 'workflow', content: 'Use bounded delegation.' }],
  capabilities: [
    'delegate',
    'continue_dispatch',
    'await_dispatches',
    'cancel_dispatch',
  ],
  requiredProviders: ['claude_code', 'codex'],
  policy: {
    maxDispatches: 3,
    maxParallel: 2,
    maxDepth: 1,
    turnTimeoutMs: 10_000,
    runTimeoutMs: 60_000,
    maxRequestBytes: 1_024,
    maxResultBytes: 1_024,
    critiqueRounds: 0,
  },
};
const workflowDigest = createHash('sha256')
  .update('Use bounded delegation.')
  .digest('hex');

function workspace(id: string, branch: string): Workspace {
  return {
    id,
    projectId: 'project-1',
    name: id,
    branch,
    baseBranch: 'main',
    worktreePath: `/tmp/${id}`,
    status: 'idle',
    sourceKind: 'branch',
    sourceRef: branch,
    harness: 'claude_code',
    port: null,
    createdAt: 1,
    archivedAt: null,
    prNumber: null,
  };
}

let service: MetaHarnessService;
let deps: MetaHarnessServiceDeps;
let runs: Map<string, MetaRunSummary>;
let dispatches: Map<string, AgentDispatchSummary>;
let workspaces: Map<string, Workspace>;
let turnSinks: StreamSink<AgentEvent>[];
let createCount: number;
let activeWorkspaces: Set<string>;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  runs = new Map();
  dispatches = new Map();
  workspaces = new Map([['source', workspace('source', 'main')]]);
  turnSinks = [];
  createCount = 0;
  activeWorkspaces = new Set();

  const runRepo = {
    create: vi.fn(
      async (input: {
        projectId: string;
        sourceWorkspaceId: string;
        agentId: string;
        snapshot: NormalizedAgentSnapshot;
        goal: string;
        allowPush: boolean;
        allowOpenPr: boolean;
      }) => {
        const run: MetaRunSummary = {
          id: `run-${runs.size + 1}`,
          projectId: input.projectId,
          sourceWorkspaceId: input.sourceWorkspaceId,
          coordinatorWorkspaceId: null,
          agentId: input.agentId,
          agentName: input.snapshot.name,
          agentRevision: input.snapshot.revision,
          goal: input.goal,
          status: 'starting',
          allowPush: input.allowPush,
          allowOpenPr: input.allowOpenPr,
          finalSummary: null,
          error: null,
          createdAt: 1,
          startedAt: null,
          endedAt: null,
        };
        runs.set(run.id, run);
        return run;
      },
    ),
    get: vi.fn(async (id: string) => runs.get(id)!),
    list: vi.fn(async (projectId: string) =>
      [...runs.values()].filter((run) => run.projectId === projectId),
    ),
    snapshot: vi.fn(async () => snapshot),
    setCoordinator: vi.fn(async (id: string, workspaceId: string) => {
      runs.set(id, {
        ...runs.get(id)!,
        coordinatorWorkspaceId: workspaceId,
        status: 'running',
      });
    }),
    transition: vi.fn(
      async (
        id: string,
        status: MetaRunStatus,
        extra: {
          summary?: string;
          error?: string;
          skillUsage?: MetaRunSummary['coordinatorSkillUsage'];
        } = {},
      ) => {
        const current = runs.get(id)!;
        if (
          [
            'completed',
            'failed',
            'cancelled',
            'interrupted',
            'taken_over',
          ].includes(current.status)
        )
          return current;
        const next = {
          ...current,
          status,
          finalSummary: extra.summary ?? current.finalSummary,
          error: extra.error ?? current.error,
          coordinatorSkillUsage:
            extra.skillUsage ?? current.coordinatorSkillUsage,
          endedAt: 2,
        };
        runs.set(id, next);
        return next;
      },
    ),
    interruptStale: vi.fn(async () => []),
  };
  const dispatchRepo = {
    list: vi.fn(async (runId: string) =>
      [...dispatches.values()].filter((item) => item.runId === runId),
    ),
    get: vi.fn(async (id: string) => dispatches.get(id)!),
    create: vi.fn(
      async (input: {
        runId: string;
        role: string;
        purpose: AgentDispatchSummary['purpose'];
        childAgentSlug: string;
        harness: AgentDispatchSummary['harness'];
        model?: string;
        debateStage?: 'partner' | 'critique';
        debateRound?: number;
      }) => {
        const item: AgentDispatchSummary = {
          id: `dispatch-${dispatches.size + 1}`,
          runId: input.runId,
          parentDispatchId: null,
          role: input.role,
          purpose: input.purpose,
          childAgentSlug: input.childAgentSlug,
          workspaceId: null,
          branch: null,
          turnId: null,
          sessionId: null,
          harness: input.harness,
          model: input.model ?? null,
          status: 'pending',
          summary: null,
          changedFiles: [],
          diffStat: null,
          error: null,
          startedAt: null,
          endedAt: null,
          ...(input.debateStage ? { debateStage: input.debateStage } : {}),
          ...(input.debateRound !== undefined
            ? { debateRound: input.debateRound }
            : {}),
        };
        dispatches.set(item.id, item);
        return item;
      },
    ),
    claim: vi.fn(
      async (
        id: string,
        child: Workspace,
        turn: { id?: string; sessionId: string },
      ) => {
        const next = {
          ...dispatches.get(id)!,
          workspaceId: child.id,
          branch: child.branch,
          turnId: turn.id ?? null,
          sessionId: turn.sessionId,
          status: 'running' as const,
        };
        dispatches.set(id, next);
        return next;
      },
    ),
    attachTurn: vi.fn(
      async (id: string, turn: { id?: string; sessionId: string }) => {
        const next = {
          ...dispatches.get(id)!,
          turnId: turn.id ?? null,
          sessionId: turn.sessionId,
        };
        dispatches.set(id, next);
        return next;
      },
    ),
    resume: vi.fn(
      async (id: string, turn: { id?: string; sessionId: string }) => {
        const next = {
          ...dispatches.get(id)!,
          turnId: turn.id ?? null,
          sessionId: turn.sessionId,
          status: 'running' as const,
        };
        dispatches.set(id, next);
        return next;
      },
    ),
    finish: vi.fn(
      async (
        id: string,
        status: AgentDispatchSummary['status'],
        result: {
          summary?: string;
          error?: string;
          changedFiles?: string[];
          diffStat?: string;
          skillUsage?: AgentDispatchSummary['skillUsage'];
        } = {},
      ) => {
        const current = dispatches.get(id)!;
        if (
          ['completed', 'failed', 'cancelled', 'timed_out'].includes(
            current.status,
          )
        )
          return current;
        const next = {
          ...current,
          status,
          summary: result.summary ?? null,
          error: result.error ?? null,
          changedFiles: result.changedFiles ?? [],
          diffStat: result.diffStat ?? null,
          skillUsage: result.skillUsage,
        };
        dispatches.set(id, next);
        return next;
      },
    ),
    interruptStale: vi.fn(async (runIds: string[]) => {
      const interrupted: AgentDispatchSummary[] = [];
      for (const [id, current] of dispatches) {
        if (
          runIds.includes(current.runId) &&
          (current.status === 'pending' || current.status === 'running')
        ) {
          const next: AgentDispatchSummary = {
            ...current,
            status: 'cancelled',
            error: 'application exited while the dispatch was active',
            endedAt: 2,
          };
          dispatches.set(id, next);
          interrupted.push(next);
        }
      }
      return interrupted;
    }),
  };
  const create = vi.fn(
    async (
      request: {
        projectId: string;
        name: string;
        baseBranch: string;
        harness: Workspace['harness'];
      },
      _one?: unknown,
      _two?: unknown,
      onCreated?: (created: Workspace) => void,
    ) => {
      createCount += 1;
      const created = workspace(
        createCount === 1 ? 'coordinator' : `child-${createCount - 1}`,
        `agent/${request.name}`,
      );
      created.harness = request.harness;
      workspaces.set(created.id, created);
      onCreated?.(created);
      return created;
    },
  );
  const startTurn = vi.fn(
    async (
      workspaceId: string,
      _opts: unknown,
      sink: StreamSink<AgentEvent>,
    ) => {
      activeWorkspaces.add(workspaceId);
      turnSinks.push({
        push: (event) => {
          sink.push(event);
          if (event.kind === 'turn_end' || event.kind === 'error')
            activeWorkspaces.delete(workspaceId);
        },
        end: () => sink.end(),
        error: (error) => {
          activeWorkspaces.delete(workspaceId);
          sink.error(error);
        },
      });
      return { sessionId: `session-${turnSinks.length}`, interrupt: vi.fn() };
    },
  );
  deps = {
    registry: {
      resolveSnapshot: vi.fn(async () => snapshot),
    } as unknown as MetaHarnessServiceDeps['registry'],
    runs: runRepo as unknown as MetaHarnessServiceDeps['runs'],
    dispatches: dispatchRepo as unknown as MetaHarnessServiceDeps['dispatches'],
    workspaces: {
      create,
      get: vi.fn(async (id: string) => workspaces.get(id) ?? null),
    } as unknown as MetaHarnessServiceDeps['workspaces'],
    harness: {
      startTurn,
      interrupt: vi.fn(async (workspaceId: string) => {
        activeWorkspaces.delete(workspaceId);
      }),
      isActive: vi.fn((workspaceId: string) =>
        activeWorkspaces.has(workspaceId),
      ),
      getActiveTurnId: vi.fn((id: string) => `turn-${id}`),
      listHarnesses: vi.fn(async () => [
        {
          id: 'claude_code',
          detect: { installed: true, authenticated: true },
          capabilities: {
            supportsResume: true,
            supportsMcp: true,
            supportsPlanMode: true,
            rawTerminalFallback: false,
            supportsReadOnlyMode: true,
            supportsReadOnlyMcp: true,
            supportsScopedWriteMode: true,
          },
        },
        {
          id: 'codex',
          detect: { installed: true, authenticated: true },
          capabilities: {
            supportsResume: true,
            supportsMcp: true,
            supportsPlanMode: false,
            rawTerminalFallback: false,
            supportsReadOnlyMode: true,
            supportsReadOnlyMcp: false,
            supportsScopedWriteMode: true,
          },
        },
      ]),
    } as unknown as MetaHarnessServiceDeps['harness'],
    broker: {
      start: vi.fn(async () => ({
        authFile: '/private/control.json',
        socketPath: '/tmp/c.sock',
      })),
      revoke: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    } as unknown as MetaHarnessServiceDeps['broker'],
    emit: vi.fn(),
    turnPreparation: {
      prepareTurn: vi.fn(async (_workspace, opts) => ({
        ...opts,
        mcpConfig: opts.mcpConfig ?? [],
        permissionPolicy: opts.permissionPolicy ?? {},
      })),
      discard: vi.fn(),
    },
    publisher: {
      pushBranch: vi.fn(async () => undefined),
      openPr: vi.fn(async () => ({})),
    },
    proxyEntry: '/app/mcp-stdio.js',
  };
  service = new MetaHarnessService(deps);
});

async function start() {
  return service.start({
    projectId: 'project-1',
    agentId: 'builtin:orchestrator',
    sourceWorkspaceId: 'source',
    goal: '  Implement safely  ',
  });
}

describe('MetaHarnessService lifecycle', () => {
  it('starts a visible claimed coordinator through the supervisor with scoped MCP config', async () => {
    const run = await start();
    expect(run).toMatchObject({
      status: 'running',
      goal: 'Implement safely',
      coordinatorWorkspaceId: 'coordinator',
    });
    expect(service.isWorkspaceClaimed('coordinator')).toBe(true);
    await expect(
      service.assertWorkspaceAvailable('coordinator'),
    ).rejects.toMatchObject({ code: 'conflict' });
    const [, opts] = vi.mocked(deps.harness.startTurn).mock.calls[0]!;
    expect(opts).toMatchObject({
      mode: 'plan',
      readOnlyMode: true,
      workspaceDir: '/tmp/coordinator',
      mcpConfig: [
        {
          name: 'harness-meta-control',
          command: process.execPath,
          args: ['/app/mcp-stdio.js'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            HARNESS_META_CONTROL_FILE: '/private/control.json',
          },
        },
      ],
    });
    expect(JSON.stringify(opts)).not.toContain('/tmp/c.sock');
    expect(opts.metaSkills).toEqual([
      expect.objectContaining({
        slug: 'workflow',
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(opts.prompt).toContain('Skills consulted:');
    expect(deps.turnPreparation.prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'coordinator' }),
      expect.objectContaining({
        mcpConfig: [expect.objectContaining({ name: 'harness-meta-control' })],
      }),
      'meta-coordinator',
      'claude_code',
    );
  });

  it('persists explicit publish consent and uses only the reviewed publisher after success', async () => {
    deps.diff = {
      getDiff: vi.fn(async () => ({
        baseRef: 'main',
        headRef: 'HEAD',
        patch: '',
        files: [
          {
            path: 'src/change.ts',
            oldPath: null,
            change: 'modified' as const,
            additions: 1,
            deletions: 0,
          },
        ],
      })),
    };
    const run = await service.start({
      projectId: 'project-1',
      agentId: 'builtin:orchestrator',
      sourceWorkspaceId: 'source',
      goal: 'Publish with consent',
      allowPush: true,
      allowOpenPr: true,
    });
    expect(run).toMatchObject({ allowPush: true, allowOpenPr: true });
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    const child = (await service.dispatch(session, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'make a change',
    })) as AgentDispatchSummary;
    turnSinks[1]!.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect(dispatches.get(child.id)?.status).toBe('completed'),
    );
    turnSinks[0]!.push({ kind: 'text', delta: 'Safe summary' });
    turnSinks[0]!.push({ kind: 'turn_end' });

    await vi.waitFor(() =>
      expect(deps.publisher?.openPr).toHaveBeenCalledWith(
        'child-1',
        expect.objectContaining({
          draft: true,
          body: 'Safe summary',
          signal: expect.any(AbortSignal),
        }),
      ),
    );
    expect(deps.publisher?.pushBranch).not.toHaveBeenCalled();
    expect((await service.get('project-1', run.id)).status).toBe('completed');
  });

  it('aborts consented publishing at the total-run deadline before terminalizing', async () => {
    vi.useFakeTimers();
    try {
      deps.diff = {
        getDiff: vi.fn(async () => ({
          baseRef: 'main',
          headRef: 'HEAD',
          patch: '',
          files: [
            {
              path: 'src/change.ts',
              oldPath: null,
              change: 'modified' as const,
              additions: 1,
              deletions: 0,
            },
          ],
        })),
      };
      const publishEntered = deferred<void>();
      const publishAborted = deferred<void>();
      vi.mocked(deps.publisher!.pushBranch).mockImplementation(
        async (_workspaceId, options) => {
          publishEntered.resolve(undefined);
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                publishAborted.resolve(undefined);
                reject(options.signal?.reason);
              },
              { once: true },
            );
          });
        },
      );
      const run = await service.start({
        projectId: 'project-1',
        agentId: 'builtin:orchestrator',
        sourceWorkspaceId: 'source',
        goal: 'Bound publication by the run deadline',
        allowPush: true,
        policy: { runTimeoutMs: 60_000 },
      });
      const session = {
        runId: run.id,
        projectId: run.projectId,
        roles: new Map(),
        policy: snapshot.policy,
      };
      const child = (await service.dispatch(session, {
        role: 'coder',
        purpose: 'implement',
        prompt: 'publish a change',
      })) as AgentDispatchSummary;
      turnSinks[1]!.push({ kind: 'turn_end' });
      await vi.waitFor(() =>
        expect(dispatches.get(child.id)?.status).toBe('completed'),
      );
      turnSinks[0]!.push({ kind: 'turn_end' });
      await publishEntered.promise;

      await vi.advanceTimersByTimeAsync(60_000);
      await publishAborted.promise;

      expect(runs.get(run.id)).toMatchObject({
        status: 'failed',
        error: 'meta run deadline exceeded',
      });
      expect(deps.publisher?.pushBranch).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(deps.publisher!.pushBranch).mock.calls[0]?.[1]?.signal,
      ).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never publishes without consent and keeps push-only consent distinct from draft PR consent', async () => {
    deps.diff = {
      getDiff: vi.fn(async () => ({
        baseRef: 'main',
        headRef: 'HEAD',
        patch: '',
        files: [
          {
            path: 'src/change.ts',
            oldPath: null,
            change: 'modified' as const,
            additions: 1,
            deletions: 0,
          },
        ],
      })),
    };

    await expect(
      service.start({
        projectId: 'project-1',
        agentId: 'builtin:orchestrator',
        sourceWorkspaceId: 'source',
        goal: 'PR consent cannot imply push consent',
        allowOpenPr: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(deps.runs.create).not.toHaveBeenCalled();

    const unconsented = await start();
    const unconsentedSession = {
      runId: unconsented.id,
      projectId: unconsented.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    await service.dispatch(unconsentedSession, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'make an unpublished change',
    });
    turnSinks.at(-1)!.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect([...dispatches.values()].at(-1)?.status).toBe('completed'),
    );
    turnSinks[0]!.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect(runs.get(unconsented.id)?.status).toBe('completed'),
    );
    expect(deps.publisher?.pushBranch).not.toHaveBeenCalled();
    expect(deps.publisher?.openPr).not.toHaveBeenCalled();

    const pushOnly = await service.start({
      projectId: 'project-1',
      agentId: 'builtin:orchestrator',
      sourceWorkspaceId: 'source',
      goal: 'Publish only the branch',
      allowPush: true,
    });
    const pushOnlySession = {
      runId: pushOnly.id,
      projectId: pushOnly.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    const child = (await service.dispatch(pushOnlySession, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'make a pushable change',
    })) as AgentDispatchSummary;
    turnSinks.at(-1)!.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect(dispatches.get(child.id)?.status).toBe('completed'),
    );
    turnSinks.at(-2)!.push({ kind: 'turn_end' });

    await vi.waitFor(() =>
      expect(deps.publisher?.pushBranch).toHaveBeenCalledWith(
        child.workspaceId,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(deps.publisher?.openPr).not.toHaveBeenCalled();
  });

  it('rejects unsafe policy overrides and incapable coordinators before allocation', async () => {
    await expect(
      service.start({
        projectId: 'project-1',
        agentId: 'builtin:orchestrator',
        sourceWorkspaceId: 'source',
        goal: 'x',
        policy: { maxParallel: 4, maxDispatches: 2 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    vi.mocked(deps.harness.listHarnesses).mockResolvedValue([]);
    await expect(start()).rejects.toMatchObject({ code: 'harness' });
    expect(deps.workspaces.create).not.toHaveBeenCalled();
  });

  it('requires the coordinator to enforce read-only MCP, including in default mode', async () => {
    const defaultReadOnly: NormalizedAgentSnapshot = {
      ...snapshot,
      coordinator: {
        harness: 'claude_code',
        mode: 'default',
        readOnlyMode: true,
      },
    };

    const accepted = await service.start(
      {
        projectId: 'project-1',
        agentId: 'builtin:orchestrator',
        sourceWorkspaceId: 'source',
        goal: 'coordinate read-only',
      },
      defaultReadOnly,
    );
    expect(
      vi.mocked(deps.harness.startTurn).mock.calls.at(-1)?.[1],
    ).toMatchObject({ mode: 'default', readOnlyMode: true });
    await service.cancel('project-1', accepted.id);

    const adapters = await deps.harness.listHarnesses();
    vi.mocked(deps.harness.listHarnesses).mockResolvedValue(
      adapters.map((adapter) =>
        adapter.id === 'claude_code'
          ? {
              ...adapter,
              capabilities: {
                ...adapter.capabilities,
                supportsReadOnlyMcp: false,
              },
            }
          : adapter,
      ),
    );
    await expect(
      service.start(
        {
          projectId: 'project-1',
          agentId: 'builtin:orchestrator',
          sourceWorkspaceId: 'source',
          goal: 'must reject unsafe coordinator',
        },
        defaultReadOnly,
      ),
    ).rejects.toMatchObject({ code: 'harness' });
    expect(deps.workspaces.create).toHaveBeenCalledTimes(1);
  });

  it('dispatches isolated children, enforces role/provider budgets, and continues owned sessions', async () => {
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    const child = (await service.dispatch(session, {
      role: 'reviewer',
      purpose: 'review',
      prompt: 'Review branch',
    })) as AgentDispatchSummary;
    expect(child).toMatchObject({
      status: 'running',
      workspaceId: 'child-1',
      harness: 'codex',
    });
    expect(service.isWorkspaceClaimed('child-1')).toBe(true);
    expect(deps.turnPreparation.prepareTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'child-1' }),
      expect.objectContaining({ mcpConfig: [] }),
      'meta-child',
      'codex',
    );
    turnSinks[1]?.push({ kind: 'text', delta: 'first generation' });
    turnSinks[1]?.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect(dispatches.get(child.id)?.status).toBe('completed'),
    );
    await service.continueDispatch(session, {
      dispatchId: child.id,
      prompt: 'Check the fix',
    });
    const lastOpts = vi.mocked(deps.harness.startTurn).mock.calls.at(-1)?.[1];
    expect(lastOpts).toMatchObject({
      sessionId: child.sessionId,
      mode: 'default',
      readOnlyMode: true,
      mcpConfig: [],
    });
    turnSinks[2]?.push({ kind: 'text', delta: 'second generation' });
    turnSinks[2]?.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect(dispatches.get(child.id)).toMatchObject({
        status: 'completed',
        summary: 'second generation',
      }),
    );
    await expect(
      service.dispatch(session, {
        role: 'reviewer',
        purpose: 'review',
        prompt: 'x',
        provider: 'claude_code',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      service.dispatch(session, {
        role: 'reviewer',
        purpose: 'implement',
        prompt: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('forces review and critique child turns through provider-native read-only execution', async () => {
    const authoritySnapshot: NormalizedAgentSnapshot = {
      ...snapshot,
      roles: [
        {
          slug: 'codex-reviewer',
          name: 'Codex reviewer',
          prompt: 'Review without modifying the worktree.',
          executor: {
            harness: 'codex',
            mode: 'default',
            readOnlyMode: true,
          },
          purposes: ['review'],
        },
        {
          slug: 'claude-critic',
          name: 'Claude critic',
          prompt: 'Critique without modifying the worktree.',
          executor: {
            harness: 'claude_code',
            mode: 'default',
            readOnlyMode: true,
          },
          purposes: ['critique'],
        },
      ],
      requiredProviders: ['claude_code', 'codex'],
      policy: { ...snapshot.policy, critiqueRounds: 1 },
    };
    vi.mocked(deps.harness.listHarnesses).mockImplementation(async () => [
      {
        id: 'claude_code',
        detect: { installed: true, authenticated: true },
        capabilities: {
          supportsResume: true,
          supportsMcp: true,
          supportsPlanMode: true,
          rawTerminalFallback: false,
          supportsReadOnlyMode: true,
          supportsReadOnlyMcp: true,
          supportsScopedWriteMode: true,
        },
      },
      {
        id: 'codex',
        detect: { installed: true, authenticated: true },
        capabilities: {
          supportsResume: true,
          supportsMcp: true,
          supportsPlanMode: false,
          rawTerminalFallback: false,
          supportsReadOnlyMode: true,
          supportsReadOnlyMcp: false,
          supportsScopedWriteMode: true,
        },
      },
    ]);
    const run = await service.start(
      {
        projectId: 'project-1',
        agentId: 'custom:authority-test',
        sourceWorkspaceId: 'source',
        goal: 'Review safely',
      },
      authoritySnapshot,
    );
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: authoritySnapshot.policy,
    };

    await service.dispatch(session, {
      role: 'codex-reviewer',
      purpose: 'review',
      prompt: 'Review this branch',
    });
    const codexOpts = vi.mocked(deps.harness.startTurn).mock.calls.at(-1)?.[1];
    expect(codexOpts).toMatchObject({
      mode: 'default',
      readOnlyMode: true,
      scopedWriteMode: false,
    });
    expect(buildCodexArgs(codexOpts as StartTurnOpts)).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );

    await service.dispatch(session, {
      role: 'claude-critic',
      purpose: 'critique',
      prompt: 'Critique the other review',
    });
    const claudeOpts = vi.mocked(deps.harness.startTurn).mock.calls.at(-1)?.[1];
    expect(claudeOpts).toMatchObject({
      mode: 'default',
      readOnlyMode: true,
      scopedWriteMode: false,
    });
    expect(buildClaudeArgs(claudeOpts as StartTurnOpts)).not.toContain(
      '--dangerously-skip-permissions',
    );
  });

  it('runs writable meta children only through provider-scoped workspace modes', async () => {
    const writableSnapshot: NormalizedAgentSnapshot = {
      ...snapshot,
      roles: [
        {
          slug: 'claude-writer',
          name: 'Claude writer',
          prompt: 'Implement in the isolated worktree.',
          executor: { harness: 'claude_code', mode: 'default' },
          purposes: ['implement'],
        },
        {
          slug: 'codex-writer',
          name: 'Codex writer',
          prompt: 'Implement in the isolated worktree.',
          executor: { harness: 'codex', mode: 'default' },
          purposes: ['implement'],
        },
      ],
      requiredProviders: ['claude_code', 'codex'],
    };
    const run = await service.start(
      {
        projectId: 'project-1',
        agentId: 'custom:writable-test',
        sourceWorkspaceId: 'source',
        goal: 'Implement safely',
      },
      writableSnapshot,
    );
    const brokerSession = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: writableSnapshot.policy,
    };

    await service.dispatch(brokerSession, {
      role: 'claude-writer',
      purpose: 'implement',
      prompt: 'Claude implementation',
    });
    const claudeOpts = vi.mocked(deps.harness.startTurn).mock.calls.at(-1)?.[1];
    expect(claudeOpts).toMatchObject({
      metaRunId: run.id,
      scopedWriteMode: true,
    });
    expect(buildClaudeArgs(claudeOpts as StartTurnOpts)).not.toContain(
      '--dangerously-skip-permissions',
    );

    await service.dispatch(brokerSession, {
      role: 'codex-writer',
      purpose: 'implement',
      prompt: 'Codex implementation',
    });
    const codexOpts = vi.mocked(deps.harness.startTurn).mock.calls.at(-1)?.[1];
    expect(codexOpts).toMatchObject({
      metaRunId: run.id,
      scopedWriteMode: true,
    });
    expect(buildCodexArgs(codexOpts as StartTurnOpts)).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('finishes coordinator and child events exactly once and releases claims without deleting workspaces', async () => {
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    await service.dispatch(session, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'Code',
    });
    turnSinks[1]?.push({
      kind: 'text',
      delta: `child result\nSkills consulted: workflow@${workflowDigest}`,
    });
    turnSinks[1]?.push({ kind: 'turn_end' });
    turnSinks[1]?.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect(deps.dispatches.finish).toHaveBeenCalledTimes(1),
    );
    turnSinks[0]?.push({
      kind: 'text',
      delta: `final synthesis\nSkills consulted: workflow@${workflowDigest}`,
    });
    turnSinks[0]?.push({ kind: 'turn_end' });
    turnSinks[0]?.push({ kind: 'turn_end' });
    await vi.waitFor(() => expect(deps.broker.revoke).toHaveBeenCalledTimes(1));
    const detail = await service.get('project-1', run.id);
    expect(detail.finalSummary).toBe('final synthesis');
    expect(detail.coordinatorSkillUsage).toEqual({
      reported: true,
      skills: [{ slug: 'workflow', digest: workflowDigest }],
    });
    expect(detail.dispatches[0]?.summary).toBe('child result');
    expect(detail.dispatches[0]?.skillUsage).toEqual({
      reported: true,
      skills: [{ slug: 'workflow', digest: workflowDigest }],
    });
    expect(service.isWorkspaceClaimed('coordinator')).toBe(false);
    expect(workspaces.has('child-1')).toBe(true);
  });

  it('cancellation and takeover revoke first, interrupt claimed workspaces, and preserve retained work', async () => {
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    await service.dispatch(session, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'Code',
    });
    const cancelled = await service.cancel('project-1', run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(deps.broker.revoke).toHaveBeenCalledWith(run.id);
    expect(deps.harness.interrupt).toHaveBeenCalledTimes(2);
    expect(workspaces.size).toBe(3);
    expect(service.isWorkspaceClaimed('child-1')).toBe(false);
    await expect(service.cancel('other-project', run.id)).rejects.toMatchObject(
      { code: 'not_found' },
    );
  });

  it('returns from cancel_dispatch without re-entering the per-run lock', async () => {
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    const child = (await service.dispatch(session, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'cancel me',
    })) as AgentDispatchSummary;

    await expect(
      service.cancelDispatch(session, { dispatchId: child.id }),
    ).resolves.toMatchObject({ id: child.id, status: 'cancelled' });
    expect(deps.harness.interrupt).toHaveBeenCalledWith('child-1');
  });

  it('takeover revokes orchestration, interrupts active work once, and preserves workspace records', async () => {
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    await service.dispatch(session, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'keep this workspace',
    });

    const takenOver = await service.takeOver('project-1', run.id);
    const lateCancel = await service.cancel('project-1', run.id);

    expect(takenOver.status).toBe('taken_over');
    expect(lateCancel.status).toBe('taken_over');
    expect(deps.broker.revoke).toHaveBeenCalledTimes(1);
    expect(deps.harness.interrupt).toHaveBeenCalledTimes(2);
    expect(workspaces.has('coordinator')).toBe(true);
    expect(workspaces.has('child-1')).toBe(true);
    expect(service.isWorkspaceClaimed('source')).toBe(false);
    expect(service.isWorkspaceClaimed('coordinator')).toBe(false);
    expect(service.isWorkspaceClaimed('child-1')).toBe(false);
  });

  it('shutdown interrupts live runs before shutting down the broker', async () => {
    const run = await start();

    await service.shutdown();

    expect(runs.get(run.id)?.status).toBe('interrupted');
    expect(deps.broker.revoke).toHaveBeenCalledWith(run.id);
    expect(deps.harness.interrupt).toHaveBeenCalledWith('coordinator');
    expect(deps.broker.shutdown).toHaveBeenCalledOnce();
    expect(service.isWorkspaceClaimed('source')).toBe(false);
  });

  it('sanitizes control, workspace, MCP-temp, and credential details before durable failure state', async () => {
    vi.mocked(deps.harness.startTurn).mockRejectedValueOnce(
      new Error(
        'authorization=Bearer-secret at /private/control.json from /tmp/coordinator via /tmp/harness-mcp-secret/mcp.json',
      ),
    );

    let caught: unknown;
    try {
      await start();
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain('Bearer-secret');
    expect(message).not.toContain('/private/control.json');
    expect(message).not.toContain('/tmp/coordinator');
    expect(message).not.toContain('/tmp/harness-mcp-secret');
    const failed = [...runs.values()][0]!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('[redacted]');
    expect(failed.error).toContain('[private path]');
    expect(failed.error).not.toContain('Bearer-secret');
    expect(failed.error).not.toMatch(/\/(?:private|tmp)\//);
  });

  it('redacts secrets and absolute paths from retained coordinator summaries', async () => {
    const run = await start();
    turnSinks[0]!.push({
      kind: 'text',
      delta: 'token=secret-value changed /tmp/private-work/result.ts',
    });
    turnSinks[0]!.push({ kind: 'turn_end' });

    await vi.waitFor(() => expect(runs.get(run.id)?.status).toBe('completed'));
    const summary = runs.get(run.id)?.finalSummary;
    expect(summary).toContain('token=[redacted]');
    expect(summary).toContain('[private path]');
    expect(summary).not.toContain('secret-value');
    expect(summary).not.toContain('/tmp/private-work');
  });

  it('serializes concurrent dispatches so parallel and total budgets cannot be over-allocated', async () => {
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: { ...snapshot.policy, maxDispatches: 1, maxParallel: 1 },
    };

    const outcomes = await Promise.allSettled([
      service.dispatch(session, {
        role: 'coder',
        purpose: 'implement',
        prompt: 'first',
      }),
      service.dispatch(session, {
        role: 'coder',
        purpose: 'implement',
        prompt: 'second',
      }),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    expect(dispatches.size).toBe(1);
    expect(deps.workspaces.create).toHaveBeenCalledTimes(2); // coordinator + one child
  });

  it('enforces Debby partners, unique per-round critics, persisted grouping, then synthesis', async () => {
    const debbySnapshot: NormalizedAgentSnapshot = {
      ...snapshot,
      slug: 'debby',
      name: 'Debby',
      protocol: 'debby',
      roles: [
        {
          slug: 'claude-partner',
          name: 'Claude partner',
          prompt: 'Answer independently.',
          executor: {
            harness: 'claude_code',
            mode: 'plan',
            readOnlyMode: true,
          },
          purposes: ['research'],
        },
        {
          slug: 'codex-partner',
          name: 'Codex partner',
          prompt: 'Answer independently.',
          executor: {
            harness: 'codex',
            mode: 'default',
            readOnlyMode: true,
          },
          purposes: ['research'],
        },
        {
          slug: 'claude-critic',
          name: 'Claude critic',
          prompt: 'Critique the other answer.',
          executor: {
            harness: 'claude_code',
            mode: 'plan',
            readOnlyMode: true,
          },
          purposes: ['critique'],
        },
        {
          slug: 'codex-critic',
          name: 'Codex critic',
          prompt: 'Critique the other answer.',
          executor: {
            harness: 'codex',
            mode: 'default',
            readOnlyMode: true,
          },
          purposes: ['critique'],
        },
      ],
      policy: {
        ...snapshot.policy,
        maxDispatches: 6,
        maxParallel: 2,
        critiqueRounds: 1,
      },
    };
    const run = await service.start(
      {
        projectId: 'project-1',
        agentId: 'builtin:debby',
        sourceWorkspaceId: 'source',
        goal: 'Challenge the proposal',
      },
      debbySnapshot,
    );
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: debbySnapshot.policy,
    };

    await expect(
      service.dispatch(session, {
        role: 'claude-critic',
        purpose: 'critique',
        prompt: 'too early',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const claudePartner = (await service.dispatch(session, {
      role: 'claude-partner',
      purpose: 'research',
      prompt: 'Answer',
    })) as AgentDispatchSummary;
    const codexPartner = (await service.dispatch(session, {
      role: 'codex-partner',
      purpose: 'research',
      prompt: 'Answer',
    })) as AgentDispatchSummary;
    expect([claudePartner, codexPartner]).toEqual([
      expect.objectContaining({ debateStage: 'partner', debateRound: 0 }),
      expect.objectContaining({ debateStage: 'partner', debateRound: 0 }),
    ]);
    turnSinks[1]?.push({ kind: 'turn_end' });
    turnSinks[2]?.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect(dispatches.get(codexPartner.id)?.status).toBe('completed'),
    );

    const claudeCritic = (await service.dispatch(session, {
      role: 'claude-critic',
      purpose: 'critique',
      prompt: 'Critique Codex',
    })) as AgentDispatchSummary;
    await expect(
      service.dispatch(session, {
        role: 'claude-critic',
        purpose: 'critique',
        prompt: 'duplicate critic in the same round',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const codexCritic = (await service.dispatch(session, {
      role: 'codex-critic',
      purpose: 'critique',
      prompt: 'Critique Claude',
    })) as AgentDispatchSummary;
    expect([claudeCritic, codexCritic]).toEqual([
      expect.objectContaining({ debateStage: 'critique', debateRound: 1 }),
      expect.objectContaining({ debateStage: 'critique', debateRound: 1 }),
    ]);
    expect(
      vi.mocked(deps.harness.startTurn).mock.calls.at(-1)?.[1],
    ).toMatchObject({ mode: 'default', readOnlyMode: true });
    turnSinks[3]?.push({ kind: 'turn_end' });
    turnSinks[4]?.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect(dispatches.get(codexCritic.id)?.status).toBe('completed'),
    );

    turnSinks[0]?.push({ kind: 'text', delta: 'Balanced synthesis' });
    turnSinks[0]?.push({ kind: 'turn_end' });
    await vi.waitFor(() =>
      expect(runs.get(run.id)).toMatchObject({
        status: 'completed',
        finalSummary: 'Balanced synthesis',
      }),
    );
  });

  it('marks a dispatch failed and unwinds its claim when provider startup fails', async () => {
    const run = await start();
    vi.mocked(deps.harness.startTurn).mockRejectedValueOnce(
      new Error('provider refused to start'),
    );
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };

    await expect(
      service.dispatch(session, {
        role: 'coder',
        purpose: 'implement',
        prompt: 'fail',
      }),
    ).rejects.toThrow('provider refused to start');

    expect([...dispatches.values()][0]).toMatchObject({
      status: 'failed',
      error: 'provider refused to start',
    });
    expect(service.isWorkspaceClaimed('child-1')).toBe(false);
    expect(workspaces.has('child-1')).toBe(true);
  });

  it('cancels active children if the coordinator ends before they do', async () => {
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    const child = (await service.dispatch(session, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'still running',
    })) as AgentDispatchSummary;

    turnSinks[0]?.push({ kind: 'text', delta: 'coordinator result' });
    turnSinks[0]?.push({ kind: 'turn_end' });

    await vi.waitFor(() =>
      expect(runs.get(run.id)).toMatchObject({ status: 'completed' }),
    );
    expect(dispatches.get(child.id)).toMatchObject({
      status: 'cancelled',
      error: 'coordinator ended before the child completed',
    });
    expect(deps.harness.interrupt).toHaveBeenCalledWith('child-1');
  });

  it('interrupts an active child once when coordinator completion wins before the provider terminal event', async () => {
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    await service.dispatch(session, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'still running after interrupt resolves',
    });
    vi.mocked(deps.harness.interrupt).mockImplementation(async () => {
      // Model a real provider whose interrupt request resolves before the provider
      // emits its terminal event, leaving HarnessSupervisor active meanwhile.
    });

    turnSinks[0]?.push({ kind: 'turn_end' });

    await vi.waitFor(() =>
      expect(runs.get(run.id)).toMatchObject({ status: 'completed' }),
    );
    expect(deps.harness.interrupt).toHaveBeenCalledTimes(1);
    expect(deps.harness.interrupt).toHaveBeenCalledWith('child-1');
  });

  it('interrupts an expired coordinator once when terminalization wins before the provider terminal event', async () => {
    vi.useFakeTimers();
    try {
      const run = await service.start({
        projectId: 'project-1',
        agentId: 'builtin:orchestrator',
        sourceWorkspaceId: 'source',
        goal: 'coordinator deadline race',
        policy: { turnTimeoutMs: 10_000, runTimeoutMs: 60_000 },
      });
      vi.mocked(deps.harness.interrupt).mockImplementation(async () => {
        // The provider has accepted the signal but has not emitted turn_end yet.
      });

      await vi.advanceTimersByTimeAsync(10_000);

      expect(runs.get(run.id)).toMatchObject({
        status: 'failed',
        error: 'coordinator turn deadline exceeded',
      });
      expect(deps.harness.interrupt).toHaveBeenCalledTimes(1);
      expect(deps.harness.interrupt).toHaveBeenCalledWith('coordinator');
    } finally {
      vi.useRealTimers();
    }
  });

  it('arbitrates cancel versus terminal events and repeated stops exactly once', async () => {
    const run = await start();
    const cancel = service.cancel('project-1', run.id);
    turnSinks[0]?.push({ kind: 'turn_end' });
    await cancel;
    await service.cancel('project-1', run.id);

    expect(runs.get(run.id)?.status).toBe('cancelled');
    expect(deps.broker.revoke).toHaveBeenCalledTimes(1);
    expect(deps.runs.transition).toHaveBeenCalledTimes(1);
  });

  it('enforces dispatch-turn and total-run deadlines in main', async () => {
    vi.useFakeTimers();
    try {
      const run = await start();
      const session = {
        runId: run.id,
        projectId: run.projectId,
        roles: new Map(),
        policy: { ...snapshot.policy, turnTimeoutMs: 1_000 },
      };
      const child = (await service.dispatch(session, {
        role: 'coder',
        purpose: 'implement',
        prompt: 'hang',
      })) as AgentDispatchSummary;

      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatches.get(child.id)).toMatchObject({
        status: 'timed_out',
        error: 'dispatch turn deadline exceeded',
      });
      await service.cancel('project-1', run.id);

      const total = await service.start({
        projectId: 'project-1',
        agentId: 'builtin:orchestrator',
        sourceWorkspaceId: 'source',
        goal: 'time-bound run',
        policy: { turnTimeoutMs: 120_000, runTimeoutMs: 60_000 },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs.get(total.id)).toMatchObject({
        status: 'failed',
        error: 'meta run deadline exceeded',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires while coordinator workspace creation is pending and never starts late control', async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const created = deferred<Workspace>();
      vi.mocked(deps.workspaces.create).mockImplementationOnce(
        async (_request, _one, _two, onCreated) => {
          entered.resolve(undefined);
          const workspace = await created.promise;
          onCreated?.(workspace);
          workspaces.set(workspace.id, workspace);
          return workspace;
        },
      );

      const pending = service.start({
        projectId: 'project-1',
        agentId: 'builtin:orchestrator',
        sourceWorkspaceId: 'source',
        goal: 'bounded even while allocating',
        policy: { runTimeoutMs: 60_000 },
      });
      await entered.promise;
      const run = [...runs.values()][0]!;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs.get(run.id)).toMatchObject({
        status: 'failed',
        error: 'meta run deadline exceeded',
      });
      expect(deps.broker.start).not.toHaveBeenCalled();
      expect(deps.harness.startTurn).not.toHaveBeenCalled();

      created.resolve(workspace('late-coordinator', 'agent/late'));
      await expect(pending).rejects.toMatchObject({ code: 'conflict' });
      expect(deps.broker.start).not.toHaveBeenCalled();
      expect(deps.harness.startTurn).not.toHaveBeenCalled();
      expect(service.isWorkspaceClaimed('late-coordinator')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires a pending coordinator provider start and interrupts its late live turn', async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const provider = deferred<{
        sessionId: string;
        interrupt: () => Promise<void>;
      }>();
      vi.mocked(deps.harness.startTurn).mockImplementationOnce(
        async (workspaceId) => {
          activeWorkspaces.add(workspaceId);
          entered.resolve(undefined);
          return provider.promise;
        },
      );

      const pending = service.start({
        projectId: 'project-1',
        agentId: 'builtin:orchestrator',
        sourceWorkspaceId: 'source',
        goal: 'bounded coordinator provider',
        policy: { turnTimeoutMs: 10_000, runTimeoutMs: 60_000 },
      });
      await entered.promise;
      const run = [...runs.values()][0]!;

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.runAllTicks();
      expect(deps.harness.interrupt).toHaveBeenCalledWith('coordinator');
      expect(runs.get(run.id)).toMatchObject({
        status: 'failed',
        error: 'coordinator turn deadline exceeded',
      });
      expect(deps.broker.revoke).toHaveBeenCalledWith(run.id);

      provider.resolve({ sessionId: 'late-session', interrupt: vi.fn() });
      await expect(pending).rejects.toMatchObject({ code: 'conflict' });
      expect(service.isWorkspaceClaimed('coordinator')).toBe(false);
      expect(activeWorkspaces.has('coordinator')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires a dispatch while provider start holds the run lock and rejects the late process', async () => {
    vi.useFakeTimers();
    try {
      const run = await start();
      const session = {
        runId: run.id,
        projectId: run.projectId,
        roles: new Map(),
        policy: snapshot.policy,
      };
      const entered = deferred<void>();
      const provider = deferred<{
        sessionId: string;
        interrupt: () => Promise<void>;
      }>();
      vi.mocked(deps.harness.startTurn).mockImplementationOnce(
        async (workspaceId) => {
          activeWorkspaces.add(workspaceId);
          entered.resolve(undefined);
          return provider.promise;
        },
      );

      const pending = service.dispatch(session, {
        role: 'coder',
        purpose: 'implement',
        prompt: 'provider never resolves in time',
      });
      await entered.promise;
      const dispatch = [...dispatches.values()][0]!;

      await vi.advanceTimersByTimeAsync(snapshot.policy.turnTimeoutMs);
      expect(dispatches.get(dispatch.id)).toMatchObject({
        status: 'timed_out',
        error: 'dispatch turn deadline exceeded',
      });
      expect(deps.harness.interrupt).toHaveBeenCalledWith('child-1');

      provider.resolve({ sessionId: 'late-child-session', interrupt: vi.fn() });
      await expect(pending).rejects.toMatchObject({ code: 'conflict' });
      expect(dispatches.get(dispatch.id)?.status).toBe('timed_out');
      expect(service.isWorkspaceClaimed('child-1')).toBe(false);
      expect(activeWorkspaces.has('child-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('collects bounded changed-file and diff-stat metadata at child completion', async () => {
    deps.diff = {
      getDiff: vi.fn(async () => ({
        files: [
          { path: 'src/a.ts', additions: 3, deletions: 1 },
          { path: 'src/b.ts', additions: 2, deletions: 4 },
        ],
      })),
    } as unknown as MetaHarnessServiceDeps['diff'];
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    const child = (await service.dispatch(session, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'edit',
    })) as AgentDispatchSummary;
    turnSinks[1]?.push({ kind: 'turn_end' });

    await vi.waitFor(() =>
      expect(dispatches.get(child.id)).toMatchObject({
        changedFiles: ['src/a.ts', 'src/b.ts'],
        diffStat: '2 files changed, +5 -5',
      }),
    );
  });

  it('recovers a crashed run by terminalizing durable dispatches and revoking control', async () => {
    const run = await start();
    const session = {
      runId: run.id,
      projectId: run.projectId,
      roles: new Map(),
      policy: snapshot.policy,
    };
    const child = (await service.dispatch(session, {
      role: 'coder',
      purpose: 'implement',
      prompt: 'active at crash',
    })) as AgentDispatchSummary;
    const interrupted: MetaRunSummary = {
      ...runs.get(run.id)!,
      status: 'interrupted',
      error: 'application exited while the meta run was active',
      endedAt: 2,
    };
    runs.set(run.id, interrupted);
    vi.mocked(deps.runs.interruptStale).mockResolvedValueOnce([interrupted]);

    await expect(service.recover()).resolves.toEqual([interrupted]);

    expect(deps.dispatches.interruptStale).toHaveBeenCalledWith([run.id]);
    expect(dispatches.get(child.id)).toMatchObject({
      status: 'cancelled',
      error: 'application exited while the dispatch was active',
    });
    expect(deps.broker.revoke).toHaveBeenCalledWith(run.id);
    expect(service.isWorkspaceClaimed('coordinator')).toBe(false);
    expect(service.isWorkspaceClaimed('child-1')).toBe(false);
    expect(workspaces.has('child-1')).toBe(true);
  });
});
