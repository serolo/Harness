// TaskScheduler — the main-process service that fires per-workspace scheduled tasks
// (Phase 12, design doc §5.4). It owns a tick loop (default every 30s), boot-time
// reconciliation, busy→queued handling with a drain on turn-end, and turning a due task
// into a real agent turn THROUGH the existing `HarnessSupervisor`.
//
// LOAD-BEARING INVARIANTS:
//   - NEVER bypass the supervisor. `harness.startTurn` gives us persistence (TurnRecorder),
//     the workspace status machine, native notifications, and the checkpoint hook for free
//     (Findings §3.9). The scheduler only mirrors the turn's events to the reserved
//     `turn:event` broadcast and advances the task's own state row.
//   - `running`-before-`startTurn` write + a per-tick de-dupe + a `ticking` re-entrancy flag
//     prevent double-fires; a supervisor `conflict` (a user turn raced us) re-queues.
//   - `missed` is assigned ONLY at boot reconciliation (repo.reconcileOnBoot). A late tick
//     while the app is running (laptop sleep/wake) still fires the task.
//   - The resume mechanism is `latestSessionId(workspaceId)` → `opts.sessionId`: a fired
//     turn continues the workspace's last harness session, which is the whole "resume when
//     the limit resets" behaviour — no extra work.

import type { AgentEvent, StartTurnOpts } from '@shared/harness';
import type { EventChannel, EventPayload, StreamSink } from '@shared/ipc';
import type { EffectiveSettings } from '@shared/settings';
import type { ScheduledTask } from '@shared/tasks';
import type { Workspace } from '@shared/models';
import { AppError } from '@shared/errors';
import { logger } from '../logging';
import type { HarnessSupervisor } from '../harness/supervisor';
import type { ScheduledTasksRepo } from '../db/repos/tasks';

/** Default tick cadence — timestamp-compared so a task due during sleep fires on wake. */
const DEFAULT_TICK_INTERVAL_MS = 30_000;

/** Injected collaborators (all narrowed to just what the scheduler needs, for testability). */
export interface TaskSchedulerDeps {
  repo: ScheduledTasksRepo;
  harness: Pick<
    HarnessSupervisor,
    'startTurn' | 'isActive' | 'getActiveTurnId'
  >;
  /** Resolve a workspace (to pick its worktree + harness). */
  getWorkspace: (id: string) => Promise<Workspace | null>;
  /** Read-only settings snapshot (mode/mcp/permissionPolicy defaults). */
  settings: { get: () => EffectiveSettings };
  /** The workspace's last captured harness session id — this IS the resume mechanism. */
  latestSessionId: (workspaceId: string) => Promise<string | undefined>;
  /** Broadcast a typed event to the renderer(s). */
  emit: <K extends EventChannel>(event: K, payload: EventPayload<K>) => void;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Tick cadence override for tests. Defaults to 30s. */
  tickIntervalMs?: number;
}

export class TaskScheduler {
  private readonly deps: TaskSchedulerDeps;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Re-entrancy guard so a slow tick can't overlap the next interval fire. */
  private ticking = false;

  constructor(deps: TaskSchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  /**
   * Reconcile boot-time state (overdue/queued → missed; stale running → done/error),
   * emit a `task:changed` per affected workspace, run one immediate tick, then start the
   * interval. Safe to call once on `whenReady`.
   */
  async start(): Promise<void> {
    try {
      const affected = await this.deps.repo.reconcileOnBoot(this.now());
      for (const workspaceId of affected) {
        this.deps.emit('task:changed', { workspaceId });
      }
    } catch (err) {
      logger.error(`[scheduler] boot reconcile failed: ${errText(err)}`);
    }
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
  }

  /** Stop the tick loop. Idempotent. In-flight turns are the supervisor's to tear down. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Drain hook fired from the supervisor's `onTurnEnd` (via `src/main/index.ts`). Starts
   * the oldest `queued` task for the workspace — its own turn-end drains the next, so the
   * queue empties one-per-turn-end (FIFO). Fire-and-forget with its own error handling so
   * a drain failure can never wedge the finalize path.
   */
  onWorkspaceTurnEnd(workspaceId: string): void {
    void (async () => {
      const next = await this.deps.repo.nextQueued(workspaceId);
      if (next) {
        await this.runTask(next);
      }
    })().catch((err) => {
      logger.error(
        `[scheduler] drain for ${workspaceId} failed: ${errText(err)}`,
      );
    });
  }

  /**
   * Fire a task immediately (queues if the workspace is busy). Shared by the `task:runNow`
   * IPC handler; returns the task's fresh state after the operation.
   */
  async runNow(id: string): Promise<ScheduledTask> {
    const task = await this.deps.repo.get(id);
    await this.fireOrQueue(task);
    return this.deps.repo.get(id);
  }

  /**
   * One tick: fire (or queue) every due `scheduled` task. Re-entrancy-guarded. Within a
   * single tick a workspace fires AT MOST ONCE — later due tasks for the same workspace are
   * queued (the fired turn's end drains them), which also sidesteps the concurrent-start
   * race on the supervisor registry.
   */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.deps.repo.listDue(this.now());
      const firedThisTick = new Set<string>();
      for (const task of due) {
        if (
          this.deps.harness.isActive(task.workspaceId) ||
          firedThisTick.has(task.workspaceId)
        ) {
          await this.deps.repo.setState(task.id, 'queued');
          this.deps.emit('task:changed', { workspaceId: task.workspaceId });
        } else {
          firedThisTick.add(task.workspaceId);
          void this.runTask(task).catch((err) => {
            logger.error(
              `[scheduler] runTask ${task.id} failed: ${errText(err)}`,
            );
          });
        }
      }
    } catch (err) {
      logger.error(`[scheduler] tick failed: ${errText(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Queue when busy, else run. */
  private async fireOrQueue(task: ScheduledTask): Promise<void> {
    if (this.deps.harness.isActive(task.workspaceId)) {
      await this.deps.repo.setState(task.id, 'queued');
      this.deps.emit('task:changed', { workspaceId: task.workspaceId });
    } else {
      await this.runTask(task);
    }
  }

  /**
   * Turn one task into an agent turn through the supervisor (mirrors the `turn:start`
   * producer, register.ts:322-399, minus the scoped stream). Sets `running` BEFORE starting
   * (double-fire guard), resolves opts the same way the producer does (including the resume
   * `sessionId`), buffers sink events until the turnId is known, then mirrors each as a
   * `turn:event` broadcast. Terminal events advance the task row; a `conflict` re-queues.
   */
  private async runTask(task: ScheduledTask): Promise<void> {
    const { repo, harness, emit } = this.deps;
    const workspaceId = task.workspaceId;

    // 1) running-before-start (double-fire guard) + clear any stale error.
    await repo.setState(task.id, 'running', { errorMessage: null });
    emit('task:changed', { workspaceId });

    // 2) resolve the workspace; missing/archived → error.
    const workspace = await this.deps.getWorkspace(workspaceId);
    if (!workspace || !workspace.worktreePath) {
      await repo.setState(task.id, 'error', {
        errorMessage: 'workspace unavailable (archived?)',
      });
      emit('task:changed', { workspaceId });
      return;
    }

    // 3) build StartTurnOpts exactly like the producer (settings + resume sessionId).
    const settings = this.deps.settings.get();
    const sessionId = await this.deps.latestSessionId(workspaceId);
    const opts: StartTurnOpts = {
      workspaceDir: workspace.worktreePath,
      prompt: task.prompt,
      attachments: [],
      sessionId,
      mode: task.mode ?? settings.agent.mode,
      mcpConfig: settings.mcp,
      permissionPolicy: settings.agent.permissionPolicy,
      model: task.model ?? undefined,
    };

    // 4) sink: buffer events until the turnId is known, then mirror each as `turn:event`.
    let turnId: string | undefined;
    let terminalHandled = false;
    let pendingTerminal: AgentEvent | undefined;
    const buffered: AgentEvent[] = [];

    const mirror = (event: AgentEvent): void => {
      if (turnId !== undefined) {
        emit('turn:event', { workspaceId, turnId, event });
      } else {
        buffered.push(event);
      }
    };
    const flush = (): void => {
      if (turnId === undefined) return;
      for (const event of buffered) {
        emit('turn:event', { workspaceId, turnId, event });
      }
      buffered.length = 0;
    };
    const applyTerminal = async (event: AgentEvent): Promise<void> => {
      if (terminalHandled) return;
      terminalHandled = true;
      if (event.kind === 'turn_end') {
        await repo.setState(task.id, 'done', turnId ? { turnId } : {});
      } else if (event.kind === 'error') {
        await repo.setState(task.id, 'error', {
          ...(turnId ? { turnId } : {}),
          errorMessage: event.message,
        });
      }
      emit('task:changed', { workspaceId });
    };

    const sink: StreamSink<AgentEvent> = {
      push: (event) => {
        mirror(event);
        if (event.kind === 'turn_end' || event.kind === 'error') {
          if (turnId === undefined) {
            pendingTerminal = event; // defer until we know the turnId
          } else {
            void applyTerminal(event).catch((err) =>
              logger.error(
                `[scheduler] terminal for ${task.id} failed: ${errText(err)}`,
              ),
            );
          }
        }
      },
      end: () => {
        /* the supervisor owns turn persistence; nothing to flush here */
      },
      error: (e) => {
        const event: AgentEvent = { kind: 'error', message: e.message };
        mirror(event);
        if (turnId === undefined) {
          pendingTerminal = event;
        } else {
          void applyTerminal(event).catch((err) =>
            logger.error(
              `[scheduler] terminal(error) for ${task.id} failed: ${errText(err)}`,
            ),
          );
        }
      },
    };

    // 5) start the turn through the supervisor; conflict → re-queue; other throw → error.
    try {
      await harness.startTurn(workspaceId, opts, sink);
      turnId = harness.getActiveTurnId(workspaceId) ?? undefined;
      if (turnId !== undefined && !terminalHandled) {
        // Record the turn id so boot reconcile can join it; state stays `running`.
        await repo.setState(task.id, 'running', { turnId });
      }
      flush();
      if (pendingTerminal !== undefined) {
        await applyTerminal(pendingTerminal);
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'conflict') {
        await repo.setState(task.id, 'queued');
      } else {
        await repo.setState(task.id, 'error', {
          errorMessage:
            err instanceof Error ? err.message : 'failed to start turn',
        });
      }
      emit('task:changed', { workspaceId });
    }
  }
}

/** Secret-free error text for logs. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
