// Codex harness adapter (spec §4.2, phase-doc §3.1; plan Task 1). Implements the
// FROZEN `Harness` contract (README §6.3) over the user's installed `codex` CLI:
//   - detect(): `execa('codex', ['--version'])` — degrade gracefully (Risk R4).
//   - startTurn(): `child_process.spawn('codex', [...])` headless with `exec --json`,
//     pipe stdout through the format-agnostic line splitter (`./parser`), normalize
//     each JSON object with the Codex-specific `normalizeCodex()`, and push the
//     resulting `AgentEvent`s into the caller's sink.
//   - interrupt(): SIGINT the child; a terminal event is ALWAYS emitted (synthesized
//     on exit if the CLI didn't emit one) so no turn is left hanging.
//
// ASSUMED CODEX STREAM FORMAT (drift risk — plan §9). The real `codex` CLI is NOT
// available in this environment, so this adapter is written against a hand-authored,
// ASSUMED newline-delimited JSON shape (fixtures under ./fixtures/codex). It is
// conceptually similar to Claude Code's stream-json but uses Codex's OWN field names.
// The contract tests here prove adapter↔assumed-fixture only; they MUST be re-pinned
// against the real CLI later. Assumed against a `codex` CLI ~v0.x. Assumed events:
//
//   source object                                              → AgentEvent(s)
//   ─────────────────────────────────────────────────────────────────────────────
//   {type:'session_configured', session_id}                    → session capture
//   {type:'agent_message_delta', delta}                        → { text }
//   {type:'tool_call', name, arguments}                        → { tool_use }
//   {type:'file_change', path, kind:'add'|'modify'|'delete'}   → { file_edit }
//   {type:'turn_complete', usage?}                             → { turn_end }
//   {type:'error', message}                                    → { error }  (message only)
//   {type:<anything else>} / malformed                         → []  (forward-compat)
//
// SECURITY (heightened-scrutiny — process execution): we ALWAYS use `spawn`/`execa`
// with an ARGUMENT ARRAY, never a shell string (`shell: false`), so the workspace-
// derived prompt/attachments/cwd can never be interpreted as shell. `cwd` is the
// workspace worktree. Nothing from the prompt or CLI output is logged verbatim (no
// secret leakage — length only). The child is killed and its listeners removed on
// every terminal path (no zombie `codex` processes).

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import type {
  AgentEvent,
  Attachment,
  DetectResult,
  Harness,
  HarnessCapabilities,
  McpServerConfig,
  StartTurnOpts,
  TurnHandle,
} from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import { logger } from '../logging';
import { createJsonLineSplitter } from './parser';

/**
 * Minimum `codex` version we assume speaks the JSON event shape this adapter parses.
 * Older versions WARN (not hard-block) per Risk R4 — the contract test + unknown-event
 * tolerance are the real drift defense. Value is ASSUMED (no real CLI here).
 */
const MIN_CODEX_VERSION = '0.1.0';

/** How long to wait for the CLI's session line before resolving the handle anyway. */
const SESSION_RESOLVE_TIMEOUT_MS = 15_000;

export class CodexHarness implements Harness {
  readonly id = 'codex' as const;

  capabilities(): HarnessCapabilities {
    // These reflect the Codex CLI's documented capabilities and are the exact point
    // the UI degrades on: Codex supports session resume and MCP passthrough, but has
    // no distinct plan-mode (so the plan-mode selector is hidden for it). It still
    // exposes a raw-terminal fallback like every adapter.
    return {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: false,
      rawTerminalFallback: true,
    };
  }

  /**
   * Probe whether `codex` is installed and (best-effort) authenticated. Auth is
   * inherited from the user's existing Codex login (spec §1.2) — this adapter handles
   * no credentials. Per Risk R4 auth is not reliably detectable, so a successful
   * `--version` degrades to "installed, assume authenticated; a failing turn surfaces
   * the real auth error" rather than hard-blocking.
   */
  async detect(): Promise<DetectResult> {
    try {
      const { stdout } = await execa('codex', ['--version']);
      const version = parseVersion(stdout);
      if (version && isOlderThan(version, MIN_CODEX_VERSION)) {
        logger.warn(
          `[harness:codex] detected codex ${version} < minimum ${MIN_CODEX_VERSION}; JSON output may drift`,
        );
      }
      return { installed: true, version, authenticated: true };
    } catch (err) {
      // ENOENT (not on PATH) or any spawn failure → not installed / not usable.
      logger.info(
        `[harness:codex] detect: codex not available (${errMessage(err)})`,
      );
      return { installed: false, authenticated: false };
    }
  }

  /**
   * Start a headless turn. Resolves the `TurnHandle` as soon as the session id is
   * captured from the CLI's session line (or on early exit / timeout), so a caller can
   * begin interrupting immediately. Normalized `AgentEvent`s are pushed to `sink` as
   * they stream; the sink is `end()`ed exactly once on the terminal path.
   */
  startTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle> {
    const args = buildArgs(opts);
    const child = spawn('codex', args, {
      cwd: opts.workspaceDir,
      env: process.env,
      // Never a shell — args are passed as an array (command-injection defense).
      shell: false,
    });

    const splitter = createJsonLineSplitter((msg) =>
      logger.warn(`[harness:codex] ${msg}`),
    );

    let sessionId = opts.sessionId ?? '';
    let terminalEmitted = false;
    let settled = false;
    let ended = false;

    return new Promise<TurnHandle>((resolve) => {
      const timer = setTimeout(resolveHandle, SESSION_RESOLVE_TIMEOUT_MS);

      const interrupt = async (): Promise<void> => {
        // SIGINT lets `codex` flush a clean result; the 'close' handler guarantees a
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

      /** Feed parsed objects through the Codex normalization into the sink. */
      function consume(objects: unknown[]): void {
        for (const obj of objects) {
          for (const result of normalizeCodex(obj)) {
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
          `[harness:codex] stderr (${buf.length} bytes) for cwd=${opts.workspaceDir}`,
        );
      });

      child.on('error', (err: Error) => {
        // spawn failure (e.g. `codex` not on PATH) — surface as a terminal error.
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
                : { message: `codex exited with code ${code ?? 'unknown'}` }),
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
// Codex normalization (ASSUMED format — see the header) — pure, total, tolerant
// ---------------------------------------------------------------------------
//
// Return-shape mirrors `parser.ts`'s `NormalizeResult`: `normalizeCodex(obj)` ALWAYS
// returns an array (`[]` for ignored/unknown/malformed) so the call site stays a flat
// `for (const r of normalizeCodex(obj))`. Unknown/malformed input yields `[]`, never a
// throw (forward-compat — a single garbled line must not tear down the turn).

export type CodexNormalizeResult =
  { type: 'event'; event: AgentEvent } | { type: 'session'; sessionId: string };

/** Codex `file_change.kind` → the frozen `file_edit` op (tolerant of spellings). */
const FILE_CHANGE_OPS: Readonly<
  Record<string, 'create' | 'modify' | 'delete'>
> = {
  add: 'create',
  create: 'create',
  modify: 'modify',
  update: 'modify',
  delete: 'delete',
  remove: 'delete',
};

/** Map one parsed Codex JSON object to zero-or-more `AgentEvent`s (or a session id). */
export function normalizeCodex(obj: unknown): CodexNormalizeResult[] {
  if (!isRecord(obj)) {
    return [];
  }
  switch (asString(obj.type)) {
    case 'session_configured':
      return normalizeSession(obj);
    case 'agent_message_delta':
      return normalizeTextDelta(obj);
    case 'tool_call':
      return normalizeToolCall(obj);
    case 'file_change':
      return normalizeFileChange(obj);
    case 'turn_complete':
      return normalizeTurnComplete(obj);
    case 'error':
      return normalizeError(obj);
    default:
      // Unknown top-level type — ignore for forward-compat (spec §9).
      return [];
  }
}

/** session_configured carries the session id we thread onto the TurnHandle. */
function normalizeSession(
  obj: Record<string, unknown>,
): CodexNormalizeResult[] {
  const sessionId = asString(obj.session_id);
  return sessionId ? [{ type: 'session', sessionId }] : [];
}

/** agent_message_delta → a text event (empty deltas are dropped). */
function normalizeTextDelta(
  obj: Record<string, unknown>,
): CodexNormalizeResult[] {
  const delta = asString(obj.delta);
  if (delta === undefined || delta === '') {
    return [];
  }
  return [{ type: 'event', event: { kind: 'text', delta } }];
}

/** tool_call → a tool_use event; `arguments` is carried opaquely as `input`. */
function normalizeToolCall(
  obj: Record<string, unknown>,
): CodexNormalizeResult[] {
  const name = asString(obj.name);
  if (name === undefined) {
    return [];
  }
  return [
    { type: 'event', event: { kind: 'tool_use', name, input: obj.arguments } },
  ];
}

/** file_change → a file_edit event; an unmappable `kind` or missing path is dropped. */
function normalizeFileChange(
  obj: Record<string, unknown>,
): CodexNormalizeResult[] {
  const path = asString(obj.path);
  const kind = asString(obj.kind);
  if (path === undefined || kind === undefined) {
    return [];
  }
  const op = FILE_CHANGE_OPS[kind];
  if (op === undefined) {
    return [];
  }
  return [{ type: 'event', event: { kind: 'file_edit', path, op } }];
}

/** turn_complete closes a turn with optional usage. */
function normalizeTurnComplete(
  obj: Record<string, unknown>,
): CodexNormalizeResult[] {
  const usage = extractUsage(obj.usage);
  return [
    { type: 'event', event: { kind: 'turn_end', ...(usage ? { usage } : {}) } },
  ];
}

/** error → an error event carrying ONLY a string message (never a stringified object). */
function normalizeError(obj: Record<string, unknown>): CodexNormalizeResult[] {
  const message = asString(obj.message) ?? 'agent turn failed';
  return [{ type: 'event', event: { kind: 'error', message } }];
}

// ---------------------------------------------------------------------------
// Argument construction (spawn arg array — never a shell string)
// ---------------------------------------------------------------------------

/**
 * Build the `codex` argv for a turn. The prompt (with serialized attachments) is a
 * single positional argument passed after a `--` end-of-flags separator, so no amount
 * of workspace-derived content can inject shell OR be mistaken for a flag.
 *
 * Exported for testing: it is the point where `mcpConfig` becomes a written `.mcp.json`
 * + a `--mcp-config` flag, so the MCP-passthrough test asserts against it directly
 * rather than spawning a real `codex`.
 */
export function buildArgs(opts: StartTurnOpts): string[] {
  const prompt = opts.prompt + serializeAttachments(opts.attachments);
  // `exec` is Codex's non-interactive/headless subcommand; `--json` selects the
  // newline-delimited JSON event stream this adapter parses (ASSUMED — see header).
  const args = ['exec', '--json'];

  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  }

  // Codex has no distinct plan-mode (capabilities.supportsPlanMode=false); only
  // auto_accept maps to a flag. default/plan/undefined use the CLI default — a `plan`
  // request degrades to the default rather than erroring (capability-driven UI hides
  // the plan selector, but the adapter must not throw if one arrives).
  if (opts.mode === 'auto_accept') {
    args.push('--full-auto');
  }

  const mcpConfigPath = writeMcpConfig(opts.mcpConfig);
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }

  // `--` ends flag parsing; the prompt then cannot be read as an option even if it
  // begins with a dash. This is the last argument.
  args.push('--', prompt);
  return args;
}

/**
 * Write the MCP servers to a temp `.mcp.json` and return its path (or undefined when
 * there are none). Written OUTSIDE the workspace (a fresh tmp dir) so it never dirties
 * the user's worktree/diff. Format mirrors the Claude Code adapter's `--mcp-config`
 * file schema (ASSUMED to be shared across CLIs — a re-pin point per plan §9).
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
// Attachment serialization — THE Phase-4 contract (shared textual format)
// ---------------------------------------------------------------------------
//
// Phase 4's "Send to agent" produces `diff_comment` attachments against EXACTLY this
// textual format (frozen with the Claude Code adapter). The block is appended to the
// user's prompt so the headless CLI sees it as ordinary prompt text (safe — it is a
// single positional argument after `--`, not shell).
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
// Small, defensive extractors (input is untrusted `unknown`)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Map Codex `usage` (snake_case) to the frozen `Usage` (camelCase), or undefined. */
function extractUsage(
  raw: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const inputTokens = asNumber(raw.input_tokens);
  const outputTokens = asNumber(raw.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Extract a dotted numeric version (e.g. "1.2.3") from `codex --version` output. */
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
