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
  StartTurnOpts,
  SteerableTurnHandle,
  SteerResult,
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

/** One in-flight turn. Cleared from the registry the instant a terminal event lands. */
interface LiveTurn {
  turnId: string;
  handle?: TurnHandle;
  /** Set when the user (or quit) requested an interrupt — maps the terminal to `interrupted`. */
  interrupted: boolean;
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
  /** Fired at the end of finalize (after status flip) so Phase-4 can snapshot a checkpoint +
   *  recompute the diff off the finalize path (best-effort — must not throw). */
  onTurnEnd?: (workspaceId: string, turnId: string) => void;
}

export class HarnessSupervisor {
  private readonly adapters = new Map<HarnessId, Harness>();
  private readonly registry = new Map<string, LiveTurn>();
  private readonly deps: HarnessSupervisorDeps;

  constructor(deps: HarnessSupervisorDeps) {
    this.deps = deps;
  }

  /** Register a harness adapter so it can be selected by `id`. */
  register(harness: Harness): void {
    this.adapters.set(harness.id, harness);
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
    if (this.registry.has(workspaceId)) {
      throw new AppError(
        'conflict',
        'a turn is already active for this workspace',
        { workspaceId },
      );
    }

    const workspace = await this.deps.getWorkspace(workspaceId);
    if (!workspace) {
      throw new AppError('not_found', 'workspace not found', { workspaceId });
    }
    const harnessId = harnessOverride ?? workspace.harness;
    const adapter = this.adapters.get(harnessId);
    if (!adapter) {
      throw new AppError(
        'harness',
        `no harness registered for id "${harnessId}"`,
        { workspaceId, harness: harnessId },
      );
    }

    const turnId = await this.deps.recorder.beginTurn(workspaceId, {
      sessionId: opts.sessionId,
      mode: opts.mode,
    });

    const live: LiveTurn = {
      turnId,
      interrupted: false,
      workspaceName: workspace.name,
      writeChain: Promise.resolve(),
    };
    // Register + flip to `working` BEFORE the adapter can emit, so a terminal event
    // (which flips to needs_attention) can never be overtaken by a late `working`.
    this.registry.set(workspaceId, live);
    await this.deps.setStatus(workspaceId, 'working');

    // The sink the adapter pushes into: forward to the renderer, then enqueue the
    // persistence/finalize step on the per-turn write chain (order-preserving).
    const wrapped: StreamSink<AgentEvent> = {
      push: (event) => {
        sink.push(event);
        const current = this.registry.get(workspaceId);
        if (!current || current !== live) return; // already finalized
        if (event.kind === 'turn_end' || event.kind === 'error') {
          // Restore the single-turn invariant immediately (before async finalize).
          this.registry.delete(workspaceId);
          live.writeChain = live.writeChain
            .then(() => this.finalize(workspaceId, live, event))
            .catch((err) => this.logFinalizeError(workspaceId, err));
        } else {
          // Best-effort side-hook: persist the agent's current todo set. Fired inline
          // (synchronously) and guarded so a hook failure can never wedge the write chain
          // or the turn. Event RECORDING below is unchanged.
          if (event.kind === 'todo_update' && this.deps.onTodoUpdate) {
            try {
              this.deps.onTodoUpdate(workspaceId, event.todos);
            } catch (err) {
              this.logHookError('onTodoUpdate', workspaceId, err);
            }
          }
          live.writeChain = live.writeChain
            .then(() => this.deps.recorder.record(turnId, event))
            .catch((err) => this.logRecordError(turnId, err));
        }
      },
      end: () => sink.end(),
      error: (e) => {
        // Adapter-level stream failure: ensure the turn is finalized as an error.
        const current = this.registry.get(workspaceId);
        if (current === live) {
          this.registry.delete(workspaceId);
          live.writeChain = live.writeChain
            .then(() =>
              this.finalize(workspaceId, live, {
                kind: 'error',
                message: e.message,
              }),
            )
            .catch((err) => this.logFinalizeError(workspaceId, err));
        }
        sink.error(e);
      },
    };

    let handle: TurnHandle;
    try {
      handle = await adapter.startTurn(opts, wrapped);
    } catch (err) {
      // Spawn/start failure before any event: finalize as an error and clear.
      this.registry.delete(workspaceId);
      await this.safeEndTurn(turnId, 'error');
      await this.deps.setStatus(workspaceId, 'needs_attention');
      throw err instanceof AppError
        ? err
        : new AppError(
            'harness',
            err instanceof Error ? err.message : 'failed to start turn',
          );
    }

    // The handle may reference an already-finalized turn (instant turns) — still record
    // the captured session id so the NEXT turn can `--resume` it.
    live.handle = handle;
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
    if (live.handle) {
      await live.handle.interrupt();
    }
  }

  /**
   * Inject text into the live turn for a workspace (TRUE mid-turn injection). Throws a
   * typed `AppError('conflict')` — never a silent no-op — when no turn is active OR the
   * live handle does not implement `steer` (duck-typed). The interrupt+resend FALLBACK is
   * the renderer's job (§3.6), keeping main free of an auto-start-a-turn path. A successful
   * `steer` pushes into the SAME live sink the open turn:start stream is on — no new stream.
   */
  async steer(workspaceId: string, text: string): Promise<SteerResult> {
    const live = this.registry.get(workspaceId);
    if (!live || !live.handle) {
      throw new AppError('conflict', 'no active turn to steer', {
        workspaceId,
      });
    }
    if (!('steer' in live.handle)) {
      throw new AppError(
        'conflict',
        'active turn does not support mid-turn steer',
        { workspaceId },
      );
    }
    return (live.handle as SteerableTurnHandle).steer(text);
  }

  /** True when a turn is currently streaming for the workspace. */
  isActive(workspaceId: string): boolean {
    return this.registry.has(workspaceId);
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
        if (t.handle) await t.handle.interrupt();
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
    hook: 'onTodoUpdate' | 'onTurnEnd',
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
