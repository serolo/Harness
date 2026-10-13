// HarnessSupervisor — owns live agent turns keyed by workspace and optional manual chat
// context. Scheduler/meta turns retain workspace exclusivity, while different manual
// contexts can stream concurrently. It drives the workspace status machine through the
// turn lifecycle and routes interrupt/quit (README §6.3). Adapters (`claude-code.ts`,
// `mock.ts`, later `codex`/`cursor`) implement the frozen `Harness` interface.
//
// FROZEN: the public method signatures (`register`, `detect`, `startTurn`, `interrupt`,
// `isActive`, `quitAll`) are frozen for Phase 7's other adapters — bodies are filled
// here in Phase 2 but the shapes must not change. `getActiveTurnId` is an additive
// main-only helper the IPC producer uses to frame the `turn:start` stream.
//
// HEIGHTENED SCRUTINY (process lifecycle): the per-scope invariant is load-bearing —
// each registry entry is cleared on EVERY terminal path (turn_end / error / interrupt /
// synthesized-on-exit) BEFORE the async finalize runs, so a crash mid-finalize can
// never wedge a workspace "busy" forever. Status changes go ONLY through the injected
// `setStatus` (never a direct DB write). Per-turn DB writes are serialized on a promise
// chain so event order is preserved even though `sink.push` is a synchronous callback.
//
// Raw agent PTYs are also registered in the shared ProcessRegistry. This supervisor
// retains the turn registry because it owns transcript finalization and busy state.

import type {
  AgentEvent,
  DetectResult,
  Harness,
  HarnessId,
  KnowledgeTurnStatusEvent,
  StartTurnOpts,
  Todo,
  TurnHandle,
} from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import type { EventChannel, EventPayload, HarnessInfo } from '@shared/ipc';
import type { TurnStatus, Workspace, WorkspaceStatus } from '@shared/models';
import { AppError } from '@shared/errors';
import { logger } from '../logging';
import type { TurnRecorder } from './turns';
import type { NotificationService } from './notifications';
import { sanitizeErrorMessage } from '../security/sanitize-error';
import { consumeKnowledgeTrace } from '../knowledge/retrieval';

function resolveKnowledgeStatus(
  seed: KnowledgeTurnStatusEvent | undefined,
  traceEvents: AgentEvent[],
): KnowledgeTurnStatusEvent | undefined {
  if (seed === undefined) return undefined;
  if (seed.status !== 'prepared') return seed;

  const statusEvents = traceEvents.filter(
    (event): event is KnowledgeTurnStatusEvent =>
      event.kind === 'knowledge_status',
  );
  const retrievalEvents = traceEvents.filter(
    (event) => event.kind === 'knowledge_retrieval',
  );
  const failed = statusEvents.find((event) => event.status === 'failed');
  if (failed) return failed;
  const fallback = statusEvents.find((event) => event.status === 'fallback');
  if (fallback) return fallback;
  const lastRead = [...retrievalEvents]
    .reverse()
    .find((event) => event.operation === 'read');
  if (lastRead) {
    return {
      kind: 'knowledge_status',
      status: 'read',
      provider: lastRead.provider,
    };
  }
  const lastSearch = [...retrievalEvents]
    .reverse()
    .find((event) => event.operation === 'search');
  if (lastSearch) {
    return {
      kind: 'knowledge_status',
      status: (lastSearch.resultCount ?? 0) > 0 ? 'searched' : 'no_results',
      provider: lastSearch.provider,
    };
  }
  return {
    kind: 'knowledge_status',
    status: 'unused',
    provider: seed.provider,
    reason: 'unused',
  };
}

/** One in-flight turn. Cleared from the registry the instant a terminal event lands. */
interface LiveTurn {
  workspaceId: string;
  contextId?: string;
  turnId: string;
  handle?: TurnHandle;
  /** Set when the user (or quit) requested an interrupt — maps the terminal to `interrupted`. */
  interrupted: boolean;
  /** Any graceful stop request, including watchdogs, pending handle readiness. */
  stopRequested: boolean;
  /** True once the provider handle has received the interrupt request. */
  interruptDelivered: boolean;
  /** Workspace name captured for secret-free notifications. */
  workspaceName?: string;
  /** Serializes per-turn persistence so event order is preserved. */
  writeChain: Promise<void>;
  /** Resolves once provider startup either supplies a handle or fails. */
  handleReady: Promise<void>;
  resolveHandleReady: () => void;
  /** Terminal delivery is one-shot; providers occasionally emit trailing noise. */
  terminalSeen: boolean;
  /** Watchdog timers are owned by the live turn and cleared on every terminal path. */
  idleWatchdog?: ReturnType<typeof setTimeout>;
  totalWatchdog?: ReturnType<typeof setTimeout>;
  stopDeadline?: ReturnType<typeof setTimeout>;
  /** Idle limit snapshotted from settings at turn start. */
  idleWatchdogMs?: number;
  /** Replaces the provider terminal event when a bounded-execution watchdog fired. */
  watchdogMessage?: string;
  /** A force request can arrive while the provider handle is still starting. */
  forceInterruptRequested: boolean;
  forceInterruptDelivered: boolean;
  /** Synthesizes a terminal boundary if a provider never reports process exit. */
  completeStop?: () => void;
}

export interface TurnWatchdogTimeouts {
  idleMs: number;
  totalMs?: number;
}

export interface HarnessSupervisorDeps {
  recorder: TurnRecorder;
  /** Resolve a workspace (to pick its harness adapter + name). */
  getWorkspace: (id: string) => Promise<Workspace | null>;
  /** The SOLE status writer (`WorkspaceManager.setStatus`, README §6.4). */
  setStatus: (id: string, status: WorkspaceStatus) => Promise<void>;
  /** Broadcast a typed event to the renderer(s). */
  emit: <K extends EventChannel>(event: K, payload: EventPayload<K>) => void;
  notifications: NotificationService;
  /** Persist the agent's current todo set when a `todo_update` event arrives (best-effort). */
  onTodoUpdate?: (workspaceId: string, todos: Todo[]) => void;
  /** Capture any state needed to evaluate the turn before the adapter can mutate files.
   *  Best-effort: failure must not prevent the turn from starting. */
  onTurnStart?: (
    workspaceId: string,
    turnId: string,
    opts: StartTurnOpts,
  ) => Promise<void>;
  /** Fired at the end of finalize (after status flip) so Phase-4 can snapshot a checkpoint +
   *  recompute the diff off the finalize path (best-effort — must not throw). */
  onTurnEnd?: (workspaceId: string, turnId: string) => void;
  /** Snapshot configurable execution limits when each turn starts. */
  getWatchdogTimeouts?: (mode: StartTurnOpts['mode']) => TurnWatchdogTimeouts;
  /** Test seam for the stop hard deadline; production defaults to 10.5 seconds. */
  stopHardDeadlineMs?: number;
}

export class HarnessSupervisor {
  private readonly adapters = new Map<HarnessId, Harness>();
  private readonly registry = new Map<string, LiveTurn>();
  private readonly starting = new Map<string, string>();
  private readonly finalizingByWorkspace = new Map<string, number>();
  private readonly startedTurnIds = new Map<string, string>();
  private shuttingDown = false;
  private workspaceClaimGuard:
    ((workspaceId: string, metaRunId?: string) => void) | undefined;
  private readonly deps: HarnessSupervisorDeps;

  constructor(deps: HarnessSupervisorDeps) {
    this.deps = deps;
  }

  /** Register a harness adapter so it can be selected by `id`. */
  register(harness: Harness): void {
    this.adapters.set(harness.id, harness);
  }

  /** Install the main-only meta-run ownership gate at the definitive start boundary. */
  setWorkspaceClaimGuard(
    guard: (workspaceId: string, metaRunId?: string) => void,
  ): void {
    this.workspaceClaimGuard = guard;
  }

  /** List every registered harness with capabilities + a live detect summary. */
  async listHarnesses(): Promise<HarnessInfo[]> {
    const out: HarnessInfo[] = [];
    for (const adapter of this.adapters.values()) {
      out.push({
        id: adapter.id,
        capabilities: adapter.capabilities(),
        detect: await adapter.detect(),
      });
    }
    return out;
  }

  /** Probe whether a registered harness CLI is installed/authenticated (§6.3). */
  async detect(id: HarnessId): Promise<DetectResult> {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new AppError('harness', `no harness registered for id "${id}"`, {
        id,
      });
    }
    return adapter.detect();
  }

  /**
   * Start a turn for a workspace. Rejects with `AppError('conflict')` if a turn is
   * already active (at-most-one invariant). Wires the adapter's `AgentEvent` stream so
   * each event is BOTH forwarded to `sink` (renderer) and recorded (coalesced DB), and
   * drives status idle→working, then →needs_attention on the terminal event.
   */
  async startTurn(
    workspaceId: string,
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
    harnessOverride?: HarnessId,
  ): Promise<TurnHandle> {
    this.assertAcceptingStarts(opts);
    if (this.hasWorkspaceActivity(workspaceId)) {
      consumeKnowledgeTrace(opts.knowledgeTrace);
      throw new AppError(
        'conflict',
        'a turn is already active for this workspace',
        { workspaceId },
      );
    }
    return this.startReservedTurn(
      workspaceId,
      undefined,
      opts,
      sink,
      harnessOverride,
    );
  }

  /** Start a manual chat turn scoped to one durable context. Other contexts may run concurrently. */
  async startContextTurn(
    workspaceId: string,
    contextId: string,
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
    harnessOverride?: HarnessId,
  ): Promise<TurnHandle> {
    this.assertAcceptingStarts(opts);
    const key = this.registryKey(workspaceId, contextId);
    const exclusiveKey = this.registryKey(workspaceId);
    if (
      this.registry.has(key) ||
      this.starting.has(key) ||
      this.registry.has(exclusiveKey) ||
      this.starting.has(exclusiveKey)
    ) {
      consumeKnowledgeTrace(opts.knowledgeTrace);
      throw new AppError(
        'conflict',
        'a turn is already active for this chat context',
        { workspaceId, contextId },
      );
    }
    return this.startReservedTurn(
      workspaceId,
      contextId,
      { ...opts, contextId },
      sink,
      harnessOverride,
    );
  }

  private async startReservedTurn(
    workspaceId: string,
    contextId: string | undefined,
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
    harnessOverride?: HarnessId,
  ): Promise<TurnHandle> {
    const discardKnowledge = (): void => {
      consumeKnowledgeTrace(opts.knowledgeTrace);
    };
    const registryKey = this.registryKey(workspaceId, contextId);
    // Guard and reservation are synchronous: no ordinary IPC/scheduler turn can slip
    // through between a claim check and the first awaited persistence operation.
    try {
      this.workspaceClaimGuard?.(workspaceId, opts.metaRunId);
    } catch (error) {
      discardKnowledge();
      throw error;
    }
    this.starting.set(registryKey, workspaceId);

    let workspace: Workspace | null;
    try {
      workspace = await this.deps.getWorkspace(workspaceId);
    } catch (error) {
      this.starting.delete(registryKey);
      discardKnowledge();
      throw error;
    }
    if (!workspace) {
      this.starting.delete(registryKey);
      discardKnowledge();
      throw new AppError('not_found', 'workspace not found', { workspaceId });
    }
    const harnessId = harnessOverride ?? workspace.harness;
    const adapter = this.adapters.get(harnessId);
    if (!adapter) {
      this.starting.delete(registryKey);
      discardKnowledge();
      throw new AppError(
        'harness',
        `no harness registered for id "${harnessId}"`,
        { workspaceId, harness: harnessId },
      );
    }

    let turnId: string;
    try {
      turnId = await this.deps.recorder.beginTurn(workspaceId, {
        sessionId: opts.sessionId,
        mode: opts.mode,
        harness: harnessId,
        model: opts.model,
        // Owning chat tab (validated at the IPC boundary); undefined for scheduler-fired
        // turns, which stay unowned so task tabs keep reconstructing from `task:list`.
        contextId,
      });
    } catch (error) {
      this.starting.delete(registryKey);
      discardKnowledge();
      throw error;
    }

    const live: LiveTurn = {
      workspaceId,
      contextId,
      turnId,
      interrupted: false,
      stopRequested: false,
      interruptDelivered: false,
      workspaceName: workspace.name,
      writeChain: Promise.resolve(),
      handleReady: Promise.resolve(),
      resolveHandleReady: () => undefined,
      terminalSeen: false,
      forceInterruptRequested: false,
      forceInterruptDelivered: false,
    };
    live.handleReady = new Promise<void>((resolve) => {
      live.resolveHandleReady = resolve;
    });
    // Register + flip to `working` BEFORE the adapter can emit, so a terminal event
    // (which flips to needs_attention) can never be overtaken by a late `working`.
    this.registry.set(registryKey, live);
    this.startedTurnIds.set(registryKey, turnId);
    this.starting.delete(registryKey);
    try {
      await this.deps.setStatus(workspaceId, 'working');
    } catch (error) {
      this.registry.delete(registryKey);
      this.startedTurnIds.delete(registryKey);
      discardKnowledge();
      await this.safeEndTurn(turnId, 'error');
      throw error;
    }
    if (this.deps.onTurnStart) {
      try {
        await this.deps.onTurnStart(workspaceId, turnId, opts);
      } catch (err) {
        this.logHookError('onTurnStart', workspaceId, err);
      }
    }

    let knowledgeClosed = false;
    let knowledgeStatusEmitted = false;
    const closeKnowledge = (): AgentEvent[] => {
      if (knowledgeClosed) return [];
      knowledgeClosed = true;
      const traceEvents = consumeKnowledgeTrace(opts.knowledgeTrace);
      const retrievalEvents = traceEvents.filter(
        (event) => event.kind === 'knowledge_retrieval',
      );
      const status = knowledgeStatusEmitted
        ? undefined
        : resolveKnowledgeStatus(opts.knowledgeStatus, traceEvents);
      if (status !== undefined) knowledgeStatusEmitted = true;
      return status === undefined
        ? retrievalEvents
        : [...retrievalEvents, status];
    };

    // The sink the adapter pushes into: forward to the renderer, then enqueue the
    // persistence/finalize step on the per-turn write chain (order-preserving).
    const wrapped: StreamSink<AgentEvent> = {
      push: (event) => {
        if (live.terminalSeen) return;
        const terminal = event.kind === 'turn_end' || event.kind === 'error';
        const effectiveEvent: AgentEvent =
          terminal && live.watchdogMessage !== undefined
            ? { kind: 'error', message: live.watchdogMessage }
            : event;
        if (terminal) {
          for (const traceEvent of closeKnowledge()) {
            wrapped.push(traceEvent);
          }
        } else {
          this.resetIdleWatchdog(live);
        }

        const safeEvent: AgentEvent =
          effectiveEvent.kind === 'error'
            ? {
                ...effectiveEvent,
                message: sanitizeErrorMessage(effectiveEvent.message),
              }
            : effectiveEvent;
        if (safeEvent.kind === 'turn_end' || safeEvent.kind === 'error') {
          live.terminalSeen = true;
          this.clearWatchdogs(live);
        }
        // Provider metadata belongs in persistence, not in the visible transcript.
        if (safeEvent.kind !== 'model_info') {
          sink.push(safeEvent);
        }
        const current = this.registry.get(registryKey);
        if (!current || current !== live) return; // already finalized
        if (safeEvent.kind === 'turn_end' || safeEvent.kind === 'error') {
          // Restore the single-turn invariant immediately (before async finalize).
          this.registry.delete(registryKey);
          this.beginFinalizing(workspaceId);
          live.writeChain = live.writeChain
            .then(() => this.finalize(workspaceId, live, safeEvent))
            .catch((err) => this.logFinalizeError(workspaceId, err));
        } else {
          // Best-effort side-hook: persist the agent's current todo set. Fired inline
          // (synchronously) and guarded so a hook failure can never wedge the write chain
          // or the turn. Event RECORDING below is unchanged.
          if (safeEvent.kind === 'todo_update' && this.deps.onTodoUpdate) {
            try {
              this.deps.onTodoUpdate(workspaceId, safeEvent.todos);
            } catch (err) {
              this.logHookError('onTodoUpdate', workspaceId, err);
            }
          }
          live.writeChain = live.writeChain
            .then(() => this.deps.recorder.record(turnId, safeEvent))
            .catch((err) => this.logRecordError(turnId, err));
        }
      },
      end: () => {
        for (const traceEvent of closeKnowledge()) wrapped.push(traceEvent);
        sink.end();
      },
      error: (e) => {
        if (live.terminalSeen) return;
        // Adapter-level stream failure: ensure the turn is finalized as an error.
        const safeMessage = sanitizeErrorMessage(e);
        for (const traceEvent of closeKnowledge()) {
          wrapped.push(traceEvent);
        }
        live.terminalSeen = true;
        this.clearWatchdogs(live);
        const current = this.registry.get(registryKey);
        if (current === live) {
          this.registry.delete(registryKey);
          this.beginFinalizing(workspaceId);
          live.writeChain = live.writeChain
            .then(() =>
              this.finalize(workspaceId, live, {
                kind: 'error',
                message: safeMessage,
              }),
            )
            .catch((err) => this.logFinalizeError(workspaceId, err));
        }
        sink.error(new AppError('harness', safeMessage));
      },
    };
    live.completeStop = () => {
      if (live.terminalSeen) return;
      wrapped.push({ kind: 'turn_end' });
      wrapped.end();
    };

    let handle: TurnHandle;
    try {
      // The user's prompt is part of the reconstructable conversation even though it
      // is not emitted by the harness adapter. Persist it before agent output so a
      // reopened workspace renders the same right-aligned message shown live.
      await this.deps.recorder.record(turnId, {
        kind: 'user_message',
        text: opts.displayPrompt ?? opts.prompt,
      });
      if (opts.attachments.length > 0) {
        await this.deps.recorder.record(turnId, {
          kind: 'user_attachments',
          attachments: opts.attachments,
        });
      }
      if (opts.metaSkills?.length) {
        wrapped.push({ kind: 'meta_skill_access', skills: opts.metaSkills });
      }
      if (
        opts.knowledgeStatus !== undefined &&
        opts.knowledgeStatus.status !== 'prepared'
      ) {
        wrapped.push(opts.knowledgeStatus);
        knowledgeStatusEmitted = true;
      }
      if (opts.knowledgeSources?.length) {
        wrapped.push({
          kind: 'knowledge_context',
          sources: opts.knowledgeSources,
          ...(opts.knowledgeRetrieval === undefined
            ? {}
            : { retrieval: opts.knowledgeRetrieval }),
        });
      }
      this.armWatchdogs(live, opts.mode);
      handle = await adapter.startTurn({ ...opts, workspaceId }, wrapped);
    } catch (err) {
      this.clearWatchdogs(live);
      live.resolveHandleReady();
      for (const traceEvent of closeKnowledge()) {
        live.writeChain = live.writeChain.then(() =>
          this.deps.recorder.record(turnId, traceEvent),
        );
      }
      await live.writeChain;
      // Spawn/start failure before any event: finalize as an error and clear.
      this.registry.delete(registryKey);
      this.startedTurnIds.delete(registryKey);
      await this.safeEndTurn(turnId, 'error');
      await this.deps.setStatus(
        workspaceId,
        this.hasWorkspaceActivity(workspaceId) ? 'working' : 'needs_attention',
      );
      throw err instanceof AppError
        ? err
        : new AppError(
            'harness',
            sanitizeErrorMessage(err, 'failed to start turn'),
          );
    }

    // The handle may reference an already-finalized turn (instant turns) — still record
    // the captured session id so the NEXT turn can `--resume` it.
    live.handle = handle;
    live.resolveHandleReady();
    // An interrupt can arrive while the adapter is still starting. Remembering only the
    // flag is insufficient: once the handle exists, immediately deliver the pending
    // interrupt so a late-spawning child cannot outlive its deadline or cancellation.
    if (
      live.stopRequested &&
      !live.forceInterruptRequested &&
      !live.interruptDelivered
    ) {
      live.interruptDelivered = true;
      await handle.interrupt();
    }
    if (live.forceInterruptRequested && !live.forceInterruptDelivered) {
      live.forceInterruptDelivered = true;
      await (handle.forceInterrupt?.() ?? handle.interrupt());
    }
    if (handle.sessionId) {
      try {
        await this.deps.recorder.setSessionId(turnId, handle.sessionId);
      } catch (err) {
        logger.warn(
          `[harness] failed to persist session id for turn ${turnId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return handle;
  }

  /**
   * Interrupt the active turn for a workspace (SIGINT via the handle). Marks the turn
   * so its terminal event records an `interrupted` turn. No-op if none active.
   */
  async interrupt(workspaceId: string): Promise<void> {
    const live = this.registry.get(this.registryKey(workspaceId));
    if (!live) return;
    await this.stopLive(live, false, true);
  }

  /** Immediately force-stop the complete process tree for the workspace turn. */
  async forceInterrupt(workspaceId: string): Promise<void> {
    const live = this.registry.get(this.registryKey(workspaceId));
    if (!live) return;
    await this.stopLive(live, true, true);
  }

  /** True when a turn is currently streaming for the workspace. */
  isActive(workspaceId: string): boolean {
    return this.hasWorkspaceActivity(workspaceId);
  }

  /** The active turn id for a workspace, or undefined — used to frame the stream. */
  getActiveTurnId(workspaceId: string): string | undefined {
    return this.registry.get(this.registryKey(workspaceId))?.turnId;
  }

  /** Interrupt only the live turn owned by one manual chat context. */
  async interruptContext(
    workspaceId: string,
    contextId: string,
  ): Promise<void> {
    const live = this.registry.get(this.registryKey(workspaceId, contextId));
    if (!live) return;
    await this.stopLive(live, false, true);
  }

  /** Immediately force-stop the complete process tree for one manual chat context. */
  async forceInterruptContext(
    workspaceId: string,
    contextId: string,
  ): Promise<void> {
    const live = this.registry.get(this.registryKey(workspaceId, contextId));
    if (!live) return;
    await this.stopLive(live, true, true);
  }

  /** True when this manual chat context owns an in-flight turn. */
  isContextActive(workspaceId: string, contextId: string): boolean {
    const key = this.registryKey(workspaceId, contextId);
    return this.registry.has(key) || this.starting.has(key);
  }

  /** The in-flight turn id for one manual chat context, when allocated. */
  getContextActiveTurnId(
    workspaceId: string,
    contextId: string,
  ): string | undefined {
    return this.registry.get(this.registryKey(workspaceId, contextId))?.turnId;
  }

  /** One-shot handoff for stream framing when a provider terminates during startTurn(). */
  takeStartedTurnId(
    workspaceId: string,
    contextId?: string,
  ): string | undefined {
    const key = this.registryKey(workspaceId, contextId);
    const turnId = this.startedTurnIds.get(key);
    this.startedTurnIds.delete(key);
    return turnId;
  }

  /**
   * Interrupt every active turn (SIGINT each child) on app quit. Best-effort: the app
   * is going away, so we don't wait for clean terminal events.
   */
  async quitAll(): Promise<void> {
    this.shuttingDown = true;
    const live = [...this.registry.values()];
    await Promise.allSettled(
      live.map(async (t) => {
        this.clearWatchdogs(t);
        t.interrupted = true;
        if (!t.handle) {
          await Promise.race([
            t.handleReady,
            new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
          ]);
        }
        if (t.handle && !t.interruptDelivered) {
          t.interruptDelivered = true;
          await t.handle.interrupt();
        }
      }),
    );
    this.registry.clear();
    this.starting.clear();
    this.startedTurnIds.clear();
  }

  private async stopLive(
    live: LiveTurn,
    force: boolean,
    markInterrupted: boolean,
  ): Promise<void> {
    live.stopRequested = true;
    this.armStopDeadline(live, force);
    if (markInterrupted) live.interrupted = true;
    if (force) live.forceInterruptRequested = true;
    if (!live.handle) return;
    if (force) {
      if (live.forceInterruptDelivered) return;
      live.forceInterruptDelivered = true;
      await (live.handle.forceInterrupt?.() ?? live.handle.interrupt());
      return;
    }
    if (live.interruptDelivered) return;
    live.interruptDelivered = true;
    await live.handle.interrupt();
  }

  private armWatchdogs(live: LiveTurn, mode: StartTurnOpts['mode']): void {
    const limits = this.deps.getWatchdogTimeouts?.(mode);
    if (!limits) return;
    live.idleWatchdogMs = limits.idleMs;
    this.resetIdleWatchdog(live, limits.idleMs);
    if (limits.totalMs !== undefined && limits.totalMs > 0) {
      live.totalWatchdog = setTimeout(() => {
        live.watchdogMessage =
          'Planning turn exceeded its configured total time limit.';
        void this.stopLive(live, false, false);
      }, limits.totalMs);
      live.totalWatchdog.unref?.();
    }
  }

  private resetIdleWatchdog(live: LiveTurn, timeoutMs?: number): void {
    if (live.idleWatchdog !== undefined) clearTimeout(live.idleWatchdog);
    const configured = timeoutMs ?? live.idleWatchdogMs;
    if (configured === undefined || configured <= 0) return;
    live.idleWatchdog = setTimeout(() => {
      live.watchdogMessage =
        'Agent produced no progress before the configured idle limit.';
      void this.stopLive(live, false, false);
    }, configured);
    live.idleWatchdog.unref?.();
  }

  private clearWatchdogs(live: LiveTurn): void {
    if (live.idleWatchdog !== undefined) clearTimeout(live.idleWatchdog);
    if (live.totalWatchdog !== undefined) clearTimeout(live.totalWatchdog);
    if (live.stopDeadline !== undefined) clearTimeout(live.stopDeadline);
    live.idleWatchdog = undefined;
    live.totalWatchdog = undefined;
    live.stopDeadline = undefined;
  }

  private armStopDeadline(live: LiveTurn, force: boolean): void {
    if (live.stopDeadline !== undefined) clearTimeout(live.stopDeadline);
    const configured = this.deps.stopHardDeadlineMs ?? 10_500;
    const timeoutMs = force ? Math.min(configured, 5_500) : configured;
    live.stopDeadline = setTimeout(() => live.completeStop?.(), timeoutMs);
    live.stopDeadline.unref?.();
  }

  /**
   * Finalize a turn on its terminal event: persist an `error` event's message, close
   * the turn row with the right status + usage, flip status to `needs_attention`, and
   * fire the attention event + notification. The registry entry is ALREADY removed by
   * the caller, so `isActive` is false throughout.
   */
  private async finalize(
    workspaceId: string,
    live: LiveTurn,
    terminal: AgentEvent,
  ): Promise<void> {
    const status: TurnStatus = live.interrupted
      ? 'interrupted'
      : terminal.kind === 'error'
        ? 'error'
        : 'completed';

    try {
      // Preserve an error message in the transcript (turn_end usage → the turn row).
      if (terminal.kind === 'error' && !live.interrupted) {
        await this.deps.recorder.record(live.turnId, terminal);
      }
      const usage = terminal.kind === 'turn_end' ? terminal.usage : undefined;
      await this.deps.recorder.endTurn(live.turnId, status, usage);
    } finally {
      this.endFinalizing(workspaceId);
    }
    const workspaceStillActive =
      this.hasWorkspacePendingCompletion(workspaceId);
    await this.deps.setStatus(
      workspaceId,
      workspaceStillActive ? 'working' : 'needs_attention',
    );

    if (!workspaceStillActive) {
      const reason =
        status === 'interrupted'
          ? 'Turn interrupted'
          : status === 'error'
            ? 'Turn ended with an error'
            : 'Turn complete';
      this.deps.emit('notify:needsAttention', { workspaceId, reason });
      this.deps.notifications.turnDone({
        workspaceId,
        workspaceName: live.workspaceName,
        status,
        reason,
      });
    }

    // Best-effort turn-end hook (Phase-4: checkpoint snapshot + diff recompute). Runs off
    // the finalize path — the hook does its own async work with its own error handling; the
    // supervisor only guards against a synchronous throw so the write chain never rejects.
    // The registry entry was already removed by the caller, so `isActive` stays false here.
    if (this.deps.onTurnEnd) {
      try {
        this.deps.onTurnEnd(workspaceId, live.turnId);
      } catch (err) {
        this.logHookError('onTurnEnd', workspaceId, err);
      }
    }
  }

  /** endTurn that never throws into the caller (used on the start-failure path). */
  private async safeEndTurn(turnId: string, status: TurnStatus): Promise<void> {
    try {
      await this.deps.recorder.endTurn(turnId, status);
    } catch (err) {
      logger.error(
        `[harness] failed to finalize turn ${turnId} after start failure: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private registryKey(workspaceId: string, contextId?: string): string {
    return `${workspaceId}\u0000${contextId ?? ''}`;
  }

  private hasWorkspaceActivity(workspaceId: string): boolean {
    for (const live of this.registry.values()) {
      if (live.workspaceId === workspaceId) return true;
    }
    for (const startingWorkspaceId of this.starting.values()) {
      if (startingWorkspaceId === workspaceId) return true;
    }
    return false;
  }

  private hasWorkspacePendingCompletion(workspaceId: string): boolean {
    return (
      this.hasWorkspaceActivity(workspaceId) ||
      (this.finalizingByWorkspace.get(workspaceId) ?? 0) > 0
    );
  }

  private beginFinalizing(workspaceId: string): void {
    this.finalizingByWorkspace.set(
      workspaceId,
      (this.finalizingByWorkspace.get(workspaceId) ?? 0) + 1,
    );
  }

  private endFinalizing(workspaceId: string): void {
    const remaining = (this.finalizingByWorkspace.get(workspaceId) ?? 1) - 1;
    if (remaining <= 0) this.finalizingByWorkspace.delete(workspaceId);
    else this.finalizingByWorkspace.set(workspaceId, remaining);
  }

  private assertAcceptingStarts(opts: StartTurnOpts): void {
    if (!this.shuttingDown) return;
    consumeKnowledgeTrace(opts.knowledgeTrace);
    throw new AppError('conflict', 'application shutdown is in progress');
  }

  private logRecordError(turnId: string, err: unknown): void {
    logger.error(
      `[harness] failed to record event for turn ${turnId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  private logFinalizeError(workspaceId: string, err: unknown): void {
    logger.error(
      `[harness] failed to finalize turn for workspace ${workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  /** A best-effort side-hook (`onTodoUpdate`/`onTurnEnd`) threw synchronously — never
   *  propagate it into the supervisor; log and move on. */
  private logHookError(
    hook: 'onTodoUpdate' | 'onTurnStart' | 'onTurnEnd',
    workspaceId: string,
    err: unknown,
  ): void {
    logger.error(
      `[harness] ${hook} hook failed for workspace ${workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
