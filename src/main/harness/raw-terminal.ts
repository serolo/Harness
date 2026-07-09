// Raw-terminal transcript helper (spec §9, phase-7 Task 2) — lets a harness WITHOUT a
// structured JSON stream (e.g. Cursor) drive the SAME chat UI as a JSON harness. It runs
// the harness CLI in a PTY, forwards each raw output chunk into the caller's sink as a
// `{ kind: 'text', delta }` `AgentEvent`, and — on a best-effort turn boundary or PTY
// exit — emits exactly ONE terminal event (`turn_end`, or `error` on nonzero exit). Because
// output is persisted as ordinary `text` events, chat reconstruction from the `events`
// table works identically to a JSON harness.
//
// It presents the frozen `Harness.startTurn` streaming contract to the supervisor
// (`(opts, sink) => Promise<TurnHandle>`), mirroring `claude-code.ts`'s discipline: a
// terminal event is guaranteed on EVERY path (idle boundary, PTY exit, error, interrupt),
// emitted exactly once, and the sink is `end()`ed exactly once.
//
// TURN-BOUNDARY HEURISTIC (best-effort, spec §9): an IDLE TIMEOUT. When no output has
// arrived for `idleTimeoutMs` (default {@link DEFAULT_IDLE_TIMEOUT_MS}) since the last
// chunk, the turn is finalized (`turn_end`) and the PTY is killed. This is deliberately
// approximate and MUST NOT be relied on for correctness — if it never fires (e.g. the CLI
// streams continuously then exits), PTY exit still finalizes the turn. We picked idle
// timeout over a shell-prompt sentinel because raw output is unparsed (we do NOT strip
// ANSI) so a reliable prompt regex across shells/harnesses is not available.
//
// SECURITY (heightened-scrutiny — process execution): the shell + args are handed to the
// injected spawner as an ARGUMENT ARRAY (never a shell string); the caller's `command`
// builder is responsible for keeping workspace-derived input out of the shell string.
// `cwd` is the workspace worktree. Raw output is NEVER logged verbatim (it can carry
// prompt/secret fragments) — only chunk/transcript LENGTHS.
//
// DEPENDENCY SEAM: this module does NOT import the native PTY binding. It depends on an
// injected {@link RawPtySpawner} — a plain interface shaped as a faithful subset of what
// `src/main/index.ts` can adapt `PtyService`/node-pty to. That keeps the module free of
// native imports and unit-testable with a fake spawner. See {@link RawPtySpawner} for the
// exact adapter shape.

import type { AgentEvent, StartTurnOpts, TurnHandle } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';

/**
 * Idle-timeout default (ms) for the turn-boundary heuristic: finalize a turn when no
 * output has arrived for this long since the last chunk. Best-effort — see file header.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Injected PTY seam (native module kept OUT of this module's type graph)
// ---------------------------------------------------------------------------

/**
 * Options for spawning the harness CLI in a PTY. A faithful subset of
 * `PtySpawnOptions` (`src/main/pty/index.ts`): `cwd` is the workspace worktree, `shell`
 * + `args` are an ARGUMENT ARRAY (never a shell string), `env` is merged over the
 * inherited env by the adapter. `workspaceId` is optional so the lead's adapter can
 * register the child with the shared `ProcessRegistry` for teardown; this helper never
 * reads it.
 */
export interface RawPtySpawnOptions {
  cwd: string;
  shell: string;
  args: string[];
  env?: Record<string, string>;
  workspaceId?: string;
  cols?: number;
  rows?: number;
}

/**
 * A live PTY handle. Shaped to match node-pty's `IPty` (and therefore adaptable from
 * `PtyService`): output arrives via `onData` as raw `string` chunks, `onExit` fires once
 * with the process exit code, and `kill` signals the process. The lead wires the real
 * `PtyService` to this shape in `src/main/index.ts` (native side); this module only ever
 * sees the interface.
 */
export interface RawPtyHandle {
  /** Registry/PTY id (opaque to this helper; carried through for the adapter's logging). */
  ptyId: string;
  /** Subscribe to raw output chunks (NOT ANSI-stripped). */
  onData(listener: (chunk: string) => void): void;
  /** Fires exactly once when the process exits; `exitCode` 0 = clean. */
  onExit(listener: (e: { exitCode: number }) => void): void;
  /** Signal the process to terminate (interrupt / turn-boundary finalize). */
  kill(): void;
}

/**
 * The injected PTY spawner. A plain dependency (no native import) so this module stays
 * unit-testable with a fake. `spawn` is async because `PtyService` loads the native
 * binding lazily on first use.
 *
 * ADAPTER SEAM (for `src/main/index.ts`): `PtyService.spawn(options, sink)` returns a
 * `ptyId` and drives output through a `StreamSink<PtyChunk>`, ending the sink on exit
 * WITHOUT surfacing the exit code. To adapt it to `RawPtyHandle`, the lead's adapter
 * should spawn through node-pty (or extend `PtyService`) so the exit CODE reaches
 * `onExit` — the code is what distinguishes `turn_end` (0) from `error` (nonzero). The
 * adapter also owns `ProcessRegistry` registration (using `RawPtySpawnOptions.workspaceId`).
 */
export interface RawPtySpawner {
  spawn(options: RawPtySpawnOptions): Promise<RawPtyHandle>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Shell + args (an ARGUMENT ARRAY) to run the harness CLI for one turn, plus env. */
export interface RawCommand {
  shell: string;
  args: string[];
  env?: Record<string, string>;
}

export interface RawTerminalConfig {
  /** Injected PTY spawner (adapts `PtyService`/node-pty in `src/main/index.ts`). */
  spawner: RawPtySpawner;
  /**
   * Build the CLI invocation for a turn from the turn options. MUST return an argument
   * ARRAY — never fold `opts.prompt`/attachments into a shell string (command injection).
   */
  command: (opts: StartTurnOpts) => RawCommand;
  /** Idle ms since last output that finalizes a turn. Defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}. */
  idleTimeoutMs?: number;
  /** Initial PTY dimensions forwarded to the spawner (optional). */
  cols?: number;
  rows?: number;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Reusable raw-terminal transcript driver. A concrete harness adapter (e.g. Cursor)
 * without a JSON stream constructs one of these with an injected spawner + a `command`
 * builder and delegates its `startTurn` here. It is NOT itself a `Harness` (it has no
 * `id`/`capabilities`/`detect`) — those belong to the concrete adapter.
 */
export class RawTerminalTranscript {
  private readonly spawner: RawPtySpawner;
  private readonly command: (opts: StartTurnOpts) => RawCommand;
  private readonly idleTimeoutMs: number;
  private readonly cols?: number;
  private readonly rows?: number;

  constructor(config: RawTerminalConfig) {
    this.spawner = config.spawner;
    this.command = config.command;
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.cols = config.cols;
    this.rows = config.rows;
  }

  /**
   * Run one turn in a PTY. Resolves the `TurnHandle` once the PTY is spawned (so the
   * caller can interrupt immediately). Raw output chunks stream to `sink` as
   * `{ kind: 'text', delta }`; the turn is finalized with exactly one terminal event on
   * the idle boundary, PTY exit, or interrupt — whichever comes first — and the sink is
   * `end()`ed exactly once.
   *
   * There is no session concept in a raw terminal, so `sessionId` is empty (the
   * supervisor skips `--resume` persistence for a falsy id).
   */
  async startTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle> {
    const cmd = this.command(opts);
    const handle = await this.spawner.spawn({
      cwd: opts.workspaceDir,
      shell: cmd.shell,
      args: cmd.args,
      ...(cmd.env ? { env: cmd.env } : {}),
      ...(this.cols !== undefined ? { cols: this.cols } : {}),
      ...(this.rows !== undefined ? { rows: this.rows } : {}),
    });

    let terminalEmitted = false;
    let ended = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const clearIdleTimer = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const endStream = (): void => {
      if (ended) return;
      ended = true;
      clearIdleTimer();
      sink.end();
    };

    /** Emit the single terminal event (idempotent) then close the stream. */
    const finalize = (event: AgentEvent): void => {
      if (!terminalEmitted) {
        terminalEmitted = true;
        sink.push(event);
      }
      endStream();
    };

    /** The idle boundary fired: no output for `idleTimeoutMs`. Best-effort `turn_end`. */
    const onIdle = (): void => {
      idleTimer = undefined;
      // Kill the PTY so the CLI stops running past the boundary we just declared; its
      // `onExit` is guarded by `terminalEmitted` and will not double-finalize.
      handle.kill();
      finalize({ kind: 'turn_end' });
    };

    const armIdleTimer = (): void => {
      clearIdleTimer();
      idleTimer = setTimeout(onIdle, this.idleTimeoutMs);
    };

    handle.onData((chunk) => {
      if (terminalEmitted) return; // boundary already crossed — drop trailing output
      // Forward raw bytes as-is (no ANSI stripping — best-effort transcript). Never log
      // the chunk verbatim; the renderer/recorder handle rendering.
      sink.push({ kind: 'text', delta: chunk });
      armIdleTimer();
    });

    handle.onExit(({ exitCode }) => {
      // PTY exit ALWAYS finalizes — this is the correctness backstop when the idle
      // heuristic never fires. Nonzero exit → error; clean exit → turn_end.
      if (exitCode === 0) {
        finalize({ kind: 'turn_end' });
      } else {
        finalize({
          kind: 'error',
          message: `harness terminal exited with code ${exitCode}`,
        });
      }
    });

    // Arm the initial idle timer: a CLI that produces no output at all still hits a
    // boundary (or exits) rather than hanging.
    armIdleTimer();

    const interrupt = async (): Promise<void> => {
      // Kill the PTY; `onExit` finalizes. If the process is already gone this is a no-op.
      handle.kill();
    };

    return { sessionId: '', interrupt };
  }
}
