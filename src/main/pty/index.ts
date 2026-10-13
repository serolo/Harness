// PtyService — one node-pty process per terminal tab, rendered by xterm.js
// (spec §5.2). Output streams to the renderer over the scoped `pty:open` stream
// (decision 1); input/resize/close flow back through the keyed `pty:*` commands.
//
// node-pty is a NATIVE module. It is loaded via a dynamic `import('node-pty')`
// LOCAL to `spawn` (cached), so it never enters this module's static type graph —
// callers importing `PtyService`'s TYPES don't drag the native binding into their
// runtime. Its option/process types are declared INLINE below rather than imported.
// Needs `electron-rebuild` (`npm run rebuild`) on ABI mismatch.
//
// SECURITY (heightened scrutiny — process execution): the shell + args are passed
// to node-pty as an ARGUMENT ARRAY (never a shell string); `cwd` is the workspace
// worktree; workspace-derived values flow only as `cwd`/`env`. Every spawn REGISTERS
// a handle in the shared ProcessRegistry and every exit/kill DEREGISTERS it — a leaked
// PTY would survive window close (README §7.4).

import { v7 as uuidv7 } from 'uuid';

import type { StreamSink } from '@shared/ipc';
import { logger } from '../logging';
import type { ProcessRegistry } from '../process';
import { childProcessEnv } from '../process/childEnv';
import { treeKillEscalate, treeKillForce } from '../process/kill';
import { defaultTerminalShell } from '../process/platform';

/** Options for spawning a PTY (spec §5.2 — env includes PORT/APP_PORT + ws vars). */
export interface PtySpawnOptions {
  /** Workspace this terminal belongs to (drives registry `stopWorkspace`). */
  workspaceId: string;
  /** Working directory — the workspace worktree path. */
  cwd: string;
  /** Shell/command to launch (defaults to the user's login shell). */
  shell?: string;
  /** Arguments passed to the shell/command (an ARRAY — never a shell string). */
  args?: string[];
  /** Extra environment merged over the inherited env (PORT, APP_PORT, ws vars). */
  env?: Record<string, string>;
  /** Initial terminal dimensions. */
  cols?: number;
  rows?: number;
}

/** A chunk of PTY output streamed to the renderer (mapped to a `pty:data` frame). */
export interface PtyChunk {
  ptyId: string;
  data: string;
}

// --- node-pty inline types (native module kept OUT of the static type graph) ---

/** The subset of node-pty's `IPty` this service uses. */
interface IPtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** The subset of node-pty's module surface this service uses. */
interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cwd?: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
    },
  ): IPtyProcess;
}

/** Cached lazy load of the native module (dynamic import kept local to spawn). */
let nodePtyPromise: Promise<NodePtyModule> | undefined;
function loadNodePty(): Promise<NodePtyModule> {
  if (nodePtyPromise === undefined) {
    nodePtyPromise = import('node-pty').then(
      (m) =>
        (m as unknown as { default?: NodePtyModule }).default ??
        (m as unknown as NodePtyModule),
    );
  }
  return nodePtyPromise;
}

/**
 * Owns node-pty processes keyed by an allocated `ptyId`. Constructed in
 * `src/main/index.ts` with the shared {@link ProcessRegistry}; registers each child so
 * archive/quit teardown tears every terminal down (README §7.4).
 */
export class PtyService {
  private readonly ptys = new Map<string, IPtyProcess>();

  constructor(private readonly registry: ProcessRegistry) {}

  /**
   * Spawn a PTY, streaming its output into `sink` as {@link PtyChunk}s. Async because
   * the native module is dynamically imported on first use; resolves with the allocated
   * `ptyId` used by {@link write}/{@link resize}/{@link kill}. Registers a registry
   * handle (`stop → kill`) and deregisters on exit.
   */
  async spawn(
    options: PtySpawnOptions,
    sink: StreamSink<PtyChunk>,
  ): Promise<string> {
    const nodePty = await loadNodePty();
    const shell = options.shell ?? defaultTerminalShell();
    const args = options.args ?? [];
    const env = childProcessEnv(options.env);
    const id = uuidv7();

    const proc = nodePty.spawn(shell, args, {
      name: 'xterm-color',
      cwd: options.cwd,
      env,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });

    this.ptys.set(id, proc);
    this.registry.register({
      id,
      workspaceId: options.workspaceId,
      kind: 'pty',
      pid: proc.pid,
      stop: async () => {
        this.kill(id);
      },
    });

    proc.onData((data) => sink.push({ ptyId: id, data }));
    // onExit is the SINGLE cleanup point: drop from the map + registry and end the
    // stream. `kill` only signals the process; this fires whether it exited on its own,
    // by our kill, or by registry teardown.
    proc.onExit(() => {
      this.ptys.delete(id);
      this.registry.unregister(id);
      sink.end();
    });

    return id;
  }

  /**
   * Spawn a PTY for the raw-terminal harness fallback (`harness/raw-terminal.ts`,
   * Phase 7). Unlike {@link spawn} — which drives a `StreamSink` and ends it on exit
   * WITHOUT surfacing the exit code — this returns a handle that exposes raw `onData`
   * chunks AND the exit CODE via `onExit`. The code is what the raw-terminal transcript
   * uses to distinguish a clean `turn_end` (exit 0) from an `error` (nonzero). The
   * returned shape structurally matches `RawPtyHandle` so `index.ts` can pass this
   * service straight into a `RawPtySpawner` with no adapter glue.
   *
   * Raw agent turns are registered as `agent` handles and stopped through the same
   * bounded process-tree escalation path as every other managed child.
   */
  async spawnRaw(options: {
    cwd: string;
    shell: string;
    args: string[];
    env?: Record<string, string>;
    workspaceId: string;
    cols?: number;
    rows?: number;
  }): Promise<{
    ptyId: string;
    onData(listener: (chunk: string) => void): void;
    onExit(listener: (e: { exitCode: number }) => void): void;
    kill(): Promise<void>;
    forceKill(): Promise<void>;
  }> {
    const nodePty = await loadNodePty();
    // Raw agent turns use the bundled Electron executable as a private Node launcher.
    // Preserve only its explicit Node-mode flag; without it macOS starts another GUI
    // Electron application (and Dock icon) for every active turn.
    const env = childProcessEnv(options.env, {
      preserveElectronRunAsNode: true,
    });
    const id = uuidv7();

    const proc = nodePty.spawn(options.shell, options.args, {
      name: 'xterm-color',
      cwd: options.cwd,
      env,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });

    this.ptys.set(id, proc);
    this.registry.register({
      id,
      workspaceId: options.workspaceId,
      kind: 'agent',
      pid: proc.pid,
      stop: () => treeKillEscalate(proc.pid),
    });

    // A single onExit does the map cleanup AND forwards the exit code to the caller's
    // listener (registered via the returned handle). kill and natural exit converge here.
    let exitListener: ((e: { exitCode: number }) => void) | undefined;
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(id);
      this.registry.unregister(id);
      exitListener?.({ exitCode });
    });

    return {
      ptyId: id,
      onData: (listener) => proc.onData(listener),
      onExit: (listener) => {
        exitListener = listener;
      },
      kill: () => treeKillEscalate(proc.pid),
      forceKill: () => treeKillForce(proc.pid),
    };
  }

  /** Write input (typed keystrokes / paste) to a PTY. No-op if the id is unknown. */
  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  /** Resize a PTY to match the xterm.js viewport. No-op if the id is unknown. */
  resize(id: string, cols: number, rows: number): void {
    const proc = this.ptys.get(id);
    if (proc === undefined) return;
    try {
      proc.resize(cols, rows);
    } catch (err) {
      logger.error(
        `[pty] resize ${id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Terminate a PTY. Signals the process; the `onExit` handler does the map/registry
   * cleanup + stream end (so kill and natural exit converge on one path). No-op if
   * unknown; best-effort (a kill failure is logged, not thrown).
   */
  kill(id: string): void {
    const proc = this.ptys.get(id);
    if (proc === undefined) return;
    try {
      proc.kill();
    } catch (err) {
      logger.error(
        `[pty] kill ${id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Kill every live PTY (quit/archive backstop; registry teardown also covers these). */
  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}
