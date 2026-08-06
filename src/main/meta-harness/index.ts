import { join } from 'node:path';
import { AppError } from '@shared/errors';
import type {
  AgentEvent,
  HarnessId,
  McpServerConfig,
  StartTurnOpts,
} from '@shared/harness';
import type { EventChannel, EventPayload, StreamSink } from '@shared/ipc';
import type {
  AgentDispatchPurpose,
  AgentDispatchSummary,
  AgentRoleSnapshot,
  AgentRunPolicy,
  AdapterCoordinatorCapability,
  MetaRunDetail,
  MetaRunSummary,
  NormalizedAgentSnapshot,
  StartMetaRunRequest,
} from '@shared/agents';
import type { Workspace } from '@shared/models';
import type { AgentRegistry } from '../agents/registry';
import type { AgentRunsRepo } from '../db/repos/agentRuns';
import type { AgentDispatchesRepo } from '../db/repos/agentDispatches';
import type { HarnessSupervisor } from '../harness/supervisor';
import type { WorkspaceManager } from '../workspace';
import type { DiffService } from '../diff';
import {
  sanitizeErrorMessage,
  sanitizeSensitiveText,
} from '../security/sanitize-error';
import {
  ControlBroker,
  type BrokerSessionPolicy,
  type ControlBrokerHandler,
} from './control-broker';

type Supervisor = Pick<
  HarnessSupervisor,
  'startTurn' | 'interrupt' | 'isActive' | 'getActiveTurnId' | 'listHarnesses'
>;

export interface MetaHarnessServiceDeps {
  registry: AgentRegistry;
  runs: AgentRunsRepo;
  dispatches: AgentDispatchesRepo;
  workspaces: Pick<WorkspaceManager, 'create' | 'get'>;
  harness: Supervisor;
  broker: ControlBroker;
  emit: <K extends EventChannel>(event: K, payload: EventPayload<K>) => void;
  settings: () => { permissionPolicy: StartTurnOpts['permissionPolicy'] };
  diff?: Pick<DiffService, 'getDiff'>;
  proxyEntry?: string;
  /** Reviewed branch-only publish/PR workflow, used only with persisted run consent. */
  publisher?: {
    pushBranch(
      workspaceId: string,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
    openPr(
      workspaceId: string,
      options?: { draft?: boolean; body?: string; signal?: AbortSignal },
    ): Promise<unknown>;
  };
}

interface DispatchParams {
  role: string;
  purpose: AgentDispatchPurpose;
  prompt: string;
  provider?: HarnessId;
  model?: string;
}
interface ContinueParams {
  dispatchId: string;
  prompt: string;
}
interface AwaitParams {
  dispatchIds: string[];
  timeoutMs?: number;
}
interface CancelParams {
  dispatchId: string;
}
const TERMINAL_DISPATCH = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);
const ACTIVE_DISPATCH = new Set(['pending', 'running']);
const TERMINAL_RUN = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'taken_over',
]);

interface CoordinatorTerminal {
  status: 'completed' | 'failed';
  summary: string;
  error?: string;
}

export class MetaHarnessService implements ControlBrokerHandler {
  private readonly claims = new Map<
    string,
    { runId: string; kind: 'source' | 'coordinator' | 'child' }
  >();
  private readonly snapshots = new Map<string, NormalizedAgentSnapshot>();
  private readonly coordinatorProviders = new Map<string, HarnessId>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runLocks = new Map<string, Promise<void>>();
  private readonly terminalRunIds = new Set<string>();
  private readonly terminalizingRunIds = new Set<string>();
  private readonly startingRunIds = new Set<string>();
  private readonly workspaceInterrupts = new Map<string, Promise<void>>();
  private readonly runAbortControllers = new Map<string, AbortController>();
  private readonly runProjectIds = new Map<string, string>();
  private readonly coordinatorTerminals = new Map<
    string,
    CoordinatorTerminal
  >();
  private readonly claimReleaseListeners = new Set<
    (workspaceIds: string[]) => void
  >();
  private readonly terminalListeners = new Map<
    string,
    Set<(run: MetaRunSummary) => void>
  >();

  constructor(private readonly deps: MetaHarnessServiceDeps) {}

  async start(
    request: StartMetaRunRequest,
    snapshotOverride?: NormalizedAgentSnapshot,
  ): Promise<MetaRunDetail> {
    if (!request.goal || request.goal.trim().length > 65_536)
      throw new AppError(
        'invalid_input',
        'goal is required and must be at most 65536 characters',
      );
    if (request.allowOpenPr === true && request.allowPush !== true)
      throw new AppError(
        'invalid_input',
        'opening pull requests also requires push consent',
      );
    if ((request.allowPush || request.allowOpenPr) && !this.deps.publisher)
      throw new AppError('harness', 'reviewed publish workflow is unavailable');
    const source = await this.deps.workspaces.get(request.sourceWorkspaceId);
    if (
      !source ||
      source.projectId !== request.projectId ||
      !source.worktreePath
    )
      throw new AppError('not_found', 'source workspace not found');
    await this.assertWorkspaceAvailable(source.id);
    const snapshot =
      snapshotOverride ??
      (await this.deps.registry.resolveSnapshot(
        request.projectId,
        request.agentId,
      ));
    const policy = this.boundedPolicy(snapshot.policy, request.policy);
    this.assertDebbyConfiguration(snapshot, policy);
    const adapters = await this.deps.harness.listHarnesses();
    const coordinator = adapters.find(
      (item) => item.id === snapshot.coordinator.harness,
    );
    const coordinatorCapability: AdapterCoordinatorCapability = {
      mcpControl: coordinator?.capabilities.supportsMcp === true,
      readOnlyMode:
        (snapshot.coordinator.readOnlyMode === true ||
          snapshot.coordinator.mode === 'plan') &&
        (coordinator?.capabilities.supportsReadOnlyMode ??
          coordinator?.capabilities.supportsPlanMode) === true &&
        (coordinator?.capabilities.supportsReadOnlyMcp ??
          (coordinator?.capabilities.supportsMcp === true &&
            coordinator.capabilities.supportsPlanMode === true)) === true,
    };
    if (
      !coordinator?.detect.installed ||
      !coordinator.detect.authenticated ||
      !coordinatorCapability.mcpControl ||
      !coordinatorCapability.readOnlyMode
    ) {
      throw new AppError(
        'harness',
        'coordinator provider must be installed/authenticated and support MCP control plus read-only mode',
      );
    }
    const run = await this.deps.runs.create({
      projectId: request.projectId,
      sourceWorkspaceId: source.id,
      agentId: request.agentId,
      snapshot: { ...snapshot, policy },
      goal: request.goal.trim(),
      allowPush: request.allowPush === true,
      allowOpenPr: request.allowOpenPr === true,
    });
    this.terminalRunIds.delete(run.id);
    this.startingRunIds.add(run.id);
    this.snapshots.set(run.id, { ...snapshot, policy });
    this.coordinatorProviders.set(run.id, snapshot.coordinator.harness);
    this.runAbortControllers.set(run.id, new AbortController());
    this.runProjectIds.set(run.id, run.projectId);
    this.armDeadline(`run:${run.id}`, policy.runTimeoutMs, () =>
      this.expireRun(run.id),
    );
    try {
      this.claim(source.id, run.id, 'source');
      const workspace = await this.deps.workspaces.create(
        {
          projectId: request.projectId,
          // UUIDv7's leading bytes are timestamp-heavy and collide under rapid runs.
          // Use the random tail for retained worktree/branch identity.
          name: `${snapshot.slug}-${run.id.slice(-8)}`,
          baseBranch: source.branch,
          harness: snapshot.coordinator.harness,
          sourceKind: 'branch',
          sourceRef: source.branch,
        },
        undefined,
        undefined,
        (created) => this.claim(created.id, run.id, 'coordinator'),
      );
      await this.deps.runs.setCoordinator(run.id, workspace.id);
      const roles = new Map(
        snapshot.roles.map((role) => [
          role.slug,
          {
            providers: [role.executor.harness],
            purposes: role.purposes,
            independentProvider: role.independentProvider,
          },
        ]),
      );
      const control = await this.deps.broker.start({
        runId: run.id,
        projectId: run.projectId,
        roles,
        policy,
      });
      const mcp = this.controlMcp(control.authFile);
      const opts: StartTurnOpts = {
        workspaceDir: workspace.worktreePath!,
        prompt: this.coordinatorPrompt(snapshot, request.goal.trim()),
        attachments: [],
        mode: snapshot.coordinator.mode,
        mcpConfig: [mcp],
        permissionPolicy: this.deps.settings().permissionPolicy,
        model: snapshot.coordinator.model,
        readOnlyMode: true,
        metaRunId: run.id,
      };
      this.assertRunActive(await this.deps.runs.get(run.id));
      this.armDeadline(`coordinator:${run.id}`, policy.turnTimeoutMs, () =>
        this.expireCoordinator(run.id, workspace.id),
      );
      const handle = await this.deps.harness.startTurn(
        workspace.id,
        opts,
        this.coordinatorSink(run),
        snapshot.coordinator.harness,
      );
      this.assertRunActive(await this.deps.runs.get(run.id));
      const turnId = this.deps.harness.getActiveTurnId(workspace.id);
      if (turnId)
        this.deps.emit('metaRun:turnStarted', {
          runId: run.id,
          workspaceId: workspace.id,
          turnId,
          sessionId: handle.sessionId,
          role: 'coordinator',
        });
      this.emitRun(await this.deps.runs.get(run.id));
      const detail = await this.get(run.projectId, run.id);
      this.finishRunStartup(run.id);
      return detail;
    } catch (error) {
      const safeMessage = sanitizeErrorMessage(error, 'failed to start run');
      try {
        await this.serializeRun(run.id, () =>
          this.terminalizeRunLocked(run, 'failed', {
            error: safeMessage,
          }),
        );
      } finally {
        this.finishRunStartup(run.id);
      }
      throw new AppError(
        error instanceof AppError ? error.code : 'harness',
        safeMessage,
      );
    }
  }

  async list(projectId: string): Promise<MetaRunSummary[]> {
    return this.deps.runs.list(projectId);
  }
  async get(projectId: string, runId: string): Promise<MetaRunDetail> {
    const run = await this.deps.runs.get(runId);
    if (run.projectId !== projectId)
      throw new AppError('not_found', 'meta run not found');
    return { ...run, dispatches: await this.deps.dispatches.list(runId) };
  }

  async cancel(projectId: string, runId: string): Promise<MetaRunDetail> {
    await this.stopRun(projectId, runId, 'cancelled');
    return this.get(projectId, runId);
  }
  async takeOver(projectId: string, runId: string): Promise<MetaRunDetail> {
    await this.stopRun(projectId, runId, 'taken_over');
    return this.get(projectId, runId);
  }

  async assertWorkspaceAvailable(
    workspaceId: string,
    internalRunId?: string,
  ): Promise<void> {
    const claim = this.claims.get(workspaceId);
    if (claim && claim.runId !== internalRunId)
      throw new AppError(
        'conflict',
        'workspace is claimed by an active meta run',
        { workspaceId },
      );
  }

  authorizeWorkspaceStart(workspaceId: string, internalRunId?: string): void {
    const claim = this.claims.get(workspaceId);
    if (
      (claim && claim.runId !== internalRunId) ||
      (!claim && internalRunId !== undefined) ||
      (internalRunId !== undefined && this.terminalRunIds.has(internalRunId))
    )
      throw new AppError(
        'conflict',
        'workspace is claimed by an active meta run',
        { workspaceId },
      );
  }

  isWorkspaceClaimed(workspaceId: string): boolean {
    return this.claims.has(workspaceId);
  }

  async onTerminal(
    runId: string,
    listener: (run: MetaRunSummary) => void,
  ): Promise<() => void> {
    let called = false;
    const once = (run: MetaRunSummary): void => {
      if (called) return;
      called = true;
      try {
        listener(run);
      } catch {
        // Observer failures cannot change the durable terminal winner.
      }
    };
    const listeners = this.terminalListeners.get(runId) ?? new Set();
    listeners.add(once);
    this.terminalListeners.set(runId, listeners);
    // Register before inspecting durable state: a transition either observes the
    // listener, or this read observes the terminal winner. The once wrapper closes
    // the overlap where both happen.
    const current = await this.deps.runs.get(runId);
    if (TERMINAL_RUN.has(current.status)) {
      listeners.delete(once);
      once(current);
    }
    return () => {
      listeners.delete(once);
      if (listeners.size === 0) this.terminalListeners.delete(runId);
    };
  }

  onClaimsReleased(listener: (workspaceIds: string[]) => void): () => void {
    this.claimReleaseListeners.add(listener);
    return () => this.claimReleaseListeners.delete(listener);
  }

  async recover(): Promise<MetaRunSummary[]> {
    const interrupted = await this.deps.runs.interruptStale();
    await this.deps.dispatches.interruptStale(interrupted.map((run) => run.id));
    for (const run of interrupted) {
      await this.deps.broker.revoke(run.id);
      this.releaseRunClaims(run.id);
      this.clearRunState(run.id);
      this.emitRun(run);
      this.notifyTerminal(run);
    }
    return interrupted;
  }

  async shutdown(): Promise<void> {
    const runIds = new Set(
      [...this.claims.values()].map((claim) => claim.runId),
    );
    await Promise.allSettled(
      [...runIds].map(async (runId) => {
        const run = await this.deps.runs.get(runId);
        await this.stopRun(run.projectId, runId, 'interrupted');
      }),
    );
    await this.deps.broker.shutdown();
  }

  async dispatch(session: BrokerSessionPolicy, raw: unknown): Promise<unknown> {
    return this.serializeRun(session.runId, () =>
      this.dispatchLocked(session, raw),
    );
  }

  private async dispatchLocked(
    session: BrokerSessionPolicy,
    raw: unknown,
  ): Promise<unknown> {
    const params = this.dispatchParams(raw);
    const snapshot = await this.snapshot(session.runId);
    const role = snapshot.roles.find((item) => item.slug === params.role);
    if (!role || !role.purposes.includes(params.purpose))
      throw new AppError('invalid_input', 'role or purpose is not allowed');
    const existing = await this.deps.dispatches.list(session.runId);
    if (existing.length >= session.policy.maxDispatches)
      throw new AppError('conflict', 'dispatch budget exhausted');
    if (
      existing.filter((item) => ACTIVE_DISPATCH.has(item.status)).length >=
      session.policy.maxParallel
    )
      throw new AppError('conflict', 'parallel dispatch budget exhausted');
    const provider = params.provider ?? role.executor.harness;
    if (provider !== role.executor.harness)
      throw new AppError(
        'invalid_input',
        'provider is not allowed for this role',
      );
    if (params.model !== undefined && params.model !== role.executor.model)
      throw new AppError(
        'invalid_input',
        'model override is not allowed for this role',
      );
    await this.assertExecutorReady(provider, role.executor);
    if (params.purpose === 'critique') {
      const critiqueRoles = snapshot.roles.filter((item) =>
        item.purposes.includes('critique'),
      ).length;
      const critiqueBudget = session.policy.critiqueRounds * critiqueRoles;
      const used = existing.filter(
        (item) => item.purpose === 'critique',
      ).length;
      if (critiqueBudget === 0 || used >= critiqueBudget)
        throw new AppError('conflict', 'critique round budget exhausted');
    }
    if (
      role.independentProvider &&
      provider === this.coordinatorProviders.get(session.runId)
    )
      throw new AppError(
        'conflict',
        'review role requires an independent provider',
      );
    const run = await this.deps.runs.get(session.runId);
    if (run.status !== 'running')
      throw new AppError('conflict', 'meta run is no longer active');
    const source = await this.deps.workspaces.get(run.coordinatorWorkspaceId!);
    if (!source)
      throw new AppError('not_found', 'coordinator workspace not found');
    const debate = this.debateDispatchMetadata(
      snapshot,
      role,
      params.purpose,
      existing,
      session.policy,
    );
    const dispatch = await this.deps.dispatches.create({
      runId: run.id,
      role: role.slug,
      purpose: params.purpose,
      childAgentSlug: role.slug,
      harness: provider,
      model: params.model ?? role.executor.model,
      ...debate,
    });
    let workspace: Workspace | undefined;
    try {
      workspace = await this.deps.workspaces.create(
        {
          projectId: run.projectId,
          name: `${role.slug}-${dispatch.id.slice(-8)}`,
          baseBranch: source.branch,
          harness: provider,
          sourceKind: 'branch',
          sourceRef: source.branch,
        },
        undefined,
        undefined,
        (created) => this.claim(created.id, run.id, 'child'),
      );
      this.assertRunActive(await this.deps.runs.get(run.id));
      // Persist ownership before the provider can emit an instantaneous terminal.
      await this.deps.dispatches.claim(dispatch.id, workspace, {});
      const deadlineKey = `dispatch:${dispatch.id}`;
      this.armDeadline(deadlineKey, session.policy.turnTimeoutMs, () =>
        this.expireDispatch(run.id, dispatch.id, workspace!.id),
      );
      const handle = await this.deps.harness.startTurn(
        workspace.id,
        this.childOpts(workspace, role, params.prompt, snapshot, run.id),
        this.dispatchSink(run, dispatch.id, deadlineKey),
        provider,
      );
      const [currentRun, currentDispatch] = await Promise.all([
        this.deps.runs.get(run.id),
        this.deps.dispatches.get(dispatch.id),
      ]);
      if (
        TERMINAL_RUN.has(currentRun.status) ||
        !ACTIVE_DISPATCH.has(currentDispatch.status)
      ) {
        await this.interruptWorkspaceOnce(workspace.id);
        throw new AppError('conflict', 'dispatch expired during startup');
      }
      const turnId = this.deps.harness.getActiveTurnId(workspace.id);
      const claimed = await this.attachDispatchTurn(
        dispatch.id,
        workspace,
        { id: turnId, sessionId: handle.sessionId },
        false,
      );
      if (turnId)
        this.deps.emit('metaRun:turnStarted', {
          runId: run.id,
          dispatchId: dispatch.id,
          workspaceId: workspace.id,
          turnId,
          sessionId: handle.sessionId,
          role: role.slug,
        });
      this.emitRun(run);
      return claimed;
    } catch (error) {
      this.clearDeadline(`dispatch:${dispatch.id}`);
      await this.deps.dispatches.finish(dispatch.id, 'failed', {
        error: sanitizeErrorMessage(error, 'failed to start dispatch'),
      });
      if (workspace) {
        if (this.deps.harness.isActive(workspace.id))
          await this.interruptWorkspaceOnce(workspace.id).catch(
            () => undefined,
          );
        this.releaseClaim(workspace.id, run.id);
      }
      this.emitRun(await this.deps.runs.get(run.id));
      throw error;
    }
  }

  async continueDispatch(
    session: BrokerSessionPolicy,
    raw: unknown,
  ): Promise<unknown> {
    return this.serializeRun(session.runId, () =>
      this.continueDispatchLocked(session, raw),
    );
  }

  private async continueDispatchLocked(
    session: BrokerSessionPolicy,
    raw: unknown,
  ): Promise<unknown> {
    const params = raw as ContinueParams;
    if (
      !params ||
      typeof params.dispatchId !== 'string' ||
      typeof params.prompt !== 'string' ||
      !params.prompt.trim()
    )
      throw new AppError('invalid_input', 'dispatchId and prompt are required');
    const dispatch = await this.ownedDispatch(session.runId, params.dispatchId);
    if (!dispatch.workspaceId || !dispatch.sessionId)
      throw new AppError('conflict', 'dispatch cannot be continued');
    if (dispatch.status !== 'completed' && dispatch.status !== 'failed')
      throw new AppError(
        'conflict',
        'dispatch must be terminal before it can be continued',
      );
    await this.assertWorkspaceAvailable(dispatch.workspaceId, session.runId);
    const workspace = await this.deps.workspaces.get(dispatch.workspaceId);
    if (!workspace?.worktreePath)
      throw new AppError('not_found', 'child workspace not found');
    const snapshot = await this.snapshot(session.runId);
    if (snapshot.protocol === 'debby')
      throw new AppError(
        'conflict',
        'Debby dispatches are fixed debate stages and cannot be continued',
      );
    const role = snapshot.roles.find((item) => item.slug === dispatch.role);
    if (!role)
      throw new AppError('internal', 'stored dispatch role no longer exists');
    await this.assertExecutorReady(dispatch.harness, role.executor);
    const active = (await this.deps.dispatches.list(session.runId)).filter(
      (item) => item.id !== dispatch.id && ACTIVE_DISPATCH.has(item.status),
    );
    if (active.length >= session.policy.maxParallel)
      throw new AppError('conflict', 'parallel dispatch budget exhausted');
    await this.deps.dispatches.resume(dispatch.id, {
      sessionId: dispatch.sessionId,
    });
    const run = await this.deps.runs.get(session.runId);
    const deadlineKey = `dispatch:${dispatch.id}`;
    this.armDeadline(deadlineKey, session.policy.turnTimeoutMs, () =>
      this.expireDispatch(run.id, dispatch.id, workspace.id),
    );
    try {
      const handle = await this.deps.harness.startTurn(
        workspace.id,
        {
          ...this.childOpts(workspace, role, params.prompt, snapshot, run.id),
          sessionId: dispatch.sessionId,
        },
        this.dispatchSink(run, dispatch.id, deadlineKey),
        dispatch.harness,
      );
      const current = await this.deps.dispatches.get(dispatch.id);
      if (!ACTIVE_DISPATCH.has(current.status)) {
        await this.interruptWorkspaceOnce(workspace.id);
        throw new AppError('conflict', 'dispatch expired during startup');
      }
      const turnId = this.deps.harness.getActiveTurnId(workspace.id);
      const next = await this.attachDispatchTurn(
        dispatch.id,
        workspace,
        { id: turnId, sessionId: handle.sessionId },
        true,
      );
      if (turnId)
        this.deps.emit('metaRun:turnStarted', {
          runId: run.id,
          dispatchId: dispatch.id,
          workspaceId: workspace.id,
          turnId,
          sessionId: handle.sessionId,
          role: role.slug,
        });
      this.emitRun(run);
      return next;
    } catch (error) {
      this.clearDeadline(deadlineKey);
      await this.deps.dispatches.finish(dispatch.id, 'failed', {
        error: sanitizeErrorMessage(error, 'failed to continue dispatch'),
      });
      this.emitRun(run);
      throw error;
    }
  }

  async awaitDispatches(
    session: BrokerSessionPolicy,
    raw: unknown,
  ): Promise<unknown> {
    const params = raw as AwaitParams;
    if (
      !params ||
      !Array.isArray(params.dispatchIds) ||
      params.dispatchIds.length === 0 ||
      params.dispatchIds.length > session.policy.maxDispatches
    )
      throw new AppError('invalid_input', 'dispatchIds are required');
    const deadline =
      Date.now() +
      Math.min(
        params.timeoutMs ?? session.policy.turnTimeoutMs,
        session.policy.turnTimeoutMs,
      );
    while (Date.now() < deadline) {
      const dispatches = await Promise.all(
        params.dispatchIds.map((id) => this.ownedDispatch(session.runId, id)),
      );
      if (dispatches.every((item) => TERMINAL_DISPATCH.has(item.status)))
        return dispatches;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return Promise.all(
      params.dispatchIds.map((id) => this.ownedDispatch(session.runId, id)),
    );
  }

  async cancelDispatch(
    session: BrokerSessionPolicy,
    raw: unknown,
  ): Promise<unknown> {
    return this.serializeRun(session.runId, () =>
      this.cancelDispatchLocked(session, raw),
    );
  }

  private async cancelDispatchLocked(
    session: BrokerSessionPolicy,
    raw: unknown,
  ): Promise<unknown> {
    const params = raw as CancelParams;
    if (!params || typeof params.dispatchId !== 'string')
      throw new AppError('invalid_input', 'dispatchId is required');
    const dispatch = await this.ownedDispatch(session.runId, params.dispatchId);
    const next = await this.deps.dispatches.finish(dispatch.id, 'cancelled');
    this.clearDeadline(`dispatch:${dispatch.id}`);
    if (
      dispatch.workspaceId &&
      this.deps.harness.isActive(dispatch.workspaceId)
    )
      await this.interruptWorkspaceOnce(dispatch.workspaceId);
    this.emitRun(await this.deps.runs.get(session.runId));
    await this.maybeFinishCoordinatorLocked(session.runId);
    return next;
  }

  private dispatchParams(raw: unknown): DispatchParams {
    if (!raw || typeof raw !== 'object')
      throw new AppError('invalid_input', 'dispatch parameters are required');
    const value = raw as Partial<DispatchParams>;
    if (
      typeof value.role !== 'string' ||
      typeof value.prompt !== 'string' ||
      !value.prompt.trim() ||
      typeof value.purpose !== 'string'
    )
      throw new AppError(
        'invalid_input',
        'role, purpose, and prompt are required',
      );
    return value as DispatchParams;
  }
  private boundedPolicy(
    base: AgentRunPolicy,
    override: Partial<AgentRunPolicy> | undefined,
  ): AgentRunPolicy {
    if (override !== undefined && (!override || typeof override !== 'object')) {
      throw new AppError('invalid_input', 'run policy must be an object');
    }
    const value = { ...base, ...(override ?? {}), maxDepth: 1 as const };
    const limits: Record<
      Exclude<keyof AgentRunPolicy, 'maxDepth'>,
      readonly [number, number]
    > = {
      maxDispatches: [1, 32],
      maxParallel: [1, 8],
      turnTimeoutMs: [10_000, 7_200_000],
      runTimeoutMs: [60_000, 28_800_000],
      maxRequestBytes: [1_024, 262_144],
      maxResultBytes: [1_024, 524_288],
      critiqueRounds: [0, 3],
    };
    for (const key of Object.keys(override ?? {})) {
      if (key !== 'maxDepth' && !(key in limits)) {
        throw new AppError(
          'invalid_input',
          `unsupported run policy field: ${key}`,
        );
      }
    }
    for (const [key, [min, max]] of Object.entries(limits) as [
      keyof typeof limits,
      readonly [number, number],
    ][]) {
      const candidate = value[key];
      if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
        throw new AppError(
          'invalid_input',
          `${String(key)} must be an integer from ${min} to ${max}`,
        );
      }
    }
    if (value.maxParallel > value.maxDispatches) {
      throw new AppError(
        'invalid_input',
        'maxParallel cannot exceed maxDispatches',
      );
    }
    return value;
  }
  private async snapshot(runId: string): Promise<NormalizedAgentSnapshot> {
    const cached = this.snapshots.get(runId);
    if (cached) return cached;
    const snapshot = await this.deps.runs.snapshot(runId);
    this.snapshots.set(runId, snapshot);
    return snapshot;
  }
  private async assertExecutorReady(
    harness: HarnessId,
    executor: AgentRoleSnapshot['executor'],
  ): Promise<void> {
    const adapter = (await this.deps.harness.listHarnesses()).find(
      (item) => item.id === harness,
    );
    if (
      !adapter?.detect.installed ||
      !adapter.detect.authenticated ||
      (executor.mode === 'plan' && !adapter.capabilities.supportsPlanMode) ||
      ((executor.readOnlyMode || executor.mode === 'plan') &&
        !(
          adapter.capabilities.supportsReadOnlyMode ??
          adapter.capabilities.supportsPlanMode
        )) ||
      (!(executor.readOnlyMode || executor.mode === 'plan') &&
        adapter.capabilities.supportsScopedWriteMode !== true)
    )
      throw new AppError(
        'harness',
        `${harness} is unavailable or cannot enforce the configured execution mode`,
      );
  }

  private assertRunActive(run: MetaRunSummary): void {
    if (run.status !== 'running')
      throw new AppError('conflict', 'meta run is no longer active');
  }
  private async ownedDispatch(
    runId: string,
    id: string,
  ): Promise<AgentDispatchSummary> {
    const dispatch = await this.deps.dispatches.get(id);
    if (dispatch.runId !== runId)
      throw new AppError('not_found', 'dispatch not found');
    return dispatch;
  }
  private async attachDispatchTurn(
    dispatchId: string,
    workspace: Workspace,
    turn: { id?: string; sessionId: string },
    resuming: boolean,
  ): Promise<AgentDispatchSummary> {
    const repo = this.deps.dispatches as AgentDispatchesRepo & {
      attachTurn?: AgentDispatchesRepo['attachTurn'];
    };
    if (repo.attachTurn) return repo.attachTurn(dispatchId, turn);
    // Compatibility for injected repository fakes; production always uses attachTurn.
    return resuming
      ? this.deps.dispatches.resume(dispatchId, turn)
      : this.deps.dispatches.claim(dispatchId, workspace, turn);
  }
  private interruptWorkspaceOnce(workspaceId: string): Promise<void> {
    const existing = this.workspaceInterrupts.get(workspaceId);
    if (existing) return existing;
    const pending = this.deps.harness.interrupt(workspaceId).catch((error) => {
      if (this.workspaceInterrupts.get(workspaceId) === pending)
        this.workspaceInterrupts.delete(workspaceId);
      throw error;
    });
    this.workspaceInterrupts.set(workspaceId, pending);
    return pending;
  }
  private claim(
    workspaceId: string,
    runId: string,
    kind: 'source' | 'coordinator' | 'child',
  ): void {
    if (this.terminalRunIds.has(runId))
      throw new AppError('conflict', 'meta run is no longer active');
    if (this.deps.harness.isActive(workspaceId))
      throw new AppError(
        'conflict',
        'workspace already has an active or starting turn',
      );
    if (this.claims.has(workspaceId))
      throw new AppError('conflict', 'workspace already claimed');
    this.claims.set(workspaceId, { runId, kind });
  }
  private releaseClaim(workspaceId: string, runId: string): void {
    if (this.claims.get(workspaceId)?.runId !== runId) return;
    this.claims.delete(workspaceId);
    this.workspaceInterrupts.delete(workspaceId);
    for (const listener of this.claimReleaseListeners) {
      try {
        listener([workspaceId]);
      } catch {
        // Claim release is authoritative; observers cannot roll it back.
      }
    }
  }
  private releaseRunClaims(runId: string): string[] {
    const released: string[] = [];
    for (const [workspaceId, claim] of this.claims)
      if (claim.runId === runId) {
        this.claims.delete(workspaceId);
        this.workspaceInterrupts.delete(workspaceId);
        released.push(workspaceId);
      }
    if (released.length)
      for (const listener of this.claimReleaseListeners) {
        try {
          listener(released);
        } catch {
          // Claim release is authoritative; observers cannot roll it back.
        }
      }
    return released;
  }
  private controlMcp(authFile: string): McpServerConfig {
    return {
      name: 'harness-meta-control',
      command: process.execPath,
      args: [this.deps.proxyEntry ?? join(__dirname, 'mcp-stdio.js')],
      env: { ELECTRON_RUN_AS_NODE: '1', HARNESS_META_CONTROL_FILE: authFile },
    };
  }
  private coordinatorPrompt(
    snapshot: NormalizedAgentSnapshot,
    goal: string,
  ): string {
    const roster = snapshot.roles
      .map(
        (role) =>
          `- ${role.slug}: ${role.purposes.join(', ')} via ${role.executor.harness}`,
      )
      .join('\n');
    const skills = snapshot.skills
      .map((skill) => `## Skill: ${skill.slug}\n${skill.content}`)
      .join('\n\n');
    return [
      snapshot.prompt,
      snapshot.instructions,
      `Configured roles:\n${roster}`,
      skills,
      `Goal:\n${goal}`,
      'Use only the bounded harness-meta-control tools. You cannot merge branches.',
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');
  }
  private childOpts(
    workspace: Workspace,
    role: AgentRoleSnapshot,
    prompt: string,
    snapshot: NormalizedAgentSnapshot,
    runId: string,
  ): StartTurnOpts {
    const skills = snapshot.skills
      .map((skill) => `## Skill: ${skill.slug}\n${skill.content}`)
      .join('\n\n');
    return {
      workspaceDir: workspace.worktreePath!,
      prompt: [
        snapshot.instructions,
        role.prompt,
        role.instructions,
        skills,
        `Assigned work:\n${prompt}`,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n'),
      attachments: [],
      mode: role.executor.mode,
      mcpConfig: [],
      permissionPolicy: this.deps.settings().permissionPolicy,
      model: role.executor.model,
      readOnlyMode: role.executor.readOnlyMode,
      metaRunId: runId,
      scopedWriteMode: !role.executor.readOnlyMode,
    };
  }
  private assertDebbyConfiguration(
    snapshot: NormalizedAgentSnapshot,
    policy: AgentRunPolicy,
  ): void {
    if (snapshot.protocol !== 'debby') return;
    const partners = snapshot.roles.filter((role) =>
      role.slug.endsWith('-partner'),
    );
    const critics = snapshot.roles.filter(
      (role) =>
        role.slug.endsWith('-critic') && role.purposes.includes('critique'),
    );
    if (
      partners.length !== 2 ||
      critics.length !== 2 ||
      new Set(partners.map((role) => role.executor.harness)).size !== 2 ||
      new Set(critics.map((role) => role.executor.harness)).size !== 2 ||
      policy.critiqueRounds < 1
    )
      throw new AppError(
        'invalid_input',
        'Debby requires two cross-provider partners, two cross-provider critics, and at least one critique round',
      );
  }
  private debateDispatchMetadata(
    snapshot: NormalizedAgentSnapshot,
    role: AgentRoleSnapshot,
    purpose: AgentDispatchPurpose,
    existing: AgentDispatchSummary[],
    policy: AgentRunPolicy,
  ): { debateStage?: 'partner' | 'critique'; debateRound?: number } {
    if (snapshot.protocol !== 'debby') return {};
    const partnerRoles = snapshot.roles.filter((item) =>
      item.slug.endsWith('-partner'),
    );
    const criticRoles = snapshot.roles.filter((item) =>
      item.slug.endsWith('-critic'),
    );
    if (partnerRoles.some((item) => item.slug === role.slug)) {
      if (
        purpose === 'critique' ||
        existing.some(
          (dispatch) =>
            dispatch.debateStage === 'partner' && dispatch.role === role.slug,
        ) ||
        existing.some((dispatch) => dispatch.debateStage === 'critique')
      )
        throw new AppError(
          'conflict',
          'Debby partner responses must each run exactly once before critique',
        );
      return { debateStage: 'partner', debateRound: 0 };
    }
    if (
      !criticRoles.some((item) => item.slug === role.slug) ||
      purpose !== 'critique'
    )
      throw new AppError('invalid_input', 'role is not part of Debby protocol');
    const partners = existing.filter(
      (dispatch) => dispatch.debateStage === 'partner',
    );
    if (
      partnerRoles.some(
        (partner) =>
          !partners.some(
            (dispatch) =>
              dispatch.role === partner.slug && dispatch.status === 'completed',
          ),
      )
    )
      throw new AppError(
        'conflict',
        'both Debby partner responses must complete before critique',
      );
    const critiques = existing.filter(
      (dispatch) => dispatch.debateStage === 'critique',
    );
    const round = Math.floor(critiques.length / criticRoles.length) + 1;
    if (
      round > policy.critiqueRounds ||
      critiques.some(
        (dispatch) =>
          dispatch.debateRound === round && dispatch.role === role.slug,
      ) ||
      (round > 1 &&
        criticRoles.some(
          (critic) =>
            !critiques.some(
              (dispatch) =>
                dispatch.debateRound === round - 1 &&
                dispatch.role === critic.slug &&
                dispatch.status === 'completed',
            ),
        ))
    )
      throw new AppError('conflict', 'Debby critique round is not available');
    return { debateStage: 'critique', debateRound: round };
  }
  private debbyProtocolComplete(
    snapshot: NormalizedAgentSnapshot,
    dispatches: AgentDispatchSummary[],
    policy: AgentRunPolicy,
  ): boolean {
    const partners = snapshot.roles.filter((role) =>
      role.slug.endsWith('-partner'),
    );
    const critics = snapshot.roles.filter((role) =>
      role.slug.endsWith('-critic'),
    );
    const rounds = Array.from(
      { length: policy.critiqueRounds },
      (_, index) => index + 1,
    );
    return (
      partners.every((role) =>
        dispatches.some(
          (dispatch) =>
            dispatch.role === role.slug &&
            dispatch.debateStage === 'partner' &&
            dispatch.status === 'completed',
        ),
      ) &&
      rounds.every((round) =>
        critics.every((role) =>
          dispatches.some(
            (dispatch) =>
              dispatch.role === role.slug &&
              dispatch.debateStage === 'critique' &&
              dispatch.debateRound === round &&
              dispatch.status === 'completed',
          ),
        ),
      )
    );
  }
  private coordinatorSink(run: MetaRunSummary): StreamSink<AgentEvent> {
    let text = '';
    let settled = false;
    const finish = (terminal: CoordinatorTerminal): void => {
      if (settled) return;
      settled = true;
      this.clearDeadline(`coordinator:${run.id}`);
      void this.serializeRun(run.id, async () => {
        this.coordinatorTerminals.set(run.id, terminal);
        await this.maybeFinishCoordinatorLocked(run.id);
      });
    };
    return {
      push: (event) => {
        if (event.kind === 'text') text = (text + event.delta).slice(-131_072);
        if (event.kind === 'turn_end')
          finish({
            status: 'completed',
            summary: sanitizeSensitiveText(text),
          });
        else if (event.kind === 'error')
          finish({
            status: 'failed',
            summary: sanitizeSensitiveText(text),
            error: sanitizeErrorMessage(event.message),
          });
      },
      end: () => undefined,
      error: (error) =>
        finish({
          status: 'failed',
          summary: sanitizeSensitiveText(text),
          error: sanitizeErrorMessage(error),
        }),
    };
  }
  private dispatchSink(
    run: MetaRunSummary,
    dispatchId: string,
    deadlineKey: string,
  ): StreamSink<AgentEvent> {
    let text = '';
    let settled = false;
    const finish = (status: 'completed' | 'failed', error?: string): void => {
      if (settled) return;
      settled = true;
      this.clearDeadline(deadlineKey);
      void this.completeDispatch(
        run,
        dispatchId,
        status,
        sanitizeSensitiveText(text),
        error,
      );
    };
    return {
      push: (event) => {
        if (event.kind === 'text') text = (text + event.delta).slice(-131_072);
        if (event.kind === 'turn_end') finish('completed');
        else if (event.kind === 'error')
          finish('failed', sanitizeErrorMessage(event.message));
      },
      end: () => undefined,
      error: (error) => finish('failed', sanitizeErrorMessage(error)),
    };
  }
  private async completeDispatch(
    run: MetaRunSummary,
    dispatchId: string,
    status: 'completed' | 'failed',
    summary: string,
    error?: string,
  ): Promise<void> {
    await this.serializeRun(run.id, async () => {
      const current = await this.deps.dispatches.get(dispatchId);
      if (!ACTIVE_DISPATCH.has(current.status)) return;
      let changedFiles: string[] | undefined;
      let diffStat: string | undefined;
      if (current.workspaceId && this.deps.diff) {
        try {
          const diff = await this.deps.diff.getDiff(current.workspaceId);
          changedFiles = diff.files.map((file) => file.path);
          const additions = diff.files.reduce(
            (total, file) => total + file.additions,
            0,
          );
          const deletions = diff.files.reduce(
            (total, file) => total + file.deletions,
            0,
          );
          diffStat = `${diff.files.length} files changed, +${additions} -${deletions}`;
        } catch {
          // Result metadata is best-effort and must not override the turn outcome.
        }
      }
      await this.deps.dispatches.finish(dispatchId, status, {
        summary,
        error,
        changedFiles,
        diffStat,
      });
      this.emitRun(await this.deps.runs.get(run.id));
      await this.maybeFinishCoordinatorLocked(run.id);
    });
  }
  private async stopRun(
    projectId: string,
    runId: string,
    status: 'cancelled' | 'taken_over' | 'interrupted',
  ): Promise<void> {
    const knownProjectId = this.runProjectIds.get(runId);
    if (knownProjectId !== undefined && knownProjectId !== projectId)
      throw new AppError('not_found', 'meta run not found');
    if (knownProjectId === undefined) {
      const initial = await this.deps.runs.get(runId);
      if (initial.projectId !== projectId)
        throw new AppError('not_found', 'meta run not found');
    }
    // Publication runs inside the run lock. Abort it before waiting for that lock so
    // cancel/takeover/shutdown cannot be delayed by Git or GitHub I/O.
    this.runAbortControllers.get(runId)?.abort();
    await this.serializeRun(runId, async () => {
      const run = await this.deps.runs.get(runId);
      await this.terminalizeRunLocked(run, status);
    });
  }
  private async maybeFinishCoordinatorLocked(runId: string): Promise<void> {
    const terminal = this.coordinatorTerminals.get(runId);
    if (!terminal) return;
    const run = await this.deps.runs.get(runId);
    if (TERMINAL_RUN.has(run.status)) return;
    const dispatches = await this.deps.dispatches.list(runId);
    const snapshot = await this.snapshot(runId);
    if (
      snapshot.protocol === 'debby' &&
      !this.debbyProtocolComplete(snapshot, dispatches, snapshot.policy)
    ) {
      terminal.status = 'failed';
      terminal.error =
        'Debby coordinator ended before all required debate stages completed';
    }
    if (terminal.status === 'completed' && (run.allowPush || run.allowOpenPr)) {
      try {
        await this.publishConsentedOutputs(run, dispatches, terminal.summary);
      } catch (error) {
        if (this.runAbortControllers.get(run.id)?.signal.aborted) return;
        terminal.status = 'failed';
        terminal.error = `consented publish failed: ${sanitizeErrorMessage(error)}`;
      }
    }
    const active = dispatches.filter((dispatch) =>
      ACTIVE_DISPATCH.has(dispatch.status),
    );
    // A coordinator cannot abandon live children. First make their durable state
    // terminal so late provider events lose the CAS. terminalizeRunLocked owns the
    // single process-interruption pass for every claimed workspace; interrupting
    // here as well races the provider's terminal event and can deliver it twice.
    for (const dispatch of active) {
      this.clearDeadline(`dispatch:${dispatch.id}`);
      await this.deps.dispatches.finish(dispatch.id, 'cancelled', {
        error: 'coordinator ended before the child completed',
      });
    }
    await this.terminalizeRunLocked(run, terminal.status, {
      summary: terminal.summary,
      error: terminal.error,
    });
  }
  private async publishConsentedOutputs(
    run: MetaRunSummary,
    dispatches: AgentDispatchSummary[],
    summary?: string,
  ): Promise<void> {
    const publisher = this.deps.publisher;
    if (!publisher)
      throw new AppError('harness', 'publish workflow unavailable');
    const publishable = dispatches.filter(
      (dispatch) =>
        dispatch.status === 'completed' &&
        dispatch.workspaceId !== null &&
        dispatch.changedFiles.length > 0,
    );
    const signal = this.runAbortControllers.get(run.id)?.signal;
    if (!signal) throw new AppError('conflict', 'meta run is no longer active');
    for (const dispatch of publishable) {
      signal.throwIfAborted();
      const current = await this.deps.runs.get(run.id);
      if (current.status !== 'running')
        throw new AppError('conflict', 'meta run is no longer active');
      if (run.allowOpenPr) {
        await publisher.openPr(dispatch.workspaceId!, {
          draft: true,
          // Always provide a bounded body, including the empty string. The reviewed
          // meta path must never fall back to PrWorkflow's unrelated diff-derived body,
          // whose extra Git I/O is outside this run-owned publication sequence.
          body: sanitizeSensitiveText(summary ?? ''),
          signal,
        });
      } else if (run.allowPush) {
        await publisher.pushBranch(dispatch.workspaceId!, { signal });
      }
      signal.throwIfAborted();
    }
  }
  private async terminalizeRunLocked(
    run: MetaRunSummary,
    status: 'completed' | 'failed' | 'cancelled' | 'taken_over' | 'interrupted',
    extra: { summary?: string; error?: string } = {},
    dispatchStatus: 'cancelled' | 'timed_out' = 'cancelled',
  ): Promise<void> {
    if (this.terminalizingRunIds.has(run.id)) return;
    this.terminalizingRunIds.add(run.id);
    this.terminalRunIds.add(run.id);
    try {
      const current = await this.deps.runs.get(run.id);
      if (TERMINAL_RUN.has(current.status)) return;
      await this.deps.broker.revoke(run.id);
      const activeDispatches = (await this.deps.dispatches.list(run.id)).filter(
        (dispatch) => ACTIVE_DISPATCH.has(dispatch.status),
      );
      for (const dispatch of activeDispatches) {
        this.clearDeadline(`dispatch:${dispatch.id}`);
        await this.deps.dispatches.finish(dispatch.id, dispatchStatus, {
          error:
            dispatchStatus === 'timed_out'
              ? 'meta run deadline exceeded'
              : `meta run ${status}`,
        });
      }
      const claimed = [...this.claims.entries()]
        .filter(([, claim]) => claim.runId === run.id)
        .map(([workspaceId, claim]) => ({ workspaceId, kind: claim.kind }));
      await Promise.allSettled(
        claimed
          .filter(
            ({ workspaceId, kind }) =>
              kind !== 'source' && this.deps.harness.isActive(workspaceId),
          )
          .map(({ workspaceId }) => this.interruptWorkspaceOnce(workspaceId)),
      );
      this.releaseRunClaims(run.id);
      const next = await this.deps.runs.transition(run.id, status, extra);
      this.clearRunState(run.id);
      this.emitRun(next);
      this.notifyTerminal(next);
    } finally {
      this.terminalizingRunIds.delete(run.id);
      if (!this.runLocks.has(run.id) && !this.startingRunIds.has(run.id))
        this.terminalRunIds.delete(run.id);
    }
  }
  private armDeadline(
    key: string,
    durationMs: number,
    expire: () => Promise<void>,
  ): void {
    this.clearDeadline(key);
    const timer = setTimeout(() => {
      this.deadlines.delete(key);
      void expire().catch(() => undefined);
    }, durationMs);
    timer.unref?.();
    this.deadlines.set(key, timer);
  }
  private clearDeadline(key: string): void {
    const timer = this.deadlines.get(key);
    if (timer) clearTimeout(timer);
    this.deadlines.delete(key);
  }
  private clearRunState(runId: string): void {
    for (const key of this.deadlines.keys())
      if (key === `run:${runId}` || key === `coordinator:${runId}`)
        this.clearDeadline(key);
    this.snapshots.delete(runId);
    this.coordinatorProviders.delete(runId);
    this.coordinatorTerminals.delete(runId);
    this.runAbortControllers.get(runId)?.abort();
    this.runAbortControllers.delete(runId);
    this.runProjectIds.delete(runId);
  }
  private async expireRun(runId: string): Promise<void> {
    this.runAbortControllers.get(runId)?.abort();
    const run = await this.deps.runs.get(runId);
    await this.terminalizeRunLocked(
      run,
      'failed',
      { error: 'meta run deadline exceeded' },
      'timed_out',
    );
  }
  private async expireCoordinator(
    runId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.interruptWorkspaceOnce(workspaceId);
    await this.serializeRun(runId, async () => {
      const run = await this.deps.runs.get(runId);
      if (TERMINAL_RUN.has(run.status)) return;
      this.coordinatorTerminals.set(runId, {
        status: 'failed',
        summary: '',
        error: 'coordinator turn deadline exceeded',
      });
      const active = (await this.deps.dispatches.list(runId)).some((dispatch) =>
        ACTIVE_DISPATCH.has(dispatch.status),
      );
      if (!active) await this.maybeFinishCoordinatorLocked(runId);
    });
  }
  private async expireDispatch(
    runId: string,
    dispatchId: string,
    workspaceId: string,
  ): Promise<void> {
    const current = await this.deps.dispatches.get(dispatchId);
    if (!ACTIVE_DISPATCH.has(current.status)) return;
    await this.deps.dispatches.finish(dispatchId, 'timed_out', {
      error: 'dispatch turn deadline exceeded',
    });
    await this.interruptWorkspaceOnce(workspaceId);
    await this.serializeRun(runId, async () => {
      this.emitRun(await this.deps.runs.get(runId));
      await this.maybeFinishCoordinatorLocked(runId);
    });
  }
  private async serializeRun<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runLocks.set(runId, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.runLocks.get(runId) === current) {
        this.runLocks.delete(runId);
        if (
          !this.terminalizingRunIds.has(runId) &&
          !this.startingRunIds.has(runId)
        )
          this.terminalRunIds.delete(runId);
      }
    }
  }
  private finishRunStartup(runId: string): void {
    this.startingRunIds.delete(runId);
    if (!this.runLocks.has(runId) && !this.terminalizingRunIds.has(runId))
      this.terminalRunIds.delete(runId);
  }
  private emitRun(run: MetaRunSummary): void {
    this.deps.emit('metaRun:changed', {
      projectId: run.projectId,
      runId: run.id,
      status: run.status,
    });
  }
  private notifyTerminal(run: MetaRunSummary): void {
    const listeners = this.terminalListeners.get(run.id);
    if (!listeners) return;
    this.terminalListeners.delete(run.id);
    for (const listener of listeners) {
      try {
        listener(run);
      } catch {
        // Durable terminal state must not depend on an observer callback.
      }
    }
  }
}

/** Constructs the broker/service cycle without broadening either public interface. */
export function createMetaHarnessService(
  deps: Omit<MetaHarnessServiceDeps, 'broker'>,
): { service: MetaHarnessService; broker: ControlBroker } {
  const holder: { service?: MetaHarnessService } = {};
  const broker = new ControlBroker({
    dispatch: (session, params) => holder.service!.dispatch(session, params),
    continueDispatch: (session, params) =>
      holder.service!.continueDispatch(session, params),
    awaitDispatches: (session, params) =>
      holder.service!.awaitDispatches(session, params),
    cancelDispatch: (session, params) =>
      holder.service!.cancelDispatch(session, params),
  });
  const service = new MetaHarnessService({ ...deps, broker });
  holder.service = service;
  return { service, broker };
}
