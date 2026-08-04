// Claude Code harness adapter (spec §4.2, phase-doc §3.1). Implements the FROZEN
// `Harness` contract (README §6.3) over the user's installed `claude` CLI:
//   - detect(): checks `--version` plus the token-free `auth status` JSON response.
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
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import type {
  AgentEvent,
  AgentAuthMethod,
  Attachment,
  DetectResult,
  Harness,
  HarnessCapabilities,
  McpServerConfig,
  StartTurnOpts,
  TurnHandle,
} from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import { AppError } from '@shared/errors';
import { logger } from '../logging';
import { childProcessEnv } from '../process/childEnv';
import { resolveHarnessExecutable } from './executable';
import { createJsonLineSplitter, normalize } from './parser';
import type { RawPtyHandle, RawPtySpawner } from './raw-terminal';

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

  constructor(private readonly rawPtySpawner?: RawPtySpawner) {}

  capabilities(): HarnessCapabilities {
    return {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: true,
      rawTerminalFallback: true,
    };
  }

  /**
   * Probe whether `claude` is installed and authenticated. Authentication uses the
   * CLI's token-free JSON status command; failure stays false so onboarding cannot
   * claim readiness from `--version` alone.
   */
  async detect(): Promise<DetectResult> {
    try {
      const env = childProcessEnv();
      const { stdout } = await execa(
        resolveHarnessExecutable('claude'),
        ['--version'],
        {
          env,
          extendEnv: false,
        },
      );
      const version = parseVersion(stdout);
      if (version && isOlderThan(version, MIN_CLAUDE_VERSION)) {
        logger.warn(
          `[harness:claude_code] detected claude ${version} < minimum ${MIN_CLAUDE_VERSION}; stream-json output may drift`,
        );
      }
      const auth = await execa(
        resolveHarnessExecutable('claude'),
        ['auth', 'status'],
        {
          env,
          extendEnv: false,
          reject: false,
          timeout: 10_000,
        },
      );
      const authDetails = resolveClaudeAuthDetails(
        auth.stdout,
        hasClaudeApiCredential(env),
      );
      const apiCredential = claudeApiCredential(env);
      const cliMetadata =
        authDetails.authMethod === 'cli' ? readClaudeCliMetadata() : undefined;
      return {
        installed: true,
        version,
        authenticated: authDetails.authenticated,
        authMethod: authDetails.authMethod,
        credentialHint:
          authDetails.authMethod === 'api_key' && apiCredential
            ? apiCredential.slice(-4)
            : undefined,
        ...cliMetadata,
      };
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
  async startTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle> {
    if (this.rawPtySpawner !== undefined) {
      return this.startPtyTurn(opts, sink);
    }
    return this.startChildProcessTurn(opts, sink);
  }

  private startChildProcessTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle> {
    const args = buildArgs(opts);
    const command = resolveHarnessExecutable('claude');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.workspaceDir,
        env: childProcessEnv(),
        // Never a shell — args are passed as an array (command-injection defense).
        shell: false,
        // The CLI is prompt-driven through argv/temp files; stdin is unused, but keep a
        // valid fd open. Some CLI wrappers spawn helper binaries with stdio inherited;
        // closing fd 0 can make that inner spawn fail with EBADF.
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(
        formatSpawnFailure(command, args, opts.workspaceDir, err),
      );
    }

    const splitter = createJsonLineSplitter((msg) =>
      logger.warn(`[harness:claude_code] ${msg}`),
    );

    let sessionId = opts.sessionId ?? '';
    let terminalEmitted = false;
    let textEmitted = false;
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
          const resultText = resultTextFallback(obj);
          if (!textEmitted && resultText !== undefined) {
            textEmitted = true;
            sink.push({ kind: 'text', delta: resultText });
          }
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
              if (result.event.kind === 'text') {
                textEmitted = true;
              }
              sink.push(result.event);
            }
          }
        }
      }

      child.stdout!.on('data', (buf: Buffer) => {
        consume(splitter.push(buf.toString('utf8')));
      });

      // stderr is diagnostic only — never echo it as content, never log it verbatim
      // (it can carry prompt/tool fragments). Length is enough to spot noise.
      child.stderr!.on('data', (buf: Buffer) => {
        logger.debug(
          `[harness:claude_code] stderr (${buf.length} bytes) for cwd=${opts.workspaceDir}`,
        );
      });

      child.on('error', (err: Error) => {
        // spawn failure (e.g. `claude` not on PATH) — surface as a terminal error.
        if (!terminalEmitted) {
          sink.push({
            kind: 'error',
            message: formatSpawnFailure(command, args, opts.workspaceDir, err),
          });
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

  private async startPtyTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle> {
    const args = buildArgs(opts);
    const command = resolveHarnessExecutable('claude');
    const captureDir = mkdtempSync(join(tmpdir(), 'harness-claude-stream-'));
    const stdoutPath = join(captureDir, 'stdout');
    const stderrPath = join(captureDir, 'stderr');
    let handle: RawPtyHandle;
    try {
      handle = await this.rawPtySpawner!.spawn({
        cwd: opts.workspaceDir,
        shell: '/bin/zsh',
        args: [
          '-f',
          '-c',
          '"$0" "$@" > "$HARNESS_AGENT_STDOUT" 2> "$HARNESS_AGENT_STDERR"',
          command,
          ...args,
        ],
        env: childProcessEnv({
          HARNESS_AGENT_STDOUT: stdoutPath,
          HARNESS_AGENT_STDERR: stderrPath,
        }),
        // The PTY is only a process-launch transport here. JSON is captured via files
        // so terminal wrapping cannot corrupt newline-delimited stream-json.
        cols: 120,
        rows: 40,
      });
    } catch (err) {
      rmSync(captureDir, { recursive: true, force: true });
      throw new Error(
        formatSpawnFailure(command, args, opts.workspaceDir, err),
      );
    }

    const splitter = createJsonLineSplitter((msg) =>
      logger.warn(`[harness:claude_code] ${msg}`),
    );

    let sessionId = opts.sessionId ?? '';
    let terminalEmitted = false;
    let textEmitted = false;
    let settled = false;
    let ended = false;
    let timer: ReturnType<typeof setTimeout>;
    let poller: ReturnType<typeof setInterval> | undefined;
    let stdoutOffset = 0;

    return new Promise<TurnHandle>((resolve) => {
      timer = setTimeout(resolveHandle, SESSION_RESOLVE_TIMEOUT_MS);
      poller = setInterval(readCapturedStdout, 50);

      const interrupt = async (): Promise<void> => {
        handle.kill();
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
        if (poller !== undefined) {
          clearInterval(poller);
          poller = undefined;
        }
        sink.end();
        rmSync(captureDir, { recursive: true, force: true });
      }

      function consume(objects: unknown[]): void {
        for (const obj of objects) {
          const resultText = resultTextFallback(obj);
          if (!textEmitted && resultText !== undefined) {
            textEmitted = true;
            sink.push({ kind: 'text', delta: resultText });
          }
          for (const result of normalize(obj)) {
            if (!result) continue;
            if (result.type === 'session') {
              sessionId = result.sessionId;
              resolveHandle();
            } else {
              if (
                result.event.kind === 'turn_end' ||
                result.event.kind === 'error'
              ) {
                terminalEmitted = true;
              }
              if (result.event.kind === 'text') {
                textEmitted = true;
              }
              sink.push(result.event);
            }
          }
        }
      }

      function readCapturedStdout(): void {
        const next = readNewBytes(stdoutPath, stdoutOffset);
        if (next === null) return;
        stdoutOffset = next.offset;
        consume(splitter.push(next.text));
      }

      handle.onExit(({ exitCode }) => {
        readCapturedStdout();
        consume(splitter.flush());
        const stderrBytes = fileSize(stderrPath);
        if (stderrBytes > 0) {
          logger.debug(
            `[harness:claude_code] stderr (${stderrBytes} bytes) for cwd=${opts.workspaceDir}`,
          );
        }
        if (!terminalEmitted) {
          if (exitCode !== 0) {
            sink.push({
              kind: 'error',
              message: `claude exited with code ${exitCode}`,
            });
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

export function parseClaudeAuthStatus(stdout: string): boolean {
  return parseClaudeAuthDetails(stdout).authenticated;
}

export function resolveClaudeAuthDetails(
  stdout: string,
  hasApiCredential: boolean,
): {
  authenticated: boolean;
  authMethod: AgentAuthMethod;
} {
  if (hasApiCredential) {
    return { authenticated: true, authMethod: 'api_key' };
  }
  return parseClaudeAuthDetails(stdout);
}

export function parseClaudeAuthDetails(stdout: string): {
  authenticated: boolean;
  authMethod: AgentAuthMethod;
} {
  try {
    const status = JSON.parse(stdout) as {
      loggedIn?: unknown;
      authMethod?: unknown;
      apiProvider?: unknown;
    };
    if (status.loggedIn !== true) {
      return { authenticated: false, authMethod: 'none' };
    }
    const method =
      typeof status.authMethod === 'string'
        ? status.authMethod.toLowerCase()
        : '';
    const apiProvider =
      typeof status.apiProvider === 'string'
        ? status.apiProvider.toLowerCase()
        : '';
    return {
      authenticated: true,
      authMethod:
        method.includes('console') ||
        method.includes('api') ||
        (apiProvider !== '' && apiProvider !== 'firstparty')
          ? 'api_key'
          : 'cli',
    };
  } catch {
    return { authenticated: false, authMethod: 'none' };
  }
}

function hasClaudeApiCredential(env: Record<string, string>): boolean {
  return claudeApiCredential(env) !== undefined;
}

function claudeApiCredential(env: Record<string, string>): string | undefined {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function parseClaudeCliMetadata(rawConfig: string): {
  providerLabel: string;
  planLabel?: string;
  authLabel: string;
  accountLabel?: string;
} {
  const fallback = { providerLabel: 'anthropic', authLabel: 'Claude login' };
  try {
    const config = JSON.parse(rawConfig) as {
      oauthAccount?: {
        emailAddress?: unknown;
        billingType?: unknown;
        organizationRateLimitTier?: unknown;
      };
    };
    const account = config.oauthAccount;
    const planSource =
      typeof account?.organizationRateLimitTier === 'string'
        ? account.organizationRateLimitTier
        : typeof account?.billingType === 'string'
          ? account.billingType
          : undefined;
    return {
      ...fallback,
      ...(planSource ? { planLabel: claudePlanLabel(planSource) } : {}),
      ...(typeof account?.emailAddress === 'string'
        ? { accountLabel: account.emailAddress }
        : {}),
    };
  } catch {
    return fallback;
  }
}

function readClaudeCliMetadata(): ReturnType<typeof parseClaudeCliMetadata> {
  try {
    return parseClaudeCliMetadata(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    );
  } catch {
    return parseClaudeCliMetadata('');
  }
}

function claudePlanLabel(value: string): string {
  const normalized = value.toLowerCase();
  for (const plan of ['enterprise', 'team', 'max', 'pro']) {
    if (normalized.includes(plan)) {
      return plan[0]!.toUpperCase() + plan.slice(1);
    }
  }
  return normalized.includes('subscription') ? 'Subscription' : value;
}

function formatSpawnFailure(
  command: string,
  args: readonly string[],
  cwd: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = isErrnoException(err) ? err.code : undefined;
  const lines = [
    `Failed to start ${command}: ${message}`,
    `Command: ${command} ${redactPromptArgs(args).join(' ')}`,
    `Working directory: ${cwd}`,
  ];
  if (code === 'EBADF' || message.includes('EBADF')) {
    lines.push(
      'Likely cause: the CLI or one of its wrapper/helper processes tried to inherit a closed file descriptor.',
      'This is usually an Electron/process stdio issue, not a model response error.',
    );
  } else if (code === 'ENOENT') {
    lines.push(
      `Likely cause: ${command} was not found on PATH for the Electron main process.`,
    );
  }
  return lines.join('\n');
}

function redactPromptArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-p' && i + 1 < args.length) {
      out.push(arg, '<prompt omitted>');
      i += 1;
    } else {
      out.push(arg);
    }
  }
  return out;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function resultTextFallback(obj: unknown): string | undefined {
  if (!isRecord(obj)) return undefined;
  if (obj.type !== 'result') return undefined;
  if (obj.is_error === true) return undefined;
  const subtype = typeof obj.subtype === 'string' ? obj.subtype : undefined;
  if (subtype?.startsWith('error')) return undefined;
  const result = obj.result;
  return typeof result === 'string' && result !== '' ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNewBytes(
  path: string,
  offset: number,
): { text: string; offset: number } | null {
  try {
    const bytes = readFileSync(path);
    if (bytes.length <= offset) return null;
    return {
      text: bytes.subarray(offset).toString('utf8'),
      offset: bytes.length,
    };
  } catch {
    return null;
  }
}

function fileSize(path: string): number {
  try {
    return readFileSync(path).length;
  } catch {
    return 0;
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

  // Plan mode must reach Claude as an actual read-only planning turn. The renderer
  // offers a separate approval action that resumes the session in default mode.
  // Other modes remain non-blocking because Harness has no generic permission bridge.
  if (opts.mode === 'plan') {
    args.push('--permission-mode', 'plan');
  } else {
    args.push('--dangerously-skip-permissions');
  }

  // Phase 12: optional model override (e.g. `--model sonnet`). A DISCRETE argv element
  // under spawn(shell:false) — never string-interpolated. The value is validated against
  // MODEL_PATTERN at the IPC boundary before it can reach here, so a hostile string stays
  // an inert single argument rather than shell.
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.effort) {
    args.push('--effort', opts.effort);
  }

  const mcpConfigPath = writeMcpConfig(opts.mcpConfig);
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }

  return args;
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
