// Claude Code harness adapter (spec §4.2, phase-doc §3.1). Implements the FROZEN
// `Harness` contract (README §6.3) over the user's installed `claude` CLI:
//   - detect(): `execa('claude', ['--version'])` — degrade gracefully (Risk R4).
//   - startTurn(): `child_process.spawn('claude', [...])` headless with
//     `--output-format stream-json --verbose`, pipe stdout through the PURE parser
//     (`./parser`), and push normalized `AgentEvent`s into the caller's sink.
//   - interrupt(): SIGINT the child; a terminal event is ALWAYS emitted (synthesized
//     on exit if the CLI didn't emit one) so no turn is left hanging.
//
// SECURITY (heightened-scrutiny — process execution): we ALWAYS use `spawn` with an
// ARGUMENT ARRAY, never a shell string, so the workspace-derived prompt/attachments/
// cwd can never be interpreted as shell. `cwd` is the workspace worktree. Nothing from
// the prompt or CLI output is logged verbatim (no secret leakage). The child is killed
// and its listeners removed on every terminal path (no zombie `claude` processes).

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import type {
  AgentEvent,
  AgentMode,
  Attachment,
  DetectResult,
  Harness,
  HarnessCapabilities,
  McpServerConfig,
  PermissionPolicy,
  StartTurnOpts,
  TurnHandle,
} from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import { AppError } from '@shared/errors';
import { logger } from '../logging';
import { createJsonLineSplitter, normalize } from './parser';

/**
 * Minimum `claude` version we are confident speaks the stream-JSON shape the parser
 * expects. Older versions WARN (not hard-block) per Risk R4 — the contract test +
 * unknown-event tolerance are the real drift defense.
 */
const MIN_CLAUDE_VERSION = '0.2.0';

/** How long to wait for the CLI's init/session line before resolving the handle anyway. */
const SESSION_RESOLVE_TIMEOUT_MS = 15_000;

export class ClaudeCodeHarness implements Harness {
  readonly id = 'claude_code' as const;

  capabilities(): HarnessCapabilities {
    return {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: true,
      rawTerminalFallback: true,
    };
  }

  /**
   * Probe whether `claude` is installed and (best-effort) authenticated. Per Risk R4
   * auth is NOT reliably detectable across CLI versions, so a successful `--version`
   * degrades to "installed, assume authenticated; a failing turn surfaces the real
   * auth error" rather than hard-blocking.
   */
  async detect(): Promise<DetectResult> {
    try {
      const { stdout } = await execa('claude', ['--version']);
      const version = parseVersion(stdout);
      if (version && isOlderThan(version, MIN_CLAUDE_VERSION)) {
        logger.warn(
          `[harness:claude_code] detected claude ${version} < minimum ${MIN_CLAUDE_VERSION}; stream-json output may drift`,
        );
      }
      return { installed: true, version, authenticated: true };
    } catch (err) {
      // ENOENT (not on PATH) or any spawn failure → not installed / not usable.
      logger.info(
        `[harness:claude_code] detect: claude not available (${errMessage(err)})`,
      );
      return { installed: false, authenticated: false };
    }
  }

  /**
   * Start a headless turn. Resolves the `TurnHandle` as soon as the session id is
   * captured from the CLI's init line (or on early exit / timeout), so a caller can
   * begin interrupting immediately. Normalized `AgentEvent`s are pushed to `sink` as
   * they stream; the sink is `end()`ed exactly once on the terminal path.
   */
  startTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle> {
    const args = buildArgs(opts);
    const child = spawn('claude', args, {
      cwd: opts.workspaceDir,
      env: process.env,
      // Never a shell — args are passed as an array (command-injection defense).
      shell: false,
    });

    const splitter = createJsonLineSplitter((msg) =>
      logger.warn(`[harness:claude_code] ${msg}`),
    );

    let sessionId = opts.sessionId ?? '';
    let terminalEmitted = false;
    let settled = false;
    let ended = false;

    return new Promise<TurnHandle>((resolve) => {
      const timer = setTimeout(resolveHandle, SESSION_RESOLVE_TIMEOUT_MS);

      const interrupt = async (): Promise<void> => {
        // SIGINT lets `claude` flush a clean result; the 'close' handler guarantees a
        // terminal event regardless of whether it did.
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGINT');
        }
      };

      function resolveHandle(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ sessionId, interrupt });
      }

      function endStream(): void {
        if (ended) return;
        ended = true;
        sink.end();
      }

      /** Feed parsed objects through the normalization table into the sink. */
      function consume(objects: unknown[]): void {
        for (const obj of objects) {
          for (const result of normalize(obj)) {
            if (!result) continue;
            if (result.type === 'session') {
              sessionId = result.sessionId;
              resolveHandle(); // session known → the handle is now authoritative
            } else {
              if (
                result.event.kind === 'turn_end' ||
                result.event.kind === 'error'
              ) {
                terminalEmitted = true;
              }
              sink.push(result.event);
            }
          }
        }
      }

      child.stdout.on('data', (buf: Buffer) => {
        consume(splitter.push(buf.toString('utf8')));
      });

      // stderr is diagnostic only — never echo it as content, never log it verbatim
      // (it can carry prompt/tool fragments). Length is enough to spot noise.
      child.stderr.on('data', (buf: Buffer) => {
        logger.debug(
          `[harness:claude_code] stderr (${buf.length} bytes) for cwd=${opts.workspaceDir}`,
        );
      });

      child.on('error', (err: Error) => {
        // spawn failure (e.g. `claude` not on PATH) — surface as a terminal error.
        if (!terminalEmitted) {
          sink.push({ kind: 'error', message: err.message });
          terminalEmitted = true;
        }
        resolveHandle();
        endStream();
      });

      child.on('close', (code: number | null, signal: string | null) => {
        consume(splitter.flush());
        if (!terminalEmitted) {
          // Synthesize a terminal event so the turn never hangs (interrupt or crash).
          if (signal !== null || (code !== null && code !== 0)) {
            sink.push({
              kind: signal !== null ? 'turn_end' : 'error',
              ...(signal !== null
                ? {}
                : { message: `claude exited with code ${code ?? 'unknown'}` }),
            } as AgentEvent);
          } else {
            sink.push({ kind: 'turn_end' });
          }
          terminalEmitted = true;
        }
        resolveHandle();
        endStream();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Argument construction (spawn arg array — never a shell string)
// ---------------------------------------------------------------------------

/**
 * Build the `claude` argv for a turn. The prompt (with serialized attachments) is a
 * single `-p` argument, so no amount of workspace-derived content can inject shell.
 *
 * Exported for testing (Phase 6, Track F): it is the point where `mcpConfig` becomes
 * a written `.mcp.json` + a `--mcp-config` flag, so the MCP-passthrough test asserts
 * against it directly rather than spawning a real `claude`.
 */
export function buildArgs(opts: StartTurnOpts): string[] {
  const prompt = opts.prompt + serializeAttachments(opts.attachments);
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  }

  const permissionMode = modeToPermissionMode(opts.mode);
  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }

  // Phase 12: optional model override (e.g. `--model sonnet`). A DISCRETE argv element
  // under spawn(shell:false) — never string-interpolated. The value is validated against
  // MODEL_PATTERN at the IPC boundary before it can reach here, so a hostile string stays
  // an inert single argument rather than shell.
  if (opts.model) {
    args.push('--model', opts.model);
  }

  args.push(...permissionPolicyArgs(opts.permissionPolicy));

  const mcpConfigPath = writeMcpConfig(opts.mcpConfig);
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }

  return args;
}

/** Map the frozen `AgentMode` to Claude Code's `--permission-mode` value (or none). */
function modeToPermissionMode(mode: AgentMode | undefined): string | undefined {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'auto_accept':
      return 'acceptEdits';
    case 'default':
    case undefined:
      return undefined; // CLI default
    default:
      return undefined;
  }
}

/**
 * Best-effort mapping of the frozen `PermissionPolicy` to CLI flags (Phase 2 is
 * pass-through plumbing — full permission UX is Phase 6, Risk R6). `allowedTools`
 * plus `allow` become `--allowedTools`; `deny` becomes `--disallowedTools`. Lists are
 * joined into a single comma-separated argument. `confirmBeforeRun` has no headless
 * flag yet (it surfaces as `needs_attention` via the supervisor).
 */
function permissionPolicyArgs(policy: PermissionPolicy): string[] {
  const out: string[] = [];
  const allowed = [...(policy.allowedTools ?? []), ...(policy.allow ?? [])];
  if (allowed.length > 0) {
    out.push('--allowedTools', allowed.join(','));
  }
  if (policy.deny && policy.deny.length > 0) {
    out.push('--disallowedTools', policy.deny.join(','));
  }
  return out;
}

/**
 * Write the MCP servers to a temp `.mcp.json` and return its path (or undefined when
 * there are none). Written OUTSIDE the workspace (a fresh tmp dir) so it never dirties
 * the user's worktree/diff. Format matches Claude Code's `--mcp-config` file schema.
 */
function writeMcpConfig(servers: McpServerConfig[]): string | undefined {
  if (!servers || servers.length === 0) {
    return undefined;
  }
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = {
      command: s.command,
      ...(s.args ? { args: s.args } : {}),
      ...(s.env ? { env: s.env } : {}),
    };
  }
  // mkdtemp gives a 0700 dir; write the file 0600 since MCP `env` may carry secrets
  // and the parent tmp dir is world-readable.
  const dir = mkdtempSync(join(tmpdir(), 'harness-mcp-'));
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return file;
}

// ---------------------------------------------------------------------------
// Attachment serialization — THE Phase-4 contract
// ---------------------------------------------------------------------------
//
// Phase 4's "Send to agent" produces `diff_comment` attachments against EXACTLY this
// textual format. The block is appended to the user's prompt so the headless CLI sees
// it as ordinary prompt text (safe — it is a single `-p` argument, not shell).
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

/** Extract a dotted numeric version (e.g. "1.2.3") from `claude --version` output. */
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

// Re-export AppError use to keep the harness error code intentional/available to
// callers that wrap adapter failures (the supervisor maps terminal 'error' events).
export { AppError };
