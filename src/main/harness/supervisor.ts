// HarnessSupervisor — owns live agent turns keyed by `workspaceId`, enforces AT MOST
// ONE active turn per workspace, drives the workspace status machine through the turn
// lifecycle, and routes interrupt/quit (README §6.3). Adapters (`claude-code.ts`,
// `mock.ts`, later `codex`/`cursor`) implement the frozen `Harness` interface.
//
// FROZEN: the public method signatures (`register`, `detect`, `startTurn`, `interrupt`,
// `isActive`, `quitAll`) are frozen for Phase 7's other adapters — bodies are filled
// here in Phase 2 but the shapes must not change. `getActiveTurnId` is an additive
// main-only helper the IPC producer uses to frame the `turn:start` stream.
//
// HEIGHTENED SCRUTINY (process lifecycle): the single-turn invariant is load-bearing —
// the registry entry is cleared on EVERY terminal path (turn_end / error / interrupt /
// synthesized-on-exit) BEFORE the async finalize runs, so a crash mid-finalize can
// never wedge a workspace "busy" forever. Status changes go ONLY through the injected
// `setStatus` (never a direct DB write). Per-turn DB writes are serialized on a promise
// chain so event order is preserved even though `sink.push` is a synchronous callback.
//
// INTEGRATION(phase-3): agent children are tracked in this supervisor's own registry;
// fold them into the shared `ProcessRegistry` when Phase 3 implements it (Risk R2).

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
  turnId: string;
  handle?: TurnHandle;
  /** Set when the user (or quit) requested an interrupt — maps the terminal to `interrupted`. */
  interrupted: boolean;
  /** True once the provider handle has received the interrupt request. */
  interruptDelivered: boolean;
  /** Workspace name captured for secret-free notifications. */
  workspaceName?: string;
  /** Serializes per-turn persistence so event order is preserved. */
  writeChain: Promise<void>;
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
}

export class HarnessSupervisor {
  private readonly adapters = new Map<HarnessId, Harness>();
  private readonly registry = new Map<string, LiveTurn>();
  private readonly starting = new Set<string>();
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
    const discardKnowledge = (): void => {
      consumeKnowledgeTrace(opts.knowledgeTrace);
    };
    if (this.registry.has(workspaceId) || this.starting.has(workspaceId)) {
      discardKnowledge();
      throw new AppError(
        'conflict',
        'a turn is already active for this workspace',
        { workspaceId },
      );
    }
    // Guard and reservation are synchronous: no ordinary IPC/scheduler turn can slip
    // through between a claim check and the first awaited persistence operation.
    try {
      this.workspaceClaimGuard?.(workspaceId, opts.metaRunId);
    } catch (error) {
      discardKnowledge();
      throw error;
    }
    this.starting.add(workspaceId);

    let workspace: Workspace | null;
    try {
      workspace = await this.deps.getWorkspace(workspaceId);
    } catch (error) {
      this.starting.delete(workspaceId);
      discardKnowledge();
      throw error;
    }
    if (!workspace) {
      this.starting.delete(workspaceId);
      discardKnowledge();
      throw new AppError('not_found', 'workspace not found', { workspaceId });
    }
    const harnessId = harnessOverride ?? workspace.harness;
    const adapter = this.adapters.get(harnessId);
    if (!adapter) {
      this.starting.delete(workspaceId);
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
        contextId: opts.contextId,
      });
    } catch (error) {
      this.starting.delete(workspaceId);
      discardKnowledge();
      throw error;
    }

    const live: LiveTurn = {
      turnId,
      interrupted: false,
      interruptDelivered: false,
      workspaceName: workspace.name,
      writeChain: Promise.resolve(),
    };
    // Register + flip to `working` BEFORE the adapter can emit, so a terminal event
    // (which flips to needs_attention) can never be overtaken by a late `working`.
    this.registry.set(workspaceId, live);
    this.starting.delete(workspaceId);
    try {
      await this.deps.setStatus(workspaceId, 'working');
    } catch (error) {
      this.registry.delete(workspaceId);
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
        if (event.kind === 'turn_end' || event.kind === 'error') {
          for (const traceEvent of closeKnowledge()) {
            wrapped.push(traceEvent);
          }
        }

        const safeEvent: AgentEvent =
          event.kind === 'error'
            ? { ...event, message: sanitizeErrorMessage(event.message) }
            : event;
        // Provider metadata belongs in persistence, not in the visible transcript.
        if (safeEvent.kind !== 'model_info') {
          sink.push(safeEvent);
        }
        const current = this.registry.get(workspaceId);
        if (!current || current !== live) return; // already finalized
        if (safeEvent.kind === 'turn_end' || safeEvent.kind === 'error') {
          // Restore the single-turn invariant immediately (before async finalize).
          this.registry.delete(workspaceId);
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
        // Adapter-level stream failure: ensure the turn is finalized as an error.
        const safeMessage = sanitizeErrorMessage(e);
        for (const traceEvent of closeKnowledge()) {
          wrapped.push(traceEvent);
        }
        const current = this.registry.get(workspaceId);
        if (current === live) {
          this.registry.delete(workspaceId);
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
      handle = await adapter.startTurn(opts, wrapped);
    } catch (err) {
      for (const traceEvent of closeKnowledge()) {
        live.writeChain = live.writeChain.then(() =>
          this.deps.recorder.record(turnId, traceEvent),
        );
      }
      await live.writeChain;
      // Spawn/start failure before any event: finalize as an error and clear.
      this.registry.delete(workspaceId);
      await this.safeEndTurn(turnId, 'error');
      await this.deps.setStatus(workspaceId, 'needs_attention');
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
    // An interrupt can arrive while the adapter is still starting. Remembering only the
    // flag is insufficient: once the handle exists, immediately deliver the pending
    // interrupt so a late-spawning child cannot outlive its deadline or cancellation.
    if (live.interrupted && !live.interruptDelivered) {
      live.interruptDelivered = true;
      await handle.interrupt();
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
    const live = this.registry.get(workspaceId);
    if (!live) return;
    live.interrupted = true;
    if (live.handle && !live.interruptDelivered) {
      live.interruptDelivered = true;
      await live.handle.interrupt();
    }
  }

  /** True when a turn is currently streaming for the workspace. */
  isActive(workspaceId: string): boolean {
    return this.registry.has(workspaceId) || this.starting.has(workspaceId);
  }

  /** The active turn id for a workspace, or undefined — used to frame the stream. */
  getActiveTurnId(workspaceId: string): string | undefined {
    return this.registry.get(workspaceId)?.turnId;
  }

  /**
   * Interrupt every active turn (SIGINT each child) on app quit. Best-effort: the app
   * is going away, so we don't wait for clean terminal events.
   */
  async quitAll(): Promise<void> {
    const live = [...this.registry.values()];
    this.registry.clear();
    await Promise.allSettled(
      live.map(async (t) => {
        t.interrupted = true;
        if (t.handle && !t.interruptDelivered) {
          t.interruptDelivered = true;
          await t.handle.interrupt();
        }
      }),
    );
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

    // Preserve an error message in the transcript (turn_end usage → the turn row).
    if (terminal.kind === 'error' && !live.interrupted) {
      await this.deps.recorder.record(live.turnId, terminal);
    }
    const usage = terminal.kind === 'turn_end' ? terminal.usage : undefined;
    await this.deps.recorder.endTurn(live.turnId, status, usage);

    await this.deps.setStatus(workspaceId, 'needs_attention');

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
