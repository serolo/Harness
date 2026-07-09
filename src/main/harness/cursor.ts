// Cursor harness adapter (spec §4.2, phase-doc §3.1; plan Task 3). Implements the
// FROZEN `Harness` contract (README §6.3) over the user's installed `cursor-agent` CLI.
//
// RAW-TERMINAL HARNESS (plan Task 3 design decision). Cursor's real CLI does NOT expose
// a structured JSON event stream in this environment, so — per the plan ("if Cursor
// lacks a JSON stream, set rawTerminalFallback=true and use Task 2's path") — Cursor is
// implemented as a RAW-TERMINAL harness: `startTurn` delegates to the shared
// `RawTerminalTranscript` (Task 2), which runs `cursor-agent` in a PTY and forwards raw
// output chunks as `{ kind: 'text', delta }` `AgentEvent`s with a best-effort idle turn
// boundary and a guaranteed single terminal event. This deliberately exercises + proves
// the Task 2 raw-fallback path. There is intentionally NO Cursor JSON parser.
//
// SECURITY (heightened-scrutiny — process execution): the CLI invocation is built as an
// ARGUMENT ARRAY (never a shell string); the prompt (with serialized attachments) is a
// single array element after a `--` end-of-flags separator, so no workspace-derived
// content can be interpreted as a flag or shell. `RawTerminalTranscript` owns the PTY
// lifecycle (never logs output verbatim). `detect()` degrades gracefully on ENOENT.
//
// ASSUMED CLI (drift risk — plan §9; re-pin against the real CLI later). The binary is
// `cursor-agent` ({@link CURSOR_BIN}). The turn argv is assumed to be
// `cursor-agent -p [--force] -- <prompt>` (`-p` = non-interactive print mode so the CLI
// runs one prompt to stdout and exits; `--force` only when auto-accepting edits). Auth
// is inherited from the user's existing Cursor login (spec §1.2) — no credential handling.

import { execa } from 'execa';

import type {
  Attachment,
  DetectResult,
  Harness,
  HarnessCapabilities,
  StartTurnOpts,
  TurnHandle,
} from '@shared/harness';
import type { AgentEvent } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import { logger } from '../logging';
import {
  RawTerminalTranscript,
  type RawCommand,
  type RawPtySpawner,
} from './raw-terminal';

/** The Cursor CLI binary (ASSUMED — a single const so it is easy to re-pin per plan §9). */
export const CURSOR_BIN = 'cursor-agent';

/**
 * Minimum `cursor-agent` version we assume behaves as this adapter expects. Older
 * versions WARN (not hard-block), mirroring the other adapters. Value is ASSUMED.
 */
const MIN_CURSOR_VERSION = '0.1.0';

export class CursorHarness implements Harness {
  readonly id = 'cursor' as const;

  private readonly transcript: RawTerminalTranscript;

  /**
   * @param spawner INJECTED PTY spawner — a fake in tests, the real `PtyService`→
   *   `RawPtySpawner` adapter wired in `src/main/index.ts`. Keeping it injected keeps
   *   this module free of the native PTY binding and unit-testable.
   * @param opts.idleTimeoutMs override for the raw-terminal idle turn-boundary heuristic.
   */
  constructor(spawner: RawPtySpawner, opts: { idleTimeoutMs?: number } = {}) {
    this.transcript = new RawTerminalTranscript({
      spawner,
      command: buildCommand,
      ...(opts.idleTimeoutMs !== undefined
        ? { idleTimeoutMs: opts.idleTimeoutMs }
        : {}),
    });
  }

  capabilities(): HarnessCapabilities {
    // Cursor runs through the RAW terminal (no structured stream), so it cannot offer any
    // structured feature: no session resume, no MCP passthrough, no plan-mode. This is the
    // exact capability-degradation point the UI reads (Task 4 hides resume/MCP/plan for
    // Cursor). `rawTerminalFallback` is the ONLY affordance it advertises.
    return {
      supportsResume: false,
      supportsMcp: false,
      supportsPlanMode: false,
      rawTerminalFallback: true,
    };
  }

  /**
   * Probe whether `cursor-agent` is installed and (best-effort) authenticated. Auth is
   * inherited from the user's Cursor login (spec §1.2) — no credentials handled here.
   * Per Risk R4 a successful `--version` degrades to "installed, assume authenticated"
   * rather than hard-blocking; ENOENT / any spawn failure → not installed.
   */
  async detect(): Promise<DetectResult> {
    try {
      const { stdout } = await execa(CURSOR_BIN, ['--version']);
      const version = parseVersion(stdout);
      if (version && isOlderThan(version, MIN_CURSOR_VERSION)) {
        logger.warn(
          `[harness:cursor] detected ${CURSOR_BIN} ${version} < minimum ${MIN_CURSOR_VERSION}; behaviour may drift`,
        );
      }
      return { installed: true, version, authenticated: true };
    } catch (err) {
      logger.info(
        `[harness:cursor] detect: ${CURSOR_BIN} not available (${errMessage(err)})`,
      );
      return { installed: false, authenticated: false };
    }
  }

  /**
   * Run one turn via the raw-terminal transcript. There is no session concept in a raw
   * terminal, so the returned `TurnHandle.sessionId` is empty (matching `supportsResume:
   * false`). The transcript guarantees exactly one terminal event and a single `sink.end()`.
   */
  startTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle> {
    return this.transcript.startTurn(opts, sink);
  }
}

// ---------------------------------------------------------------------------
// Command construction (argument array — never a shell string)
// ---------------------------------------------------------------------------

/**
 * Build the `cursor-agent` invocation for a turn as an ARGUMENT ARRAY. The prompt (with
 * serialized attachments) is a single element after a `--` end-of-flags separator, so a
 * prompt containing shell metacharacters or leading dashes can never be interpreted as a
 * flag or shell (command-injection defense). Exported for the contract test.
 *
 * ASSUMED argv (re-pin per plan §9): `cursor-agent -p [--force] -- <prompt>`.
 */
export function buildCommand(opts: StartTurnOpts): RawCommand {
  const prompt = opts.prompt + serializeAttachments(opts.attachments);
  // `-p` = non-interactive print mode: run one prompt, stream to stdout, then exit.
  const args = ['-p'];

  // Cursor has no plan-mode/resume/MCP (see capabilities); only auto_accept maps to a
  // flag. `plan`/`default`/undefined use the CLI default — a `plan` request degrades
  // silently (no flag, no throw) since the UI hides plan-mode for Cursor.
  if (opts.mode === 'auto_accept') {
    args.push('--force');
  }

  // `--` ends flag parsing; the prompt is the final, discrete argument.
  args.push('--', prompt);
  return { shell: CURSOR_BIN, args };
}

// ---------------------------------------------------------------------------
// Attachment serialization — THE Phase-4 contract (shared textual format)
// ---------------------------------------------------------------------------
//
// Phase 4's "Send to agent" produces `diff_comment` attachments against EXACTLY this
// textual format (frozen with the Claude Code + Codex adapters). The block is appended to
// the user's prompt so the CLI sees it as ordinary prompt text (safe — it is a single
// argument after `--`, not shell).
//
//   [Attached file: <path>]
//   [Attached image: <path>]
//   [Diff comment on <file> lines <lineStart>-<lineEnd> (<side>)]
//   > <excerpt, each source line quoted>
//   <body>
//
// This format is FROZEN for Phase 4. Do not change the wording/structure without
// coordinating the Phase-4 producer.
function serializeAttachments(attachments: Attachment[]): string {
  if (!attachments || attachments.length === 0) {
    return '';
  }
  const blocks: string[] = [];
  for (const a of attachments) {
    if (a.type === 'file') {
      blocks.push(`[Attached file: ${a.path}]`);
    } else if (a.type === 'image') {
      blocks.push(`[Attached image: ${a.path}]`);
    } else {
      // diff_comment
      const quoted = a.excerpt
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      blocks.push(
        `[Diff comment on ${a.file} lines ${a.lineStart}-${a.lineEnd} (${a.side})]\n${quoted}\n${a.body}`,
      );
    }
  }
  return `\n\n${blocks.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Extract a dotted numeric version (e.g. "1.2.3") from `cursor-agent --version` output. */
function parseVersion(stdout: string): string | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  return match ? match[0] : undefined;
}

/** True when semver `a` is strictly older than `b` (numeric, three-part, lenient). */
function isOlderThan(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db;
  }
  return false;
}

/** Safe message extraction from an unknown thrown value (no secret dumping). */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
