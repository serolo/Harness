// IPC registration for the MAIN process (README §6.2, phase-0 §3.6).
//
// `registerIpc(ctx)` is called once from `src/main/index.ts` (Task 9) after the
// AppContext is assembled. It wires:
//   - every request/response command in `Commands` (@shared/ipc) via `handle()`,
//     which wraps EVERY handler in the error boundary (§7.2);
//   - the scoped-stream control channels (`stream:start`, `stream:cancel`) that back
//     `api.stream(...)` and the `createStream()` helper;
//   - the `app:echoStream` streaming DEMO, proving the pattern (incl. backpressure)
//     end-to-end.
//
// ERROR BOUNDARY (the important invariant): a handler that throws must reject the
// renderer's `invoke` with a value from which a typed `AppError` (code + details) can
// be reconstructed. Electron does NOT clone a value thrown from `ipcMain.handle` — it
// delivers ONLY the error message string (a fresh generic Error on the renderer side;
// a thrown plain object becomes `[object Object]`). So `handle` catches, normalizes via
// `toAppError`, and throws an `Error` whose message ENCODES the serialized shape
// (`encodeAppErrorMessage`); the preload decodes it back with `decodeAppErrorMessage`.
// (Streams differ: they use `webContents.send`, which clones intact — see stream.ts.)

import { app, dialog, BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { basename } from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { v7 as uuidv7 } from 'uuid';
import { Octokit } from '@octokit/rest';
import type {
  CommandChannel,
  CommandReq,
  CommandRes,
  StreamArg,
  StreamChannel,
  StreamChunk,
} from '@shared/ipc';
import type { StreamSink } from '@shared/ipc';
import type { AgentEvent, HarnessId, StartTurnOpts } from '@shared/harness';
import type { SlashCommand } from '@shared/slash';
import type { AppContext } from '../context';
import { toAppError } from '../error';
import { AppError, encodeAppErrorMessage } from '@shared/errors';
import { logger } from '../logging';
import { ProjectsRepo } from '../db/repos/projects';
import { TodosRepo } from '../db/repos/todos';
import { MODEL_PATTERN, type TaskState } from '@shared/tasks';
import { emitAll } from './events';
import { GithubClient, parseOwnerName } from '../integrations/github/client';
import {
  githubCliAuthStatus,
  githubCliToken,
} from '../integrations/github/ghCli';
import { discoverGitSshKeys } from '../git/sshKeys';
import type { GithubAccount } from '@shared/github';
import type { LinearAccount } from '@shared/linear';
import { repoDir } from '../paths';
import { EffectiveSettingsSchema } from '../settings/schema';
import { resolveDeepLink } from '../deeplink';
import { buildEnv } from '../process/env';
import type { PtyChunk } from '../pty';
import {
  createStream,
  handleStreamCancel,
  STREAM_CANCEL_CHANNEL,
} from './stream';

/** Control channel the renderer invokes to begin a scoped stream. */
const STREAM_START_CHANNEL = 'stream:start';

const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'review',
    template:
      'Please review the current changes. Focus on correctness bugs, security issues, and missing tests.',
    description: 'Review current changes',
  },
  {
    name: 'fix-checks',
    template:
      'Investigate and fix the failing checks. Run the relevant tests again when done.\n\n$ARGS',
    description: 'Fix failing checks',
  },
  {
    name: 'explain',
    template: 'Explain this code or behavior clearly.\n\n$ARGS',
    description: 'Explain code or behavior',
  },
  {
    name: 'plan',
    template: 'Create a concise implementation plan for this task.\n\n$ARGS',
    description: 'Create an implementation plan',
  },
];

/**
 * Workspace ids whose merge-readiness checks the renderer has fetched (via `checks:get`).
 * The main entry (`src/main/index.ts`) recomputes exactly these on window `focus` (spec
 * §5.5). Deduped by the Set; membership is additive (a workspace the user has looked at
 * keeps refreshing on focus). Populated here, drained by {@link focusRefreshWorkspaceIds}.
 */
const trackedFocusRefreshIds = new Set<string>();

/** Record a workspace id so a later window focus recomputes its checks (Phase 5). */
function trackForFocusRefresh(workspaceId: string): void {
  trackedFocusRefreshIds.add(workspaceId);
}

/**
 * Snapshot of the workspace ids to recompute checks for on window focus. Returned as an
 * array copy so the caller can iterate without racing further `checks:get` calls that
 * mutate the backing Set. Consumed by the `focus` listener wired in `src/main/index.ts`.
 */
export function focusRefreshWorkspaceIds(): string[] {
  return [...trackedFocusRefreshIds];
}

/** States a task can be `runNow`/`markDone` from (anything but `running`/`done`). */
const RUNNABLE_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'pending',
  'scheduled',
  'missed',
  'error',
  'queued',
]);

/** Narrow an untrusted string to the closed `AgentMode` set. */
function isAgentMode(value: unknown): boolean {
  return value === 'plan' || value === 'default' || value === 'auto_accept';
}

/** True when a task may be fired / marked done (state gate for `task:runNow`/`markDone`). */
function isRunnableState(state: TaskState): boolean {
  return RUNNABLE_TASK_STATES.has(state);
}

/** Broadcast `task:changed` for a workspace to every open renderer (Phase 12). */
function emitTaskChanged(workspaceId: string): void {
  emitAll(
    BrowserWindow.getAllWindows().map((w) => w.webContents),
    'task:changed',
    { workspaceId },
  );
}

/**
 * Normalize any thrown value into the `Error` that must be thrown from an
 * `ipcMain.handle` handler so the renderer can rebuild a typed `AppError`. Electron
 * only carries the message across a handle() rejection, so we encode the serialized
 * shape into it (`encodeAppErrorMessage`); the preload decodes it (`decodeAppErrorMessage`).
 */
function toBoundaryError(channelLabel: string, e: unknown): Error {
  const appError = toAppError(e);
  logger.error(`[ipc:${channelLabel}] ${appError.code}: ${appError.message}`);
  return new Error(encodeAppErrorMessage(appError.toJSON()));
}

/**
 * Register one command handler wrapped in the error boundary. The `channel`/`req`/`res`
 * types are pinned to the `Commands` map so a wrong channel name, request shape, or
 * return type is a compile error at the call site.
 *
 * On success the resolved value crosses the boundary as-is. On throw, ANY thrown value
 * is normalized to an `AppError`, logged, and re-thrown as its serialized plain shape so
 * it survives structured clone (see file header).
 */
function handle<C extends CommandChannel>(
  channel: C,
  fn: (req: CommandReq<C>, event: IpcMainInvokeEvent) => Promise<CommandRes<C>>,
): void {
  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, req: CommandReq<C>) => {
      try {
        return await fn(req, event);
      } catch (e) {
        // Encode the serialized shape into the Error message — Electron only carries
        // the message across a handle() rejection (see file header). Preload decodes it.
        throw toBoundaryError(channel, e);
      }
    },
  );
}

/**
 * A stream producer: given the start argument, the target renderer, and a typed sink,
 * it pushes chunks and eventually calls `end()`/`error()`. One producer per
 * `StreamChannel`. Producers must not throw synchronously; failures go through
 * `sink.error(...)` so the renderer sees a typed AppError on the stream.
 */
type StreamProducer<S extends StreamChannel> = (
  arg: StreamArg<S>,
  ctx: AppContext,
  sink: StreamSink<StreamChunk<S>>,
) => void | (() => void);

/**
 * Derive a human-friendly project name from a clone URL. Takes the last non-empty
 * path or `:` segment (so both `https://host/owner/repo.git` and
 * `git@host:owner/repo.git` yield `repo`), strips a trailing `.git`, and falls back
 * to `'project'` when nothing usable remains.
 */
function projectNameFromUrl(url: string): string {
  const segments = url.split(/[/:]/).filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? '';
  const name = last.replace(/\.git$/, '');
  return name.length > 0 ? name : 'project';
}

/**
 * Resolve the GitHub owner/repo for a project. Prefer the persisted origin URL, but
 * fall back to the repo's current `origin` config so locally-added projects or remotes
 * changed after registration still work in the PR/issue picker.
 */
async function githubRepoForProject(
  ctx: AppContext,
  project: { originUrl: string; repoPath: string },
): Promise<{ owner: string; name: string }> {
  const info = await ctx.git.open(project.repoPath);
  if (info.originUrl !== '') {
    try {
      return parseOwnerName(info.originUrl);
    } catch {
      // Fall through to the persisted project URL below.
    }
  }

  if (project.originUrl !== '') {
    return parseOwnerName(project.originUrl);
  }

  throw new AppError(
    'integration',
    'project does not have a GitHub origin remote',
  );
}

/**
 * Resolve the GitHub API client according to local Settings semantics. If the GitHub
 * CLI is authenticated, use that token first; otherwise fall back to the encrypted
 * integration row. The token stays in main either way.
 */
async function githubClientForSettings(ctx: AppContext): Promise<Octokit> {
  const cli = await githubCliAuthStatus();
  if (cli.authenticated) {
    return new Octokit({ auth: await githubCliToken() });
  }
  return ctx.integrations.github();
}

/**
 * Launch an external IDE at `worktreePath`. Uses `spawn` with an ARGUMENT ARRAY (never a
 * shell string) so the workspace-derived path cannot be interpreted as a command
 * (heightened-scrutiny path). The child is `detached` + `unref`'d so the IDE outlives the
 * app; we resolve on the `spawn` event (or reject with a typed error if the binary is
 * missing / not on PATH). `ide` is enum-validated by the caller.
 */
function openInIde(
  ide: 'cursor' | 'code',
  worktreePath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(ide, [worktreePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', (err) =>
      reject(
        new AppError('internal', `failed to launch ${ide}: ${err.message}`),
      ),
    );
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * The registry of stream producers, keyed by `StreamChannel`. Adding a new streaming
 * channel = adding an entry here (and to `StreamChannels` in @shared/ipc). Typed so a
 * producer's `arg`/`chunk` must match the channel's frozen contract.
 */
const streamProducers: { [S in StreamChannel]: StreamProducer<S> } = {
  // Demo: echo `text` back word-by-word as chunks, then end. Proves createStream()
  // end-to-end including the microtask-batched send (soft backpressure): pushing the
  // whole split synchronously does not block the event loop — frames flush in batches.
  'app:echoStream': (arg, _ctx, sink) => {
    const words = arg.text.length > 0 ? arg.text.split(/(\s+)/) : [];
    for (const word of words) {
      sink.push(word);
    }
    sink.end();
  },

  // Clone a remote repo: stream `git clone --progress` frames, then open the fresh
  // clone to resolve its origin/default-branch, persist the Project, and push the
  // terminal `{ phase: 'done', project }` frame over the SAME stream. Async work runs
  // in an IIFE so the producer never throws synchronously; failures route to
  // `sink.error(...)` (mirrors how `registerStreamControl` wraps the producer).
  'project:clone': (arg, ctx, sink) => {
    const controller = new AbortController();
    let dest: string | undefined;
    void (async () => {
      try {
        const projects = new ProjectsRepo(ctx.db);
        dest = repoDir(uuidv7()); // unique on-disk repo dir; the DB row gets its own id
        await ctx.git.clone(arg.url, dest, (p) => sink.push(p), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const info = await ctx.git.open(dest);
        if (controller.signal.aborted) return;
        const project = await projects.create({
          name: projectNameFromUrl(arg.url),
          originUrl: info.originUrl.length > 0 ? info.originUrl : arg.url,
          defaultBranch: info.defaultBranch,
          repoPath: dest,
        });
        sink.push({ phase: 'done', project });
        sink.end();
      } catch (e) {
        if (controller.signal.aborted) return;
        sink.error(toAppError(e));
      } finally {
        if (controller.signal.aborted && dest !== undefined) {
          await rm(dest, { recursive: true, force: true }).catch(() => {});
        }
      }
    })();
    return () => controller.abort();
  },

  // Create a workspace: delegate to WorkspaceManager, mapping each setup-log chunk to a
  // `{ kind: 'setupLog' }` frame, then push the terminal `{ kind: 'created', workspace }`
  // frame. Async work runs in an IIFE; failures route to `sink.error(...)`.
  'workspace:create': (arg, ctx, sink) => {
    void (async () => {
      try {
        const workspace = await ctx.workspaces.create(arg, (chunk) =>
          sink.push({ kind: 'setupLog', chunk }),
        );
        sink.push({ kind: 'created', workspace });
        sink.end();
      } catch (e) {
        sink.error(toAppError(e));
      }
    })();
  },

  // Start an agent turn: resolve the workspace + StartTurnOpts (settings + resume
  // sessionId + worktree cwd), then drive the supervisor. Each normalized AgentEvent
  // becomes an `{ kind: 'event' }` frame; a leading `{ kind: 'started' }` frame carries
  // the turnId + resolved sessionId. Events are buffered until `started` is emitted so
  // the renderer always sees `started` first. The supervisor `end()`s on the terminal
  // event; failures route to `sink.error(...)`.
  'turn:start': (arg, ctx, sink) => {
    void (async () => {
      try {
        // Validate + narrow the untrusted payload before acting.
        if (typeof arg.workspaceId !== 'string' || arg.workspaceId === '') {
          throw new AppError('invalid_input', 'workspaceId is required');
        }
        if (typeof arg.prompt !== 'string' || arg.prompt.trim() === '') {
          throw new AppError('invalid_input', 'prompt is required');
        }
        const attachments = Array.isArray(arg.attachments)
          ? arg.attachments
          : [];

        const workspace = await ctx.workspaces.get(arg.workspaceId);
        if (!workspace) {
          throw new AppError('not_found', 'workspace not found', {
            workspaceId: arg.workspaceId,
          });
        }
        if (!workspace.worktreePath) {
          throw new AppError(
            'conflict',
            'workspace has no worktree (archived?)',
            { workspaceId: arg.workspaceId },
          );
        }

        const harnessOverride =
          typeof arg.harness === 'string'
            ? (arg.harness as HarnessId)
            : undefined;
        if (
          harnessOverride !== undefined &&
          !['claude_code', 'codex', 'cursor'].includes(harnessOverride)
        ) {
          throw new AppError('invalid_input', 'unknown harness', {
            harness: harnessOverride,
          });
        }

        const settings = ctx.settings.get();
        const sessionId =
          harnessOverride === undefined || harnessOverride === workspace.harness
            ? await ctx.recorder.latestSessionId(arg.workspaceId)
            : undefined;
        const opts: StartTurnOpts = {
          workspaceDir: workspace.worktreePath,
          prompt: arg.prompt,
          attachments,
          sessionId,
          mode: arg.mode ?? settings.agent.mode,
          mcpConfig: settings.mcp,
          permissionPolicy: settings.agent.permissionPolicy,
        };

        // Buffer events until the `started` frame is sent (started-first guarantee).
        let started = false;
        const buffered: AgentEvent[] = [];
        const agentSink: StreamSink<AgentEvent> = {
          push: (event) => {
            if (started) sink.push({ kind: 'event', event });
            else buffered.push(event);
          },
          end: () => sink.end(),
          error: (e) => sink.error(e),
        };

        const handle = await ctx.harness.startTurn(
          arg.workspaceId,
          opts,
          agentSink,
          harnessOverride,
        );
        const turnId = ctx.harness.getActiveTurnId(arg.workspaceId) ?? '';
        sink.push({ kind: 'started', turnId, sessionId: handle.sessionId });
        started = true;
        for (const event of buffered) {
          sink.push({ kind: 'event', event });
        }
      } catch (e) {
        sink.error(toAppError(e));
      }
    })();
  },

  // Open a PTY in a workspace's worktree. Resolves the workspace (rejecting a
  // missing/archived one), builds its env via `buildEnv`, spawns the shell, and streams
  // its output. A leading `{ kind: 'started', ptyId }` frame carries the id (used to key
  // `pty:write`/`pty:resize`/`pty:close`); subsequent `{ kind: 'data' }` frames carry
  // raw shell output. Data is buffered until `started` is sent (started-first guarantee,
  // mirroring `turn:start`). Async work runs in an IIFE; failures route to `sink.error`.
  'pty:open': (arg, ctx, sink) => {
    void (async () => {
      try {
        if (typeof arg.workspaceId !== 'string' || arg.workspaceId === '') {
          throw new AppError('invalid_input', 'workspaceId is required');
        }
        const workspace = await ctx.workspaces.get(arg.workspaceId);
        if (!workspace) {
          throw new AppError('not_found', 'workspace not found', {
            workspaceId: arg.workspaceId,
          });
        }
        if (!workspace.worktreePath) {
          throw new AppError(
            'conflict',
            'workspace has no worktree (archived?)',
            {
              workspaceId: arg.workspaceId,
            },
          );
        }

        const settings = ctx.settings.get();
        const env = buildEnv({
          port: workspace.port ?? 0,
          worktreePath: workspace.worktreePath,
          name: workspace.name,
          settingsEnv: settings.env,
        });

        // Buffer output until the `started` frame is sent (started-first guarantee).
        let started = false;
        const buffered: string[] = [];
        const ptySink: StreamSink<PtyChunk> = {
          push: (chunk) => {
            if (started) sink.push({ kind: 'data', data: chunk.data });
            else buffered.push(chunk.data);
          },
          end: () => sink.end(),
          error: (e) => sink.error(e),
        };

        const ptyId = await ctx.pty.spawn(
          {
            workspaceId: arg.workspaceId,
            cwd: workspace.worktreePath,
            env,
            cols: arg.cols,
            rows: arg.rows,
          },
          ptySink,
        );
        sink.push({ kind: 'started', ptyId });
        started = true;
        for (const data of buffered) sink.push({ kind: 'data', data });
      } catch (e) {
        sink.error(toAppError(e));
      }
    })();
  },

  // Start a configured run script in a workspace's worktree. Resolves the workspace +
  // the named script from settings (rejecting missing/archived/unknown), builds its env,
  // and drives `ProcessRunner.start`. A leading `{ kind: 'started', runId }` frame carries
  // the id (used to key `run:stop`); `{ kind: 'log' }` frames carry combined stdout/stderr;
  // the terminal `{ kind: 'exit', code, durationMs }` frame ends the stream — routed through
  // the runner's `onExit` so the overlay clears even on crash. Log/exit frames are buffered
  // until `started` is sent. Async work runs in an IIFE; failures route to `sink.error`.
  'run:start': (arg, ctx, sink) => {
    void (async () => {
      try {
        if (typeof arg.workspaceId !== 'string' || arg.workspaceId === '') {
          throw new AppError('invalid_input', 'workspaceId is required');
        }
        if (typeof arg.scriptName !== 'string' || arg.scriptName === '') {
          throw new AppError('invalid_input', 'scriptName is required');
        }
        const workspace = await ctx.workspaces.get(arg.workspaceId);
        if (!workspace) {
          throw new AppError('not_found', 'workspace not found', {
            workspaceId: arg.workspaceId,
          });
        }
        if (!workspace.worktreePath) {
          throw new AppError(
            'conflict',
            'workspace has no worktree (archived?)',
            {
              workspaceId: arg.workspaceId,
            },
          );
        }

        const settings = ctx.settings.get();
        const script = settings.scripts.run.find(
          (s) => s.name === arg.scriptName,
        );
        if (!script) {
          throw new AppError('not_found', 'run script not configured', {
            scriptName: arg.scriptName,
          });
        }
        const env = buildEnv({
          port: workspace.port ?? 0,
          worktreePath: workspace.worktreePath,
          name: workspace.name,
          settingsEnv: settings.env,
        });

        // Buffer log/exit frames until the `started` frame is sent (started-first).
        let started = false;
        const buffered: Array<() => void> = [];
        const emit = (fn: () => void): void => {
          if (started) fn();
          else buffered.push(fn);
        };

        const runId = await ctx.process.start(
          {
            workspaceId: arg.workspaceId,
            name: script.name,
            command: script.command,
            cwd: workspace.worktreePath,
            env,
            mode: settings.scripts.run_mode,
          },
          {
            onLog: (chunk) => emit(() => sink.push({ kind: 'log', chunk })),
            onExit: (code, durationMs) =>
              emit(() => {
                sink.push({ kind: 'exit', code, durationMs });
                sink.end();
              }),
          },
        );
        sink.push({ kind: 'started', runId });
        started = true;
        for (const fn of buffered) fn();
      } catch (e) {
        sink.error(toAppError(e));
      }
    })();
  },

  // Connect a GitHub account (spec §5.6). Validate the untrusted start arg (`mode` enum;
  // a `pat` connect requires a non-empty token string), then drive
  // `IntegrationService.connectGithub`, forwarding each ConnectStatus frame over the
  // stream. `connectGithub` OWNS the single terminal frame (`connected`/`error`), so we
  // only forward its frames and then `end()`; a throw routes to `sink.error(...)` (its
  // token-free AppError). Async work runs in an IIFE so the producer never throws sync.
  'github:connect': (arg, ctx, sink) => {
    void (async () => {
      try {
        if (arg.mode !== 'device' && arg.mode !== 'pat') {
          throw new AppError('invalid_input', 'mode must be device|pat');
        }
        if (
          arg.mode === 'pat' &&
          (typeof arg.token !== 'string' || arg.token === '')
        ) {
          throw new AppError(
            'invalid_input',
            'a GitHub token is required for pat connect',
          );
        }
        await ctx.integrations.connectGithub(
          arg.mode,
          { token: arg.token },
          (frame) => sink.push(frame),
        );
        sink.end();
      } catch (e) {
        sink.error(toAppError(e));
      }
    })();
  },

  // Connect a Linear account (Phase 7, mirrors github:connect). Validate the untrusted
  // start arg (`mode` enum; API-key connect requires a non-empty token), then drive
  // `LinearService.connectLinear`, forwarding each LinearConnectStatus frame. connectLinear
  // OWNS the single terminal frame (connected/error), so we only forward + `end()`; a throw
  // routes to `sink.error(...)` (its token-free AppError). Async work runs in an IIFE so
  // the producer never throws synchronously.
  'linear:connect': (arg, ctx, sink) => {
    void (async () => {
      try {
        if (arg.mode !== 'apiKey') {
          throw new AppError('invalid_input', 'mode must be apiKey');
        }
        if (typeof arg.token !== 'string' || arg.token === '') {
          throw new AppError('invalid_input', 'a Linear API key is required');
        }
        await ctx.linear.connectLinear(
          arg.mode,
          { token: arg.token },
          (frame) => sink.push(frame),
        );
        sink.end();
      } catch (e) {
        sink.error(toAppError(e));
      }
    })();
  },
};

/**
 * Wire the scoped-stream control channels. The renderer's `api.stream(channel, arg)`:
 *   1. invokes `stream:start` → main allocates a subscription id, starts the producer,
 *      and returns `{ id }`;
 *   2. subscribes to `stream:<id>` for `chunk`/`end`/`error` frames;
 *   3. sends `stream:cancel` with the id if it tears down before `end`.
 *
 * `stream:start` is itself inside the error boundary (an unknown channel rejects with a
 * serialized `invalid_input` AppError). Once the producer runs, per-chunk failures flow
 * over the stream via `sink.error`, not the invoke rejection.
 */
function registerStreamControl(ctx: AppContext): void {
  ipcMain.handle(
    STREAM_START_CHANNEL,
    async (
      event: IpcMainInvokeEvent,
      payload: { channel: StreamChannel; arg: unknown },
    ): Promise<{ id: string }> => {
      try {
        const producer = streamProducers[payload.channel] as
          StreamProducer<StreamChannel> | undefined;
        if (!producer) {
          throw toAppError(
            new Error(`unknown stream channel: ${String(payload.channel)}`),
          );
        }
        let producerTeardown: (() => void) | undefined;
        const { id, sink } = createStream<StreamChunk<StreamChannel>>({
          webContents: event.sender,
          onClose: () => producerTeardown?.(),
        });
        // Kick the producer on the next tick so the renderer has the id + its
        // `stream:<id>` listener attached before the first chunk can arrive.
        queueMicrotask(() => {
          try {
            producerTeardown =
              producer(payload.arg as StreamArg<StreamChannel>, ctx, sink) ??
              undefined;
          } catch (e) {
            sink.error(toAppError(e));
          }
        });
        return { id };
      } catch (e) {
        throw toBoundaryError(STREAM_START_CHANNEL, e);
      }
    },
  );

  // Single shared cancel listener → dispatches to the per-id teardown in stream.ts.
  // One ipcMain listener total (not one per stream) is itself a leak-avoidance measure.
  ipcMain.on(
    STREAM_CANCEL_CHANNEL,
    (_event: IpcMainInvokeEvent | Electron.IpcMainEvent, id: string) => {
      handleStreamCancel(id);
    },
  );
}

/**
 * Register every Phase 0 command + the streaming control channels. Idempotent enough
 * for a single-window app (called once from `whenReady`); re-registering a channel
 * would throw, which is the desired signal if it is ever called twice.
 */
export function registerIpc(ctx: AppContext): void {
  // app:ping — the renderer health check (flips the "IPC OK" indicator).
  handle('app:ping', async () => 'ok');

  // app:info — static app/version info.
  handle('app:info', async () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
  }));

  // app:echoStream — the request/response half of the demo. The actual chunks flow
  // over the `app:echoStream` StreamChannel (started via `stream:start`); this command
  // exists so the contract has the { req; res } pair and so a caller can trigger a
  // one-shot without the stream if desired. It returns void immediately.
  handle('app:echoStream', async () => {
    // No-op on the command path; streaming is driven through `api.stream(...)`.
    return undefined;
  });

  // --- Phase 1: projects + workspaces ---

  // project:pickDirectory — open the OS directory picker. Anchor to the focused
  // window when one exists (modal sheet on macOS); tolerate no window (standalone).
  handle('project:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // project:add — register an existing local repo directory as a project, resolving
  // its origin URL + default branch via GitService before persisting the row.
  handle('project:add', async (req) => {
    const projects = new ProjectsRepo(ctx.db);
    const info = await ctx.git.open(req.localPath);
    return projects.create({
      name: basename(req.localPath),
      originUrl: info.originUrl,
      defaultBranch: info.defaultBranch,
      repoPath: req.localPath,
    });
  });

  // project:list — all registered projects, newest first.
  handle('project:list', async () => new ProjectsRepo(ctx.db).list());

  // project:listBranches — refresh origin refs first, then list all local + origin
  // branches that can be used as workspace base refs.
  handle('project:listBranches', async (req) => {
    if (typeof req.projectId !== 'string' || req.projectId === '') {
      throw new AppError('invalid_input', 'projectId is required');
    }
    const project = await new ProjectsRepo(ctx.db).getById(req.projectId);
    if (project === null) {
      throw new AppError('not_found', 'project not found', {
        projectId: req.projectId,
      });
    }
    if (project.originUrl !== '') {
      await ctx.git.fetch(project.repoPath);
    }
    const branches = await ctx.git.listBranches(project.repoPath);
    return { defaultBranch: project.defaultBranch, branches };
  });

  // workspace:list/get/archive/restore — delegate to the WorkspaceManager, the sole
  // owner of workspace lifecycle + status transitions (README §6.4).
  handle('workspace:list', async (req) =>
    ctx.workspaces.list(req.projectId, req.includeArchived),
  );
  handle('workspace:get', async (req) => ctx.workspaces.get(req.id));
  handle('workspace:archive', async (req) => {
    await ctx.workspaces.archive(req.id);
  });
  handle('workspace:restore', async (req) => ctx.workspaces.restore(req.id));

  // --- Phase 2: harness + chat ---

  // turn:interrupt — SIGINT the active turn for a workspace (no-op if none active).
  handle('turn:interrupt', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    await ctx.harness.interrupt(req.workspaceId);
  });

  // chat:history — reconstruct the full transcript. Fetching it also clears a
  // `needs_attention` workspace back to `idle` (D4: implicit "viewed" semantics).
  handle('chat:history', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (workspace?.status === 'needs_attention') {
      await ctx.workspaces.setStatus(req.workspaceId, 'idle');
    }
    const turns = await ctx.recorder.history(req.workspaceId);
    return { turns };
  });

  // harness:detect — probe a registered harness CLI.
  handle('harness:detect', async (req) => ctx.harness.detect(req.id));

  // harness:list — registered harnesses with capabilities + detect summary.
  handle('harness:list', async () => ctx.harness.listHarnesses());

  // --- Phase 3: terminals + run scripts ---
  // Every handler validates/narrows its untrusted payload before acting. The `pty:open`
  // and `run:start` STREAMS above allocate the ids; these commands act on them by id.

  // pty:write — forward keystrokes/paste to an open PTY.
  handle('pty:write', async (req) => {
    if (typeof req.ptyId !== 'string' || req.ptyId === '') {
      throw new AppError('invalid_input', 'ptyId is required');
    }
    if (typeof req.data !== 'string') {
      throw new AppError('invalid_input', 'data must be a string');
    }
    ctx.pty.write(req.ptyId, req.data);
  });

  // pty:resize — resize an open PTY to the xterm.js viewport (positive integer dims).
  handle('pty:resize', async (req) => {
    if (typeof req.ptyId !== 'string' || req.ptyId === '') {
      throw new AppError('invalid_input', 'ptyId is required');
    }
    if (
      !Number.isInteger(req.cols) ||
      !Number.isInteger(req.rows) ||
      req.cols <= 0 ||
      req.rows <= 0
    ) {
      throw new AppError(
        'invalid_input',
        'cols/rows must be positive integers',
      );
    }
    ctx.pty.resize(req.ptyId, req.cols, req.rows);
  });

  // pty:close — kill an open PTY (deregisters it from the ProcessRegistry).
  handle('pty:close', async (req) => {
    if (typeof req.ptyId !== 'string' || req.ptyId === '') {
      throw new AppError('invalid_input', 'ptyId is required');
    }
    ctx.pty.kill(req.ptyId);
  });

  // run:stop — tree-kill a running run script (SIGTERM→SIGKILL), resolving once gone.
  handle('run:stop', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (typeof req.runId !== 'string' || req.runId === '') {
      throw new AppError('invalid_input', 'runId is required');
    }
    await ctx.process.stop(req.runId);
  });

  // run:list — a workspace's configured run scripts, cross-referenced with what's live.
  handle('run:list', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    const settings = ctx.settings.get();
    const running = ctx.process.listRunning(req.workspaceId);
    return settings.scripts.run.map((s) => {
      const live = running.find((r) => r.scriptName === s.name);
      return {
        name: s.name,
        label: s.label,
        icon: s.icon,
        running: live !== undefined,
        runId: live?.runId,
      };
    });
  });

  // ide:open — launch an external IDE at the worktree. Enum-validate `ide`; spawn with an
  // arg ARRAY (no shell), detached+unref so it outlives us (heightened-scrutiny path).
  handle('ide:open', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (req.ide !== 'cursor' && req.ide !== 'code') {
      throw new AppError('invalid_input', 'unknown ide', {
        ide: String(req.ide),
      });
    }
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (!workspace) {
      throw new AppError('not_found', 'workspace not found', {
        workspaceId: req.workspaceId,
      });
    }
    if (!workspace.worktreePath) {
      throw new AppError('conflict', 'workspace has no worktree (archived?)', {
        workspaceId: req.workspaceId,
      });
    }
    await openInIde(req.ide, workspace.worktreePath);
  });

  // --- Phase 4: diff review + checkpoints ---
  // Every handler validates/narrows its untrusted payload before acting. Git runs only
  // through GitService arg arrays (no shell strings); file paths are traversal-checked
  // inside DiffService (heightened-scrutiny: IPC boundary + git/fs on user workspaces).

  // diff:get — the lightweight worktree-vs-merge-base file list (no patch). Starting the
  // diff also lazily starts the FS watcher (idempotent, inside getDiff).
  handle('diff:get', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    const gitDiff = await ctx.diff.getDiff(req.workspaceId);
    // Map the main-only GitDiff → the shared DiffSet (drop the raw patch; Monaco fetches
    // per-file content lazily via diff:file, keeping the list payload small).
    return {
      baseRef: gitDiff.baseRef,
      headRef: gitDiff.headRef,
      files: gitDiff.files.map((f) => ({
        path: f.path,
        oldPath: f.oldPath,
        change: f.change,
        additions: f.additions,
        deletions: f.deletions,
      })),
    };
  });

  // diff:file — per-file old/new content + parsed hunks (path traversal rejected in the
  // service). `path` must be a non-empty relative path.
  handle('diff:file', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (typeof req.path !== 'string' || req.path === '') {
      throw new AppError('invalid_input', 'path is required');
    }
    return ctx.diff.fileDiff(req.workspaceId, req.path);
  });

  // diff:commits — the commits in base..HEAD for the commit filter.
  handle('diff:commits', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    return ctx.diff.commits(req.workspaceId);
  });

  // comment:create — an inline diff comment (starts `open`). Narrow every field.
  handle('comment:create', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (typeof req.filePath !== 'string' || req.filePath === '') {
      throw new AppError('invalid_input', 'filePath is required');
    }
    if (typeof req.body !== 'string' || req.body.trim() === '') {
      throw new AppError('invalid_input', 'body is required');
    }
    const lineStart = req.lineStart;
    const lineEnd = req.lineEnd;
    if (
      (lineStart !== null && !Number.isInteger(lineStart)) ||
      (lineEnd !== null && !Number.isInteger(lineEnd))
    ) {
      throw new AppError(
        'invalid_input',
        'lineStart/lineEnd must be integers or null',
      );
    }
    if (req.side !== null && req.side !== 'old' && req.side !== 'new') {
      throw new AppError('invalid_input', 'side must be old|new|null');
    }
    return ctx.diff.addComment({
      workspaceId: req.workspaceId,
      filePath: req.filePath,
      lineStart,
      lineEnd,
      side: req.side,
      body: req.body,
    });
  });

  // comment:list — a workspace's comments, optionally filtered by lifecycle state.
  handle('comment:list', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (
      req.state !== undefined &&
      req.state !== 'open' &&
      req.state !== 'sent' &&
      req.state !== 'resolved'
    ) {
      throw new AppError('invalid_input', 'state must be open|sent|resolved');
    }
    return ctx.diff.listComments(req.workspaceId, req.state);
  });

  // comment:resolve — mark a comment resolved.
  handle('comment:resolve', async (req) => {
    if (typeof req.commentId !== 'string' || req.commentId === '') {
      throw new AppError('invalid_input', 'commentId is required');
    }
    await ctx.diff.setCommentState(req.commentId, 'resolved');
  });

  // comment:remove — delete a comment permanently.
  handle('comment:remove', async (req) => {
    if (typeof req.commentId !== 'string' || req.commentId === '') {
      throw new AppError('invalid_input', 'commentId is required');
    }
    await ctx.diff.removeComment(req.commentId);
  });

  // comment:sendToAgent — build `diff_comment` attachments for the open comments and mark
  // them sent. The renderer feeds the returned attachments into the existing turn:start.
  handle('comment:sendToAgent', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    return ctx.diff.buildSendToAgent(req.workspaceId);
  });

  // review:run — compose the settings review prompt with the current diff summary. Does
  // NOT start a turn itself (turns flow over turn:start); the renderer feeds `prompt` in.
  handle('review:run', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    const gitDiff = await ctx.diff.getDiff(req.workspaceId);
    const changeMark: Record<string, string> = {
      added: 'A',
      modified: 'M',
      deleted: 'D',
      renamed: 'R',
    };
    const summary =
      gitDiff.files.length === 0
        ? '(no changes vs the merge base)'
        : gitDiff.files
            .map(
              (f) =>
                `${changeMark[f.change] ?? '?'} ${f.path} (+${f.additions}/-${f.deletions})`,
            )
            .join('\n');
    const reviewPrompt = ctx.settings.get().agent.reviewPrompt;
    return {
      prompt: `${reviewPrompt}\n\nChanged files:\n${summary}`,
    };
  });

  // checkpoint:list — per-turn checkpoints for the timeline (backups excluded).
  handle('checkpoint:list', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    return ctx.checkpoint.list(req.workspaceId);
  });

  // checkpoint:revert — restore the worktree to a turn's checkpoint (auto-backup first,
  // no branch move, no git clean). Destructive — the renderer supplies the confirm.
  handle('checkpoint:revert', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (!Number.isInteger(req.turnIdx) || req.turnIdx < 0) {
      throw new AppError(
        'invalid_input',
        'turnIdx must be a non-negative integer',
      );
    }
    await ctx.checkpoint.revert(req.workspaceId, req.turnIdx);
  });

  // todo:list — user + agent todos for a workspace.
  handle('todo:list', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    return new TodosRepo(ctx.db).list(req.workspaceId);
  });

  // todo:create — a user-authored todo.
  handle('todo:create', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (typeof req.body !== 'string' || req.body.trim() === '') {
      throw new AppError('invalid_input', 'body is required');
    }
    return new TodosRepo(ctx.db).create({
      workspaceId: req.workspaceId,
      body: req.body,
    });
  });

  // todo:toggle — flip a todo's done flag.
  handle('todo:toggle', async (req) => {
    if (typeof req.id !== 'string' || req.id === '') {
      throw new AppError('invalid_input', 'id is required');
    }
    return new TodosRepo(ctx.db).toggle(req.id);
  });

  // --- Phase 5: GitHub + checks + PR (APPEND-ONLY) ---
  // Heightened-scrutiny: IPC boundary + secrets/tokens + network egress. Every handler
  // validates/narrows its untrusted payload first. Tokens NEVER cross to the renderer:
  // account rows are mapped to the token-free `GithubAccount` shape. GitHub-dependent
  // handlers degrade to a typed AppError (via `integrations.github()`) when no account is
  // connected. No payload is ever interpolated into a shell/git string.

  // github:accounts — connected GitHub accounts for the integrations UI. Maps the
  // main-only `Integration` rows to the renderer-facing `GithubAccount` (dropping the
  // `tokenRef` — the ciphertext ref must never leak to the renderer).
  handle('github:accounts', async () => {
    const rows = await ctx.integrations.list('github');
    return rows.map((row): GithubAccount => ({
      id: row.id,
      login: row.accountLabel ?? '',
      kind: 'github',
    }));
  });

  // github:disconnect — disconnect an integration + delete its ciphertext blob.
  handle('github:disconnect', async (req) => {
    if (typeof req.integrationId !== 'string' || req.integrationId === '') {
      throw new AppError('invalid_input', 'integrationId is required');
    }
    await ctx.integrations.disconnect(req.integrationId);
  });

  // github:cliStatus — local gh auth detection for Settings > Git. Token-free.
  handle('github:cliStatus', async () => githubCliAuthStatus());

  // github:connectGhCli — imports the local `gh auth token` into the encrypted
  // integration store. The token never crosses IPC or reaches the renderer.
  handle('github:connectGhCli', async () => {
    const token = await githubCliToken();
    let account: GithubAccount | null = null;
    await ctx.integrations.connectGithub('pat', { token }, (frame) => {
      if (frame.kind === 'connected') account = frame.account;
    });
    if (account === null) {
      throw new AppError(
        'integration',
        'GitHub CLI connection did not complete',
      );
    }
    return account;
  });

  // git:sshKeys — read-only SSH identity discovery for Settings > Git. The scanner
  // reads config/public-key metadata only; it never reads private key contents.
  handle('git:sshKeys', async () => discoverGitSshKeys());

  // --- Phase 7: Linear (mirrors github:*). Heightened-scrutiny (secrets): the plaintext
  // API key stays in LinearService/SecretStore — rows map to the token-free LinearAccount,
  // and every handler narrows its untrusted payload. Linear-dependent handlers degrade to a
  // typed AppError (via LinearService.linear()) when no account is connected.

  // linear:accounts — connected Linear accounts (token-free; drops the tokenRef).
  handle('linear:accounts', async () => {
    const rows = await ctx.linear.list();
    return rows.map((row): LinearAccount => ({
      id: row.id,
      label: row.accountLabel ?? '',
      kind: 'linear',
    }));
  });

  // linear:disconnect — disconnect a Linear integration + delete its ciphertext blob.
  handle('linear:disconnect', async (req) => {
    if (typeof req.integrationId !== 'string' || req.integrationId === '') {
      throw new AppError('invalid_input', 'integrationId is required');
    }
    await ctx.linear.disconnect(req.integrationId);
  });

  // linear:listIssues — issues for the active Linear account (the issue picker). `first`
  // (if supplied) must be a positive integer bounding the page.
  handle('linear:listIssues', async (req) => {
    if (
      req.first !== undefined &&
      (!Number.isInteger(req.first) || req.first <= 0)
    ) {
      throw new AppError('invalid_input', 'first must be a positive integer');
    }
    return ctx.linear.listIssues(
      req.first !== undefined ? { first: req.first } : undefined,
    );
  });

  // linear:link — write a workspace's branch/PR URL back to a Linear issue. At least one
  // of branchUrl/prUrl must be present (the service no-ops on empties, but reject an
  // entirely empty request so a misuse surfaces).
  handle('linear:link', async (req) => {
    if (typeof req.issueId !== 'string' || req.issueId === '') {
      throw new AppError('invalid_input', 'issueId is required');
    }
    if (
      (typeof req.branchUrl !== 'string' || req.branchUrl === '') &&
      (typeof req.prUrl !== 'string' || req.prUrl === '')
    ) {
      throw new AppError('invalid_input', 'a branchUrl or prUrl is required');
    }
    await ctx.linear.linkWorkspace({
      issueId: req.issueId,
      branchUrl: req.branchUrl,
      prUrl: req.prUrl,
    });
  });

  // linear:transition — settings-gated workflow-state transition (caller gates on the
  // setting before invoking).
  handle('linear:transition', async (req) => {
    if (typeof req.issueId !== 'string' || req.issueId === '') {
      throw new AppError('invalid_input', 'issueId is required');
    }
    if (typeof req.stateId !== 'string' || req.stateId === '') {
      throw new AppError('invalid_input', 'stateId is required');
    }
    await ctx.linear.transitionOnPr(req.issueId, req.stateId);
  });

  // checks:get — the aggregated merge-readiness checks for a workspace (spec §5.5).
  // Records the id in the focus-refresh set so a later window focus recomputes it.
  handle('checks:get', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    trackForFocusRefresh(req.workspaceId);
    return ctx.checks.get(req.workspaceId);
  });

  // pr:open — open (or return) a PR for the workspace's branch (spec §5.6). Title/body
  // are optional overrides; the workflow derives them when omitted.
  handle('pr:open', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    return ctx.prWorkflow.openPr(req.workspaceId, {
      draft: req.draft,
      title: req.title,
      body: req.body,
    });
  });

  // pr:merge — merge the workspace's PR with the chosen strategy (spec §5.6). `method` is
  // enum-validated here; the workflow itself is server-gated (refuses unless checks green).
  handle('pr:merge', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (
      req.method !== 'merge' &&
      req.method !== 'squash' &&
      req.method !== 'rebase'
    ) {
      throw new AppError('invalid_input', 'method must be merge|squash|rebase');
    }
    await ctx.prWorkflow.merge(req.workspaceId, req.method);
  });

  // pr:fixReviews — compose an agent turn addressing the PR's unresolved review threads.
  // Returns the prompt + attachments; the renderer feeds them into a normal turn:start.
  handle('pr:fixReviews', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    return ctx.prWorkflow.fixReviews(req.workspaceId);
  });

  // pr:fixChecks — compose an agent turn to fix the PR's failing CI checks (prompt +
  // attachments; the renderer feeds them into a normal turn:start).
  handle('pr:fixChecks', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    return ctx.prWorkflow.fixChecks(req.workspaceId);
  });

  // github:listPrs — a project's open PRs. Resolve the project's origin URL → owner/name,
  // build a per-repo client off the ACTIVE GitHub account (integrations.github() throws a
  // typed AppError when none is connected → graceful degrade), then list.
  handle('github:listPrs', async (req) => {
    if (typeof req.projectId !== 'string' || req.projectId === '') {
      throw new AppError('invalid_input', 'projectId is required');
    }
    const project = await new ProjectsRepo(ctx.db).getById(req.projectId);
    if (project === null) {
      throw new AppError('not_found', 'project not found', {
        projectId: req.projectId,
      });
    }
    const octokit = await githubClientForSettings(ctx);
    const client = new GithubClient(
      octokit,
      await githubRepoForProject(ctx, project),
    );
    return client.listPrs();
  });

  // github:listIssues — a project's open issues (PRs excluded by the client). Same
  // origin-resolution + active-account path as github:listPrs.
  handle('github:listIssues', async (req) => {
    if (typeof req.projectId !== 'string' || req.projectId === '') {
      throw new AppError('invalid_input', 'projectId is required');
    }
    const project = await new ProjectsRepo(ctx.db).getById(req.projectId);
    if (project === null) {
      throw new AppError('not_found', 'project not found', {
        projectId: req.projectId,
      });
    }
    const octokit = await githubClientForSettings(ctx);
    const client = new GithubClient(
      octokit,
      await githubRepoForProject(ctx, project),
    );
    return client.listIssues();
  });

  // review:resolveThread — mark a single GitHub review thread resolved (spec §5.6).
  handle('review:resolveThread', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (typeof req.threadId !== 'string' || req.threadId === '') {
      throw new AppError('invalid_input', 'threadId is required');
    }
    await ctx.prWorkflow.resolveThread(req.workspaceId, req.threadId);
  });

  // --- Phase 6: settings (write path + provenance + hot-reload) ---

  // settings:getEffective — the merged snapshot for the Settings UI.
  handle('settings:getEffective', async () => ctx.settings.get());

  // settings:getProvenance — which layer supplied each effective leaf.
  handle('settings:getProvenance', async () => ctx.settings.getProvenance());

  // settings:schema — the fully-defaulted settings object (a value-shaped schema the
  // UI keys sections/rows off). Reuses the same zod defaults the merge is built on.
  handle('settings:schema', async () => EffectiveSettingsSchema.parse({}));

  // settings:getIssues — layer validation issues from the most recent non-throwing
  // load (loadResult / hot-reload). No new backend logic: it exposes the seam the
  // watcher already populates so the Settings UI can surface a bad file + key instead
  // of the layer being silently dropped. Empty after a clean `load()`.
  handle('settings:getIssues', async () => ctx.settings.getIssues());

  // settings:set — HEIGHTENED-SCRUTINY (fs write on a user path). Narrow the untrusted
  // payload before touching disk: `layer` must be a writable layer enum, `keyPath` a
  // non-empty string. The service (`write.ts`) additionally rejects traversal / proto
  // pollution in the key path and validates the re-merged value; a violation rejects
  // through the error boundary without writing.
  handle('settings:set', async (req) => {
    if (
      req.layer !== 'user' &&
      req.layer !== 'project-shared' &&
      req.layer !== 'project-local'
    ) {
      throw new AppError(
        'invalid_input',
        `Unknown settings layer: ${String(req.layer)}`,
      );
    }
    if (typeof req.keyPath !== 'string' || req.keyPath === '') {
      throw new AppError('invalid_input', 'keyPath is required');
    }
    return ctx.settings.set(req.layer, req.keyPath, req.value);
  });

  // slash:list — the slash-command catalogue built from `agent.prompts` (spec §5.4).
  // Each named prompt template becomes a `/name` command the composer can expand.
  handle('slash:list', async () => {
    const prompts = ctx.settings.get().agent.prompts;
    const custom = Object.entries(prompts).map(([name, template]) => ({
      name,
      template,
    }));
    const customNames = new Set(custom.map((cmd) => cmd.name));
    return [
      ...custom,
      ...DEFAULT_SLASH_COMMANDS.filter((cmd) => !customNames.has(cmd.name)),
    ];
  });

  // deepLink:resolve — parse an `harness://…` URL into a nav target (null if
  // unroutable). Pure parse; navigation is the renderer's concern (Track E2).
  handle('deepLink:resolve', async (req) => {
    if (typeof req.url !== 'string' || req.url === '') {
      throw new AppError('invalid_input', 'url is required');
    }
    return resolveDeepLink(req.url);
  });

  // onboarding:state — compose the onboarding readiness (harness / GitHub / projects) for
  // the first-run wizard (spec §7). No input; delegates to the OnboardingService.
  handle('onboarding:state', async () => ctx.onboarding.getState());

  // update:check — trigger an update check; returns the current UpdateStatus. DESCOPED:
  // on an unsigned/dev/no-feed build this returns `{ state: 'unsupported' }` without
  // touching electron-updater (see src/main/update). Never throws for "unsupported".
  handle('update:check', async () => ctx.updater.checkForUpdates());

  // update:install — quit + install a downloaded update. Rejects with a typed AppError
  // (through the boundary) when updates are unsupported or nothing is downloaded yet.
  handle('update:install', async () => ctx.updater.install());

  // --- Phase 12: scheduled tasks (APPEND-ONLY) ---
  // HEIGHTENED-SCRUTINY (IPC boundary): every handler narrows its untrusted payload
  // before acting — non-empty strings, `scheduledAt` a POSITIVE integer (a past time is
  // allowed; it simply fires on the next tick), `mode` in the closed AgentMode set,
  // `model` against MODEL_PATTERN (rejecting whitespace/shell metacharacters BEFORE the
  // string can reach spawn argv), and `origin` in its closed set. Every mutating handler
  // broadcasts `task:changed { workspaceId }` so open renderers refetch.

  // task:list — a workspace's scheduled tasks (created_at ASC).
  handle('task:list', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    return ctx.tasks.list(req.workspaceId);
  });

  // task:create — create a task (state derived from whether a time is given). Validates
  // every field and verifies the workspace exists before persisting.
  handle('task:create', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (typeof req.prompt !== 'string' || req.prompt.trim() === '') {
      throw new AppError('invalid_input', 'prompt is required');
    }
    if (
      req.scheduledAt !== undefined &&
      (!Number.isInteger(req.scheduledAt) || req.scheduledAt <= 0)
    ) {
      throw new AppError(
        'invalid_input',
        'scheduledAt must be a positive integer (epoch millis)',
      );
    }
    if (req.mode !== undefined && !isAgentMode(req.mode)) {
      throw new AppError(
        'invalid_input',
        'mode must be plan|default|auto_accept',
      );
    }
    if (req.model !== undefined && !MODEL_PATTERN.test(req.model)) {
      throw new AppError(
        'invalid_input',
        'model contains unsupported characters',
      );
    }
    if (
      req.origin !== undefined &&
      req.origin !== 'user' &&
      req.origin !== 'limit_resume'
    ) {
      throw new AppError('invalid_input', 'origin must be user|limit_resume');
    }
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (!workspace) {
      throw new AppError('not_found', 'workspace not found', {
        workspaceId: req.workspaceId,
      });
    }
    const task = await ctx.tasks.create(req);
    emitTaskChanged(task.workspaceId);
    return task;
  });

  // task:update — edit prompt/model/mode/schedule (nullable variants). The repo rejects a
  // running task with `conflict` and re-derives state when the schedule changes.
  handle('task:update', async (req) => {
    if (typeof req.id !== 'string' || req.id === '') {
      throw new AppError('invalid_input', 'id is required');
    }
    if (
      req.prompt !== undefined &&
      (typeof req.prompt !== 'string' || req.prompt.trim() === '')
    ) {
      throw new AppError('invalid_input', 'prompt must be a non-empty string');
    }
    if (
      req.scheduledAt !== undefined &&
      req.scheduledAt !== null &&
      (!Number.isInteger(req.scheduledAt) || req.scheduledAt <= 0)
    ) {
      throw new AppError(
        'invalid_input',
        'scheduledAt must be a positive integer or null',
      );
    }
    if (req.mode !== undefined && req.mode !== null && !isAgentMode(req.mode)) {
      throw new AppError(
        'invalid_input',
        'mode must be plan|default|auto_accept',
      );
    }
    if (
      req.model !== undefined &&
      req.model !== null &&
      !MODEL_PATTERN.test(req.model)
    ) {
      throw new AppError(
        'invalid_input',
        'model contains unsupported characters',
      );
    }
    const { id, ...patch } = req;
    const task = await ctx.tasks.update(id, patch);
    emitTaskChanged(task.workspaceId);
    return task;
  });

  // task:delete — remove a task (repo rejects a running task with `conflict`). Fetch first
  // so the `task:changed` broadcast carries the right workspaceId.
  handle('task:delete', async (req) => {
    if (typeof req.id !== 'string' || req.id === '') {
      throw new AppError('invalid_input', 'id is required');
    }
    const task = await ctx.tasks.get(req.id);
    await ctx.tasks.delete(req.id);
    emitTaskChanged(task.workspaceId);
  });

  // task:runNow — fire immediately (queues if the workspace is busy). Only valid from a
  // non-terminal, non-running state; the scheduler owns the actual firing.
  handle('task:runNow', async (req) => {
    if (typeof req.id !== 'string' || req.id === '') {
      throw new AppError('invalid_input', 'id is required');
    }
    const task = await ctx.tasks.get(req.id);
    if (!isRunnableState(task.state)) {
      throw new AppError('conflict', `cannot run a ${task.state} task`, {
        id: req.id,
      });
    }
    const updated = await ctx.scheduler.runNow(req.id);
    emitTaskChanged(updated.workspaceId);
    return updated;
  });

  // task:markDone — mark a task done without running it (same state gate as runNow).
  handle('task:markDone', async (req) => {
    if (typeof req.id !== 'string' || req.id === '') {
      throw new AppError('invalid_input', 'id is required');
    }
    const task = await ctx.tasks.get(req.id);
    if (!isRunnableState(task.state)) {
      throw new AppError('conflict', `cannot mark a ${task.state} task done`, {
        id: req.id,
      });
    }
    const updated = await ctx.tasks.setState(req.id, 'done');
    emitTaskChanged(updated.workspaceId);
    return updated;
  });

  registerStreamControl(ctx);

  // Test-only channel (gated behind AGENTAPP_E2E) that throws a typed AppError through
  // the real error boundary, so the e2e can assert the renderer rebuilds `code`/`details`
  // across the ipcMain.handle rejection boundary. Never registered in a normal run.
  if (process.env['AGENTAPP_E2E'] === '1') {
    ipcMain.handle('test:throwAppError', async () => {
      try {
        throw new AppError('conflict', 'name taken', { name: 'paris' });
      } catch (e) {
        throw toBoundaryError('test:throwAppError', e);
      }
    });
  }
}

/**
 * Convenience for callers that already hold a `WebContents` and want to start the demo
 * stream imperatively (used by tests / smoke paths). Mirrors what `stream:start` does.
 */
export function startEchoStream(
  webContents: WebContents,
  ctx: AppContext,
  text: string,
): { id: string } {
  const { id, sink } = createStream<StreamChunk<'app:echoStream'>>({
    webContents,
  });
  queueMicrotask(() => {
    try {
      streamProducers['app:echoStream']({ text }, ctx, sink);
    } catch (e) {
      sink.error(toAppError(e));
    }
  });
  return { id };
}
