// ProcessRegistry + ProcessRunner — named run scripts run as child processes (spec
// §5.2), tracked in ONE central registry so archive + app-quit can tear every process
// tree down (README §7.4: SIGTERM→SIGKILL via `tree-kill`). The registry is shared with
// `PtyService` (terminals) so a single teardown covers runs AND terminals.
//
// DESIGN (phase-3 plan, decisions 2/3/6):
//   - The registry is handle-based and transport-agnostic: each owner supplies its own
//     `stop()` closure (a run → `treeKillEscalate(pid)`; a PTY → `pty.kill()`), so the
//     registry never needs to know how a child dies.
//   - Teardown is idempotent + best-effort: `stop*` clear the map entry BEFORE awaiting
//     the async `stop()` (mirrors `HarnessSupervisor`'s clear-before-async), and use
//     `Promise.allSettled` so one throwing `stop()` cannot abort its siblings.
//
// SECURITY (heightened scrutiny — process execution): commands run via `execa` with
// `shell: true` (compound `[scripts].run` commands, mirroring `workspace/setup.ts`).
// The command comes from the user's OWN settings; workspace-derived values
// (worktreePath/name/port) flow only as `cwd`/`env`, never interpolated into the string.

import { execa } from 'execa';
import { v7 as uuidv7 } from 'uuid';

import type { WorkspaceStatus } from '@shared/models';
import { logger } from '../logging';
import { treeKillEscalate } from './kill';

/**
 * One tracked child process. The registry only needs an id, its owning workspace, a
 * kind (for diagnostics/filtering), an optional pid, and a `stop()` that terminates it
 * and resolves once gone. Owners (`ProcessRunner`, `PtyService`) construct these.
 */
export interface ProcessHandle {
  /** Allocated id (runId / ptyId) — unique across the registry. */
  id: string;
  /** Workspace this process belongs to (drives `stopWorkspace` + the running overlay). */
  workspaceId: string;
  /** What kind of child this is (run script, terminal, setup step, agent turn). */
  kind: 'pty' | 'run' | 'setup' | 'agent';
  /** OS pid, when known (root of the tree `treeKillEscalate` targets). */
  pid?: number;
  /** Terminate this process (and its tree); resolves once it is gone. Best-effort. */
  stop(): Promise<void>;
}

/**
 * A named script to run (spec §5.2 — `[scripts].run` buttons). Built by the `run:start`
 * IPC producer from settings + the resolved workspace; passed to {@link ProcessRunner.start}.
 */
export interface ProcessSpec {
  /** Workspace this process belongs to (drives the `running` status overlay). */
  workspaceId: string;
  /** Script name (the `[scripts].run` key) — also the `run:list` identity. */
  name: string;
  /** Combined shell command to execute (run via `execa` with `shell: true`). */
  command: string;
  /** Working directory — the workspace worktree path. */
  cwd: string;
  /** Extra environment (from {@link buildEnv}: PORT/APP_PORT + workspace vars). */
  env?: Record<string, string>;
  /**
   * `run_mode` for the workspace. `single` stops the workspace's other runs before
   * starting (so a re-run reclaims the dev-server port); `concurrent` lets them coexist.
   */
  mode?: 'single' | 'concurrent';
}

/**
 * Callbacks the `run:start` producer supplies to {@link ProcessRunner.start}. The runner
 * stays transport-agnostic — it deals in strings + an exit tuple; the producer maps them
 * onto the typed `RunStreamChunk` frames (`log` / `exit`) and ends the scoped stream.
 */
export interface RunHandlers {
  /** Combined stdout+stderr chunk (UTF-8) as it arrives. */
  onLog: (chunk: string) => void;
  /**
   * Terminal callback — fired exactly once when the run exits (naturally, by crash, or
   * by `stop`). `code` is the exit code, or `null` when the tree was killed by signal.
   */
  onExit: (code: number | null, durationMs: number) => void;
}

/** One live run, tracked for `run:list`, `run_mode`, and the running overlay. */
interface LiveRun {
  runId: string;
  workspaceId: string;
  scriptName: string;
  /** Root pid of the child tree (undefined only if the spawn never got a pid). */
  pid: number | undefined;
  startedAt: number;
  /** Guards {@link ProcessRunner.finalize} so the terminal path runs exactly once. */
  finalized: boolean;
  onExit: RunHandlers['onExit'];
}

/** A run's identity for `run:list` cross-referencing (which script is running + its id). */
export interface RunningRunInfo {
  runId: string;
  scriptName: string;
}

/**
 * Tracks every live child process for tree-kill on archive/quit (README §7.4). A single
 * instance is shared via `AppContext` — owned by {@link ProcessRunner} (`.registry`) and
 * also registered into by `PtyService`, so one teardown covers runs AND terminals.
 */
export class ProcessRegistry {
  private readonly handles = new Map<string, ProcessHandle>();

  /** Record a started process. */
  register(handle: ProcessHandle): void {
    this.handles.set(handle.id, handle);
  }

  /** Forget a process that has exited (or is being stopped individually). Idempotent. */
  unregister(id: string): void {
    this.handles.delete(id);
  }

  /** All currently-tracked processes (optionally filtered by workspace). */
  list(workspaceId?: string): ProcessHandle[] {
    const all = [...this.handles.values()];
    return workspaceId === undefined
      ? all
      : all.filter((h) => h.workspaceId === workspaceId);
  }

  /**
   * Stop one process by id. Clears the entry BEFORE awaiting `stop()` (clear-before-async)
   * so a concurrent `stopWorkspace`/`killAll` cannot double-stop it. No-op if unknown.
   */
  async stop(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) return;
    this.handles.delete(id);
    await handle.stop();
  }

  /**
   * Stop every process for a workspace BEFORE its worktree is force-removed (archive,
   * phase doc §8) — so no child holds the worktree open. Best-effort: `allSettled` means
   * one throwing `stop()` cannot abort teardown of the workspace's other processes.
   */
  async stopWorkspace(workspaceId: string): Promise<void> {
    const targets = this.list(workspaceId);
    for (const h of targets) this.handles.delete(h.id);
    const results = await Promise.allSettled(targets.map((h) => h.stop()));
    this.logRejections('stopWorkspace', results);
  }

  /**
   * Tree-kill every tracked process (SIGTERM→SIGKILL escalation, README §7.4). Called from
   * `before-quit` after agent turns are interrupted. Best-effort + idempotent.
   */
  async killAll(): Promise<void> {
    const targets = [...this.handles.values()];
    this.handles.clear();
    const results = await Promise.allSettled(targets.map((h) => h.stop()));
    this.logRejections('killAll', results);
  }

  /** Log any best-effort teardown failures without letting them surface to the caller. */
  private logRejections(
    op: string,
    results: PromiseSettledResult<void>[],
  ): void {
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.error(
          `[process] ${op}: a stop() failed: ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }`,
        );
      }
    }
  }
}

/**
 * Starts/stops named run scripts, streaming their combined stdout/stderr through the
 * caller's {@link RunHandlers}, and registering each child in the shared
 * {@link ProcessRegistry}. Owns the workspace `running` overlay: it flips a workspace to
 * `running` when its FIRST run starts and back to `idle` when its LAST run stops — via
 * the injected `setStatus` hook (never a direct DB write). Constructed in
 * `src/main/index.ts`.
 */
export class ProcessRunner {
  /** Live runs keyed by runId (independent of the registry's handle map). */
  private readonly runs = new Map<string, LiveRun>();

  /**
   * @param registry  - The shared registry (also exposed for AppContext/quit teardown).
   * @param setStatus - The SOLE workspace-status writer (`WorkspaceManager.setStatus`);
   *   the runner asks it to set `running`/`idle` for the overlay — it never writes status
   *   directly (mirrors `HarnessSupervisor`'s injected `setStatus`).
   */
  constructor(
    public readonly registry: ProcessRegistry,
    private readonly setStatus: (
      id: string,
      status: WorkspaceStatus,
    ) => Promise<void>,
    private readonly getStatus: (
      id: string,
    ) => Promise<WorkspaceStatus | null> = async () => null,
  ) {}

  /**
   * Start a run script, streaming logs through `handlers`. In `single` mode the
   * workspace's other runs are stopped first (awaited, so a shared dev-server port is
   * freed before the new child binds it). Registers the child for tree-kill and, if it is
   * the workspace's first live run, flips the workspace to `running`.
   *
   * @returns the allocated `runId` (used by {@link stop} + the `run:stop` command).
   */
  async start(spec: ProcessSpec, handlers: RunHandlers): Promise<string> {
    // `single` mode replaces: stop the workspace's other runs BEFORE spawning so the new
    // child can reclaim the port. Awaited — escalation may take up to the grace period.
    if (spec.mode === 'single') {
      await this.stopWorkspaceRuns(spec.workspaceId);
    }

    const runId = uuidv7();
    const startedAt = Date.now();
    // First live run for this workspace? (checked before we insert the new one.)
    const wasIdle = this.runsFor(spec.workspaceId).length === 0;

    // shell:true + reject:false + all:true mirror `workspace/setup.ts`: compound commands
    // work, a non-zero exit resolves (surfaced as the exit code, not a throw), and stdout
    // and stderr are combined into one ordered `all` stream.
    const cp = execa(spec.command, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      shell: true,
      reject: false,
      all: true,
    });

    const live: LiveRun = {
      runId,
      workspaceId: spec.workspaceId,
      scriptName: spec.name,
      pid: cp.pid,
      startedAt,
      finalized: false,
      onExit: handlers.onExit,
    };
    this.runs.set(runId, live);
    this.registry.register({
      id: runId,
      workspaceId: spec.workspaceId,
      kind: 'run',
      pid: cp.pid,
      stop: () => this.stop(runId),
    });

    // Overlay: workspace's first run → `running`.
    if (wasIdle) {
      void this.setRunningIfIdle(spec.workspaceId).catch((err) =>
        this.logStatusError(spec.workspaceId, err),
      );
    }

    // Stream combined output live to the caller's sink.
    cp.all?.on('data', (b: Buffer) => handlers.onLog(b.toString()));

    // Finalize on natural exit (resolve = clean/non-zero exit; reject = spawn/other error).
    // Routed through the SAME finalize path as `stop`, so the exit frame + overlay-clear
    // happen exactly once even if the process crashes.
    void cp.then(
      (result) => this.finalize(runId, result.exitCode ?? null),
      () => this.finalize(runId, null),
    );

    return runId;
  }

  /**
   * Stop a running script by id — tree-kill (SIGTERM→SIGKILL) its whole process group,
   * then finalize. Resolves once the tree has exited. No-op if the run is already gone.
   */
  async stop(runId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (!live) return;
    if (live.pid !== undefined) {
      await treeKillEscalate(live.pid);
    }
    // Ensure finalize runs even if the `cp.then` handler has not fired yet (killed ⇒ null
    // exit code). If it already ran, this is a guarded no-op.
    this.finalize(runId, null);
  }

  /** Which of a workspace's configured scripts are currently running (for `run:list`). */
  listRunning(workspaceId: string): RunningRunInfo[] {
    return this.runsFor(workspaceId).map((r) => ({
      runId: r.runId,
      scriptName: r.scriptName,
    }));
  }

  /** All live runs for a workspace. */
  private runsFor(workspaceId: string): LiveRun[] {
    return [...this.runs.values()].filter((r) => r.workspaceId === workspaceId);
  }

  /** Stop every live run for a workspace (used by `single`-mode replace). Best-effort. */
  private async stopWorkspaceRuns(workspaceId: string): Promise<void> {
    const targets = this.runsFor(workspaceId);
    await Promise.allSettled(targets.map((r) => this.stop(r.runId)));
  }

  /**
   * Terminal path for one run — runs EXACTLY once (guarded by `finalized`). Drops the run
   * from tracking + the registry, fires the caller's `onExit` (exit frame + stream end),
   * and clears the workspace's `running` overlay when it was the last live run.
   */
  private finalize(runId: string, code: number | null): void {
    const live = this.runs.get(runId);
    if (!live || live.finalized) return;
    live.finalized = true;
    this.runs.delete(runId);
    this.registry.unregister(runId);

    const durationMs = Date.now() - live.startedAt;
    try {
      live.onExit(code, durationMs);
    } catch (err) {
      logger.error(
        `[process] onExit handler threw for run ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Overlay: workspace's last run stopped → back to `idle`.
    if (this.runsFor(live.workspaceId).length === 0) {
      void this.clearRunningIfCurrent(live.workspaceId).catch((err) =>
        this.logStatusError(live.workspaceId, err),
      );
    }
  }

  /** Apply the run overlay only when no higher-priority status is present. */
  private async setRunningIfIdle(workspaceId: string): Promise<void> {
    const status = await this.getStatus(workspaceId);
    if (status === null || status === 'idle') {
      await this.setStatus(workspaceId, 'running');
    }
  }

  /** Clear only the run overlay we own; preserve agent/check attention states. */
  private async clearRunningIfCurrent(workspaceId: string): Promise<void> {
    const status = await this.getStatus(workspaceId);
    if (status === null || status === 'running') {
      await this.setStatus(workspaceId, 'idle');
    }
  }

  private logStatusError(workspaceId: string, err: unknown): void {
    logger.error(
      `[process] failed to set run overlay status for workspace ${workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
