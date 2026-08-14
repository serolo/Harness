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

import {
  app,
  dialog,
  BrowserWindow,
  ipcMain,
  nativeImage,
  shell,
} from 'electron';
import type {
  IpcMainInvokeEvent,
  OpenDialogOptions,
  WebContents,
} from 'electron';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawn as spawnChild } from 'node:child_process';
import { readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { Octokit } from '@octokit/rest';
import type {
  CommandChannel,
  CommandReq,
  CommandRes,
  StreamArg,
  StreamChannel,
  StreamChunk,
  OnboardingLoginProvider,
  WorkspaceOpenApp,
  WorkspaceOpenAppId,
} from '@shared/ipc';
import type { StreamSink } from '@shared/ipc';
import type {
  AgentEvent,
  AgentAuthMethod,
  AgentMode,
  Attachment,
  HarnessId,
  ReasoningEffort,
  StartTurnOpts,
} from '@shared/harness';
import type { SlashCommand } from '@shared/slash';
import { MODEL_PATTERN } from '@shared/tasks';
import type { TaskOrigin, TaskState } from '@shared/tasks';
import type { AppContext } from '../context';
import { toAppError } from '../error';
import { AppError, encodeAppErrorMessage } from '@shared/errors';
import { logger } from '../logging';
import { ProjectsRepo } from '../db/repos/projects';
import { WorkspacesRepo } from '../db/repos/workspaces';
import { allocate as allocateWorkspaceName } from '../workspace/naming';
import { TodosRepo } from '../db/repos/todos';
import { ChatContextsRepo } from '../db/repos/chatContexts';
import { UsageRepo } from '../db/repos/usage';
import { GithubClient, parseOwnerName } from '../integrations/github/client';
import {
  githubCliAuthStatus,
  githubCliExecutable,
  githubCliLogout,
  githubCliToken,
} from '../integrations/github/ghCli';
import { installGithubCli } from '../integrations/github/ghInstaller';
import { installClaudeCli } from '../harness/claudeInstaller';
import { installCodexCli } from '../harness/codexInstaller';
import { resolveHarnessExecutable } from '../harness/executable';
import { discoverGitSshKeys } from '../git/sshKeys';
import type { GithubAccount } from '@shared/github';
import type { LinearAccount } from '@shared/linear';
import type { DiffQuery, DiffScope } from '@shared/review';
import type { GitDiff } from '../git';
import {
  allocateProjectDirectoryName,
  defaultRootDirectory,
  repoDir,
  rootDirectory,
  setRootDirectory,
} from '../paths';
import { EffectiveSettingsSchema } from '../settings/schema';
import { SettingsService } from '../settings';
import { KNOWLEDGE_RECONCILIATION_INSTRUCTION } from '../knowledge';
import {
  consumeKnowledgeTrace,
  prepareMcpTurnKnowledge,
  usesKnowledgeMcp,
} from '../knowledge/retrieval';
import {
  loadStoredProjectSettings,
  saveStoredProjectSetting,
} from '../settings/projectStore';
import { isCompletionSound } from '@shared/settings';
import { playCompletionSound } from '../harness/notifications';
import { discoverNativeSlashCommands } from '../slash/native';
import { resolveDeepLink } from '../deeplink';
import { buildEnv } from '../process/env';
import type { PtyChunk } from '../pty';
import { onboardingLoginCommand } from '../onboarding';
import {
  createStream,
  handleStreamCancel,
  STREAM_CANCEL_CHANNEL,
} from './stream';
import { emitAll } from './events';
import { installQmd, qmdStatus } from '../knowledge/qmd';

/** Control channel the renderer invokes to begin a scoped stream. */
const STREAM_START_CHANNEL = 'stream:start';
const CLAUDE_API_KEY_REF = 'claude-api-key';
const CODEX_API_KEY_REF = 'codex-api-key';

function activeClaudeApiKey(): string | undefined {
  return (
    process.env['ANTHROPIC_API_KEY']?.trim() ||
    process.env['ANTHROPIC_AUTH_TOKEN']?.trim() ||
    undefined
  );
}

function claudeApiKeyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

function validateClaudeApiKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 512 ||
    /\s/.test(value)
  ) {
    throw new AppError('invalid_input', 'enter a valid Anthropic API key');
  }
  return value;
}

function activeCodexApiKey(): string | undefined {
  return process.env['OPENAI_API_KEY']?.trim() || undefined;
}

function validateCodexApiKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 512 ||
    /\s/.test(value)
  ) {
    throw new AppError('invalid_input', 'enter a valid OpenAI API key');
  }
  return value;
}

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
  {
    name: 'clear',
    template: 'Clear the current chat transcript and context.',
    description: 'Clear chat history and context',
  },
];

/**
 * Workspace ids whose merge-readiness checks the renderer has fetched (via `checks:get`).
 * The main entry (`src/main/index.ts`) recomputes exactly these on window `focus` (spec
 * §5.5). Deduped by the Set; membership is additive (a workspace the user has looked at
 * keeps refreshing on focus). Populated here, drained by {@link focusRefreshWorkspaceIds}.
 */
const trackedFocusRefreshIds = new Set<string>();

const AGENT_MODES = new Set<AgentMode>(['default', 'plan', 'auto_accept']);
const TASK_ORIGINS = new Set<TaskOrigin>(['user', 'limit_resume']);
const RUNNABLE_TASK_STATES = new Set<TaskState>([
  'pending',
  'scheduled',
  'missed',
  'error',
]);
const CHAT_FILE_PREVIEW_MAX_BYTES = 512 * 1024;
let developmentResetRequested = false;

/** Consumed by the main-process shutdown path after all DB/process handles are closed. */
export function consumeDevelopmentResetRequest(): boolean {
  const requested = developmentResetRequested;
  developmentResetRequested = false;
  return requested;
}

/** Record a workspace id so a later window focus recomputes its checks (Phase 5). */
function trackForFocusRefresh(workspaceId: string): void {
  trackedFocusRefreshIds.add(workspaceId);
}

function assertWorkspaceId(
  workspaceId: unknown,
): asserts workspaceId is string {
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new AppError('invalid_input', 'workspaceId is required');
  }
}

function assertProjectId(projectId: unknown): asserts projectId is string {
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw new AppError('invalid_input', 'projectId is required');
  }
}

/** A chat tab id (`chat_contexts.id`) — keyed by UUID alone, like `todo:toggle`'s `id`. */
function assertChatContextId(contextId: unknown): asserts contextId is string {
  if (typeof contextId !== 'string' || contextId === '') {
    throw new AppError('invalid_input', 'contextId is required');
  }
}

function assertProposalId(proposalId: unknown): asserts proposalId is string {
  if (typeof proposalId !== 'string' || proposalId.trim() === '') {
    throw new AppError('invalid_input', 'proposalId is required');
  }
}

async function settingsForProject(
  ctx: AppContext,
  projectId: string,
): Promise<ReturnType<SettingsService['get']>> {
  const project = await new ProjectsRepo(ctx.db).getById(projectId);
  if (project === null) {
    throw new AppError('not_found', 'project not found', { projectId });
  }
  const stored = await loadStoredProjectSettings(ctx.db, project);
  const settings = new SettingsService();
  settings.loadResult({
    projectDir: project.repoPath,
    projectSettings: stored.value,
  });
  return settings.get();
}

function assertWorkspaceFilePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0')) {
    throw new AppError('invalid_input', 'workspace file path is required');
  }
}

function resolveWorkspaceFile(worktreePath: string, filePath: string): string {
  const root = resolve(worktreePath);
  const target = resolve(root, filePath);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new AppError('invalid_input', 'file path must stay inside workspace');
  }
  return target;
}

/**
 * Resolve a workspace path after following symlinks, then confine the real target to
 * the real checkout root. This closes the symlink variant of `..` traversal for every
 * filesystem read added to the workspace browser.
 */
async function resolveRealWorkspacePath(
  worktreePath: string,
  filePath: string,
): Promise<string> {
  const root = await realpath(resolve(worktreePath));
  const candidate = resolve(root, filePath);
  const candidateRelative = relative(root, candidate);
  if (
    candidateRelative.startsWith('..') ||
    candidateRelative.includes(`..${sep}`)
  ) {
    throw new AppError('invalid_input', 'file path must stay inside workspace');
  }

  const target = await realpath(candidate);
  const targetRelative = relative(root, target);
  if (targetRelative.startsWith('..') || targetRelative.includes(`..${sep}`)) {
    throw new AppError('invalid_input', 'file path must stay inside workspace');
  }
  return target;
}

async function resolveClaudePlanPath(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !path.endsWith('.md')) {
    throw new AppError('invalid_input', 'invalid plan path');
  }
  const root = resolve(homedir(), '.claude', 'plans');
  const target = resolve(path);
  const rel = relative(root, target);
  if (
    rel === '' ||
    rel.startsWith('..') ||
    rel.includes(`..${sep}`) ||
    !target.endsWith('.md')
  ) {
    throw new AppError(
      'invalid_input',
      'plan path must stay inside Claude plans',
    );
  }
  const realRoot = await realpath(root);
  const realTarget = await realpath(target);
  const realRelative = relative(realRoot, realTarget);
  if (realRelative.startsWith('..') || realRelative.includes(`..${sep}`)) {
    throw new AppError(
      'invalid_input',
      'plan path must stay inside Claude plans',
    );
  }
  return realTarget;
}

function workspaceRelativePath(worktreePath: string, filePath: string): string {
  return relative(
    resolve(worktreePath),
    resolveWorkspaceFile(worktreePath, filePath),
  );
}

function diffSetFromGitDiff(gitDiff: GitDiff): CommandRes<'diff:get'> {
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
}

function assertDiffScope(scope: unknown): asserts scope is DiffScope {
  if (typeof scope !== 'object' || scope === null) {
    throw new AppError('invalid_input', 'scope is required');
  }
  const candidate = scope as { kind?: unknown; sha?: unknown };
  if (candidate.kind === 'all' || candidate.kind === 'uncommitted') return;
  if (
    candidate.kind === 'commit' &&
    typeof candidate.sha === 'string' &&
    /^[0-9a-f]{40}$/i.test(candidate.sha)
  ) {
    return;
  }
  throw new AppError('invalid_input', 'scope must be all|uncommitted|commit');
}

function assertDiffQuery(req: unknown): asserts req is DiffQuery {
  if (typeof req !== 'object' || req === null) {
    throw new AppError('invalid_input', 'diff query is required');
  }
  const candidate = req as {
    workspaceId?: unknown;
    targetRef?: unknown;
    scope?: unknown;
  };
  assertWorkspaceId(candidate.workspaceId);
  if (typeof candidate.targetRef !== 'string' || candidate.targetRef === '') {
    throw new AppError('invalid_input', 'targetRef is required');
  }
  assertDiffScope(candidate.scope);
}

function assertTaskId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') {
    throw new AppError('invalid_input', 'task id is required');
  }
}

function assertTaskPrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new AppError('invalid_input', 'prompt is required');
  }
}

function assertTaskMode(mode: unknown): asserts mode is AgentMode {
  if (!AGENT_MODES.has(mode as AgentMode)) {
    throw new AppError(
      'invalid_input',
      'mode must be default|plan|auto_accept',
    );
  }
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function assertTaskEffort(effort: unknown): asserts effort is ReasoningEffort {
  if (!REASONING_EFFORTS.has(effort as ReasoningEffort)) {
    throw new AppError(
      'invalid_input',
      'effort must be low|medium|high|xhigh|max',
    );
  }
}

function assertTaskModel(model: unknown): asserts model is string {
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
    throw new AppError('invalid_input', 'invalid model');
  }
}

function assertTaskHarness(harness: unknown): asserts harness is HarnessId {
  if (!['claude_code', 'codex', 'cursor'].includes(harness as HarnessId)) {
    throw new AppError('invalid_input', 'invalid harness override');
  }
}

function assertTaskAttachments(
  attachments: unknown,
): asserts attachments is Attachment[] {
  if (!Array.isArray(attachments) || attachments.length > 20) {
    throw new AppError('invalid_input', 'invalid task attachments');
  }
  for (const attachment of attachments) {
    if (
      typeof attachment !== 'object' ||
      attachment === null ||
      !('type' in attachment) ||
      !('path' in attachment) ||
      (attachment.type !== 'file' && attachment.type !== 'image') ||
      typeof attachment.path !== 'string' ||
      attachment.path.trim() === '' ||
      attachment.path.includes('\0')
    ) {
      throw new AppError('invalid_input', 'invalid task attachment');
    }
  }
}

function assertScheduledAt(
  scheduledAt: unknown,
): asserts scheduledAt is number {
  if (
    typeof scheduledAt !== 'number' ||
    !Number.isInteger(scheduledAt) ||
    scheduledAt <= 0
  ) {
    throw new AppError(
      'invalid_input',
      'scheduledAt must be a positive integer epoch millis',
    );
  }
}

function emitTaskChanged(workspaceId: string): void {
  emitAll(
    BrowserWindow.getAllWindows().map((window) => window.webContents),
    'task:changed',
    { workspaceId },
  );
}

/**
 * Snapshot of the workspace ids to recompute checks for on window focus. Returned as an
 * array copy so the caller can iterate without racing further `checks:get` calls that
 * mutate the backing Set. Consumed by the `focus` listener wired in `src/main/index.ts`.
 */
export function focusRefreshWorkspaceIds(): string[] {
  return [...trackedFocusRefreshIds];
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

async function nextProjectDirectoryName(
  projects: ProjectsRepo,
  projectName: string,
): Promise<string> {
  const existingProjects = await projects.list();
  let filesystemEntries: string[] = [];
  try {
    filesystemEntries = await readdir(join(rootDirectory(), 'projects'));
  } catch {
    // The project root is created lazily by projectDir/repoDir.
  }
  return allocateProjectDirectoryName(projectName, [
    ...existingProjects.map((project) => project.directoryName),
    ...filesystemEntries,
  ]);
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
 * Resolve the GitHub API client according to local Settings semantics. Prefer the
 * explicitly connected Harness account, then fall back to `gh` when the saved token is
 * absent or can no longer be decrypted. The token stays in main either way.
 */
async function githubClientForSettings(ctx: AppContext): Promise<Octokit> {
  // Prefer the account explicitly connected in Harness. A machine can have `gh`
  // authenticated as a different user that cannot see this (often private) repo;
  // GitHub deliberately reports that case as 404.
  try {
    return await ctx.integrations.github();
  } catch (err) {
    if (
      !(err instanceof AppError) ||
      err.code !== 'integration' ||
      !/(?:no GitHub account connected|saved GitHub credential is unavailable)/i.test(
        err.message,
      )
    ) {
      throw err;
    }
  }

  const cli = await githubCliAuthStatus();
  if (cli.authenticated) {
    return new Octokit({ auth: await githubCliToken() });
  }
  throw new AppError('integration', 'no GitHub account connected');
}

async function connectGithubCliAccount(
  ctx: AppContext,
): Promise<GithubAccount> {
  const token = await githubCliToken();
  let account: GithubAccount | null = null;
  await ctx.integrations.connectGithub('pat', { token }, (frame) => {
    if (frame.kind === 'connected') account = frame.account;
  });
  if (account === null) {
    throw new AppError('integration', 'GitHub CLI connection did not complete');
  }
  return account;
}

async function onboardingProviderAuthenticated(
  provider: OnboardingLoginProvider,
  ctx: AppContext,
  expectedMethod?: Exclude<AgentAuthMethod, 'none'>,
): Promise<boolean> {
  if (provider === 'github') {
    const status = await githubCliAuthStatus();
    if (!status.authenticated) return false;
    await connectGithubCliAccount(ctx);
    return true;
  }
  const harness = await ctx.harness.detect(
    provider === 'claude' ? 'claude_code' : 'codex',
  );
  return (
    harness.installed &&
    harness.authenticated &&
    (expectedMethod === undefined || harness.authMethod === expectedMethod)
  );
}

function onboardingTerminalDimension(
  value: number | undefined,
  name: 'cols' | 'rows',
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new AppError(
      'invalid_input',
      `${name} must be an integer from 1 to 1000`,
    );
  }
  return value;
}

function clarifyGithubRepoError(
  error: unknown,
  repo: { owner: string; name: string },
): never {
  if (
    error instanceof AppError &&
    error.code === 'integration' &&
    /\b404\b/.test(error.message)
  ) {
    throw new AppError(
      'integration',
      `GitHub could not access ${repo.owner}/${repo.name}. Check that the connected account can view the repository and has Pull requests read permission.`,
    );
  }
  throw error;
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

interface WorkspaceAppConfig extends WorkspaceOpenApp {
  application: string;
  bundlePaths: readonly string[];
}

/** Fixed application names keep the renderer from choosing a binary or command. */
const WORKSPACE_OPEN_APPS: readonly WorkspaceAppConfig[] = [
  {
    id: 'finder',
    label: 'Finder',
    kind: 'finder',
    application: 'Finder',
    bundlePaths: ['/System/Library/CoreServices/Finder.app'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    kind: 'terminal',
    application: 'Terminal',
    bundlePaths: ['/System/Applications/Utilities/Terminal.app'],
  },
  {
    id: 'iterm',
    label: 'iTerm',
    kind: 'terminal',
    application: 'iTerm',
    bundlePaths: ['/Applications/iTerm.app'],
  },
  {
    id: 'warp',
    label: 'Warp',
    kind: 'terminal',
    application: 'Warp',
    bundlePaths: ['/Applications/Warp.app'],
  },
  {
    id: 'vscode',
    label: 'Visual Studio Code',
    kind: 'editor',
    application: 'Visual Studio Code',
    bundlePaths: ['/Applications/Visual Studio Code.app'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    application: 'Cursor',
    bundlePaths: ['/Applications/Cursor.app'],
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    kind: 'editor',
    application: 'Sublime Text',
    bundlePaths: ['/Applications/Sublime Text.app'],
  },
  {
    id: 'xcode',
    label: 'Xcode',
    kind: 'editor',
    application: 'Xcode',
    bundlePaths: ['/Applications/Xcode.app'],
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    kind: 'editor',
    application: 'WebStorm',
    bundlePaths: ['/Applications/WebStorm.app'],
  },
  {
    id: 'fork',
    label: 'Fork',
    kind: 'git',
    application: 'Fork',
    bundlePaths: ['/Applications/Fork.app'],
  },
  {
    id: 'devin',
    label: 'Devin Desktop',
    kind: 'editor',
    application: 'Devin',
    bundlePaths: ['/Applications/Devin.app'],
  },
] as const;

/** Run macOS `open` without a shell and resolve with its exit status. */
function runMacOpen(args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnChild('/usr/bin/open', [...args], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

function readProcessOutput(
  command: string,
  args: readonly string[],
): Promise<string | null> {
  return new Promise((resolvePath) => {
    const child = spawnChild(command, [...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', () => resolvePath(null));
    child.once('close', (code) => {
      const appPath = output.trim();
      resolvePath(code === 0 && appPath ? appPath : null);
    });
  });
}

async function nativeApplicationIcon(
  bundlePaths: readonly string[],
): Promise<string | undefined> {
  for (const bundlePath of bundlePaths) {
    try {
      if (!(await stat(bundlePath)).isDirectory()) continue;
      const iconName = await readProcessOutput('/usr/bin/plutil', [
        '-extract',
        'CFBundleIconFile',
        'raw',
        join(bundlePath, 'Contents', 'Info.plist'),
      ]);
      if (!iconName) continue;
      const iconFile = iconName.endsWith('.icns')
        ? iconName
        : `${iconName}.icns`;
      const icon = nativeImage.createFromPath(
        join(bundlePath, 'Contents', 'Resources', iconFile),
      );
      if (!icon.isEmpty()) return icon.toDataURL();
    } catch {
      // A missing/unreadable icon should not hide an otherwise installed app.
    }
  }
  return undefined;
}

async function listInstalledWorkspaceApps(): Promise<WorkspaceOpenApp[]> {
  if (process.platform !== 'darwin') return [];
  const installedApps = await Promise.all(
    WORKSPACE_OPEN_APPS.map(async (candidate) => {
      try {
        if ((await runMacOpen(['-Ra', candidate.application])) !== 0) {
          return null;
        }
        const icon = await nativeApplicationIcon(candidate.bundlePaths);
        return {
          id: candidate.id,
          label: candidate.label,
          kind: candidate.kind,
          icon,
        };
      } catch {
        return {
          id: candidate.id,
          label: candidate.label,
          kind: candidate.kind,
        };
      }
    }),
  );
  return installedApps.filter(
    (candidate): candidate is WorkspaceOpenApp => candidate !== null,
  );
}

async function openWorkspaceInApp(
  appId: WorkspaceOpenAppId,
  workspacePath: string,
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new AppError('conflict', 'opening in an application requires macOS');
  }
  const target = WORKSPACE_OPEN_APPS.find(
    (candidate) => candidate.id === appId,
  );
  if (!target) {
    throw new AppError('invalid_input', 'unknown workspace application', {
      appId: String(appId),
    });
  }
  const args =
    target.id === 'finder'
      ? [workspacePath]
      : ['-a', target.application, workspacePath];
  const exitCode = await runMacOpen(args);
  if (exitCode !== 0) {
    throw new AppError('not_found', `${target.label} is not installed`, {
      appId,
    });
  }
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
        const projectName = projectNameFromUrl(arg.url);
        const directoryName = await nextProjectDirectoryName(
          projects,
          projectName,
        );
        dest = repoDir(directoryName);
        await ctx.git.clone(arg.url, dest, (p) => sink.push(p), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const info = await ctx.git.open(dest);
        if (controller.signal.aborted) return;
        const project = await projects.create({
          name: projectName,
          originUrl: info.originUrl.length > 0 ? info.originUrl : arg.url,
          defaultBranch: info.defaultBranch,
          repoPath: dest,
          directoryName,
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
  // `{ kind: 'setupLog' }` frame. Push `{ kind: 'created' }` as soon as the row is
  // persisted (before setup) so the dialog can close immediately; setup continues and
  // status changes arrive through the existing workspace broadcast events.
  'workspace:create': (arg, ctx, sink) => {
    void (async () => {
      try {
        sink.push({
          kind: 'phase',
          phase: 'fetching',
          message: 'Preparing repository and worktree…',
        });
        await ctx.workspaces.create(
          arg,
          (chunk) => sink.push({ kind: 'setupLog', chunk }),
          (workspace) => sink.push({ kind: 'created', workspace }),
        );
        sink.end();
      } catch (e) {
        const error = toAppError(e);
        logger.error(
          `[workspace:create] ${error.code}: ${error.message}`,
          error.details,
        );
        sink.error(error);
      }
    })();
  },

  'workspace:archiveStream': (arg, ctx, sink) => {
    void (async () => {
      try {
        if (typeof arg.id !== 'string' || arg.id === '') {
          throw new AppError('invalid_input', 'workspace id is required');
        }
        await ctx.workspaces.archive(arg.id, (event) => sink.push(event));
        sink.end();
      } catch (error) {
        sink.error(toAppError(error));
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
      let preparedKnowledgeTrace:
        ReturnType<typeof prepareMcpTurnKnowledge>['trace'] | undefined;
      try {
        // Validate + narrow the untrusted payload before acting.
        if (typeof arg.workspaceId !== 'string' || arg.workspaceId === '') {
          throw new AppError('invalid_input', 'workspaceId is required');
        }
        if (typeof arg.prompt !== 'string' || arg.prompt.trim() === '') {
          throw new AppError('invalid_input', 'prompt is required');
        }
        if (
          arg.displayPrompt !== undefined &&
          (typeof arg.displayPrompt !== 'string' ||
            arg.displayPrompt.trim() === '')
        ) {
          throw new AppError('invalid_input', 'displayPrompt must be a string');
        }
        const attachments = Array.isArray(arg.attachments)
          ? arg.attachments
          : [];
        if (arg.model !== undefined) assertTaskModel(arg.model);
        if (arg.effort !== undefined) assertTaskEffort(arg.effort);

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

        const settings = await settingsForProject(ctx, workspace.projectId);
        const turnProject = await new ProjectsRepo(ctx.db).getById(
          workspace.projectId,
        );
        if (turnProject === null) {
          throw new AppError('not_found', 'project not found');
        }
        const selectedHarness = harnessOverride ?? workspace.harness;
        const knowledgeConfig =
          settings.knowledge.enabled && settings.knowledge.inject_context
            ? await ctx.knowledge.getConfig(workspace.projectId)
            : undefined;
        const mcpKnowledge =
          knowledgeConfig !== undefined && usesKnowledgeMcp(selectedHarness)
            ? prepareMcpTurnKnowledge(
                workspace.projectId,
                turnProject.directoryName,
                knowledgeConfig,
                settings.knowledge.search.max_context_tokens,
              )
            : undefined;
        preparedKnowledgeTrace = mcpKnowledge?.trace;
        const knowledgeSelection =
          settings.knowledge.enabled &&
          settings.knowledge.inject_context &&
          !usesKnowledgeMcp(selectedHarness)
            ? await ctx.knowledge.contextSelectionForPrompt(
                workspace.projectId,
                arg.prompt,
                Math.min(1_000, settings.knowledge.search.max_context_tokens),
                { maxResults: 2, catalogFallback: false },
              )
            : { context: '', sources: [], retrieval: undefined };
        const hasExplicitSession = Object.prototype.hasOwnProperty.call(
          arg,
          'sessionId',
        );
        const sessionId = hasExplicitSession
          ? typeof arg.sessionId === 'string' && arg.sessionId !== ''
            ? arg.sessionId
            : undefined
          : harnessOverride === undefined ||
              harnessOverride === workspace.harness
            ? await ctx.recorder.latestSessionId(arg.workspaceId)
            : undefined;
        // Owning chat tab. NEVER trusted as given: an id from the renderer is only
        // accepted once it resolves to a real row belonging to THIS workspace, so a
        // turn can't be filed into another workspace's transcript. Omitted (or empty)
        // leaves the turn unowned — the task/scheduler path, which never sets it.
        let contextId: string | undefined;
        if (typeof arg.contextId === 'string' && arg.contextId !== '') {
          const context = await new ChatContextsRepo(ctx.db).get(arg.contextId);
          if (!context || context.workspaceId !== arg.workspaceId) {
            throw new AppError('not_found', 'chat context not found', {
              contextId: arg.contextId,
              workspaceId: arg.workspaceId,
            });
          }
          contextId = context.id;
        }
        const turnMode = arg.mode ?? settings.agent.mode;
        const opts: StartTurnOpts = {
          workspaceDir: workspace.worktreePath,
          displayPrompt: arg.displayPrompt ?? arg.prompt,
          knowledgeSources: knowledgeSelection.sources,
          ...(knowledgeSelection.retrieval === undefined
            ? {}
            : { knowledgeRetrieval: knowledgeSelection.retrieval }),
          ...(mcpKnowledge === undefined
            ? {}
            : { knowledgeTrace: mcpKnowledge.trace }),
          prompt: [
            arg.prompt,
            mcpKnowledge?.instruction ?? '',
            knowledgeSelection.context,
            settings.knowledge.enabled &&
            settings.knowledge.extract_after_turn &&
            turnMode !== 'plan'
              ? KNOWLEDGE_RECONCILIATION_INSTRUCTION
              : '',
          ]
            .filter((part) => part !== '')
            .join('\n\n'),
          attachments,
          sessionId,
          mode: turnMode,
          mcpConfig:
            mcpKnowledge === undefined
              ? settings.mcp
              : [...settings.mcp, mcpKnowledge.server],
          permissionPolicy: settings.agent.permissionPolicy,
          model: arg.model,
          effort: arg.effort,
          contextId,
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
        sink.push({
          kind: 'started',
          turnId,
          sessionId: handle.sessionId,
          mode: opts.mode ?? 'default',
        });
        started = true;
        for (const event of buffered) {
          sink.push({ kind: 'event', event });
        }
      } catch (e) {
        consumeKnowledgeTrace(preparedKnowledgeTrace);
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

        const settings = await settingsForProject(ctx, workspace.projectId);
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

        const settings = await settingsForProject(ctx, workspace.projectId);
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

  // Run one fixed provider login command in a PTY rooted at the user's home directory.
  // The renderer supplies only an enum + dimensions; executable and argv come from the
  // main-side allowlist, never from renderer text. On successful GitHub login the token
  // is imported directly into encrypted integration storage and never crosses IPC.
  'onboarding:login': (arg, ctx, sink) => {
    let ptyId: string | undefined;
    let cancelled = false;

    void (async () => {
      try {
        if (!['github', 'claude', 'codex'].includes(arg.provider)) {
          throw new AppError('invalid_input', 'unknown onboarding provider');
        }
        const provider = arg.provider as OnboardingLoginProvider;
        if (
          arg.method !== undefined &&
          !['cli', 'api_key'].includes(arg.method)
        ) {
          throw new AppError('invalid_input', 'unknown provider auth method');
        }
        if (provider === 'github' && arg.method !== undefined) {
          throw new AppError(
            'invalid_input',
            'GitHub login does not accept a provider auth method',
          );
        }
        if (arg.force !== undefined && typeof arg.force !== 'boolean') {
          throw new AppError('invalid_input', 'force must be a boolean');
        }
        const cols = onboardingTerminalDimension(arg.cols, 'cols');
        const rows = onboardingTerminalDimension(arg.rows, 'rows');
        if (
          !arg.force &&
          (await onboardingProviderAuthenticated(provider, ctx, arg.method))
        ) {
          sink.push({ kind: 'finished', provider, authenticated: true });
          sink.end();
          return;
        }

        if (provider === 'github') {
          const status = await githubCliAuthStatus();
          if (!status.available) {
            await installGithubCli({
              onProgress: (message) => sink.push({ kind: 'progress', message }),
            });
          }
        } else {
          const harness = await ctx.harness.detect(
            provider === 'claude' ? 'claude_code' : 'codex',
          );
          if (!harness.installed) {
            const install =
              provider === 'claude' ? installClaudeCli : installCodexCli;
            await install({
              onProgress: (message) => sink.push({ kind: 'progress', message }),
            });
          }
        }

        const command = onboardingLoginCommand(provider, arg.method);
        if (provider === 'codex' && arg.method === 'api_key') {
          sink.push({
            kind: 'progress',
            message: 'Paste your OpenAI API key and press Return.',
          });
        }
        let started = false;
        const buffered: string[] = [];
        const ptySink: StreamSink<PtyChunk> = {
          push: (chunk) => {
            if (started) sink.push({ kind: 'data', data: chunk.data });
            else buffered.push(chunk.data);
          },
          end: () => {
            void (async () => {
              try {
                const authenticated = await onboardingProviderAuthenticated(
                  provider,
                  ctx,
                  arg.method,
                );
                sink.push({ kind: 'finished', provider, authenticated });
                sink.end();
              } catch (error) {
                sink.error(toAppError(error));
              }
            })();
          },
          error: (error) => sink.error(error),
        };

        ptyId = await ctx.pty.spawn(
          {
            workspaceId: 'onboarding',
            cwd: homedir(),
            shell:
              provider === 'github'
                ? githubCliExecutable()
                : resolveHarnessExecutable(provider),
            args: command.args,
            cols,
            rows,
          },
          ptySink,
        );
        if (cancelled) {
          ctx.pty.kill(ptyId);
          return;
        }
        sink.push({ kind: 'started', ptyId, command: command.display });
        started = true;
        for (const data of buffered) sink.push({ kind: 'data', data });
      } catch (error) {
        if (!cancelled) sink.error(toAppError(error));
      }
    })();

    return () => {
      cancelled = true;
      if (ptyId !== undefined) ctx.pty.kill(ptyId);
    };
  },
};

/**
 * Wire the scoped-stream control channels. The renderer's `api.stream(channel, arg)`:
 *   1. the renderer allocates an id and preload subscribes to `stream:<id>`;
 *   2. invokes `stream:start` with that id → main starts the producer and returns it;
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
      payload: { channel: StreamChannel; arg: unknown; id: string },
    ): Promise<{ id: string }> => {
      try {
        const producer = streamProducers[payload.channel] as
          StreamProducer<StreamChannel> | undefined;
        if (!producer) {
          throw toAppError(
            new Error(`unknown stream channel: ${String(payload.channel)}`),
          );
        }
        if (
          typeof payload.id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            payload.id,
          )
        ) {
          throw new AppError('invalid_input', 'invalid stream subscription id');
        }
        let producerTeardown: (() => void) | undefined;
        const { id, sink } = createStream<StreamChunk<StreamChannel>>({
          webContents: event.sender,
          id: payload.id,
          onClose: () => producerTeardown?.(),
        });
        // Preload attached `stream:<id>` before invoking this handler, so even a
        // producer that completes synchronously cannot race its listener.
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

  handle('app:isDevelopment', async () => !app.isPackaged);

  handle('app:resetDevelopmentData', async () => {
    if (app.isPackaged) {
      throw new AppError(
        'invalid_input',
        'Fresh-install reset is only available in development builds.',
      );
    }
    developmentResetRequested = true;
    app.relaunch();
    setImmediate(() => app.quit());
  });

  // app:echoStream — the request/response half of the demo. The actual chunks flow
  // over the `app:echoStream` StreamChannel (started via `stream:start`); this command
  // exists so the contract has the { req; res } pair and so a caller can trigger a
  // one-shot without the stream if desired. It returns void immediately.
  handle('app:echoStream', async () => {
    // No-op on the command path; streaming is driven through `api.stream(...)`.
    return undefined;
  });

  handle('agent:claudeApiKeyStatus', async () => {
    const apiKey = activeClaudeApiKey();
    return apiKey
      ? { configured: true, hint: claudeApiKeyHint(apiKey) }
      : { configured: false };
  });

  handle('agent:revealClaudeApiKey', async () => {
    const apiKey = activeClaudeApiKey();
    if (!apiKey) {
      throw new AppError('not_found', 'Claude API key is not configured');
    }
    return { apiKey };
  });

  handle('agent:setClaudeApiKey', async (req) => {
    const apiKey = validateClaudeApiKey(req.apiKey);
    await ctx.secrets.putNamed(CLAUDE_API_KEY_REF, apiKey);
    process.env['ANTHROPIC_API_KEY'] = apiKey;
    delete process.env['ANTHROPIC_AUTH_TOKEN'];
    return { configured: true, hint: claudeApiKeyHint(apiKey) };
  });

  handle('agent:deleteClaudeApiKey', async () => {
    await ctx.secrets.remove(CLAUDE_API_KEY_REF);
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_AUTH_TOKEN'];
  });

  handle('agent:codexApiKeyStatus', async () => {
    const apiKey = activeCodexApiKey();
    return apiKey
      ? { configured: true, hint: claudeApiKeyHint(apiKey) }
      : { configured: false };
  });

  handle('agent:revealCodexApiKey', async () => {
    const apiKey = activeCodexApiKey();
    if (!apiKey) {
      throw new AppError('not_found', 'Codex API key is not configured');
    }
    return { apiKey };
  });

  handle('agent:setCodexApiKey', async (req) => {
    const apiKey = validateCodexApiKey(req.apiKey);
    await ctx.secrets.putNamed(CODEX_API_KEY_REF, apiKey);
    process.env['OPENAI_API_KEY'] = apiKey;
    return { configured: true, hint: claudeApiKeyHint(apiKey) };
  });

  handle('agent:deleteCodexApiKey', async () => {
    await ctx.secrets.remove(CODEX_API_KEY_REF);
    delete process.env['OPENAI_API_KEY'];
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

  handle('app:getRootDirectory', async () => ({
    path: rootDirectory(),
    defaultPath: defaultRootDirectory(),
  }));

  handle('app:setRootDirectory', async (req) => {
    if (typeof req.path !== 'string' || req.path.trim() === '') {
      throw new AppError('invalid_input', 'Root directory is required.');
    }
    try {
      return { path: setRootDirectory(req.path.trim()) };
    } catch (error) {
      throw new AppError(
        'invalid_input',
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  handle('app:pickRootDirectory', async (req) => {
    const options: OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath:
        typeof req.defaultPath === 'string' ? req.defaultPath : undefined,
    };
    const win = BrowserWindow.getFocusedWindow();
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // project:add — register an existing local repo directory as a project, resolving
  // its origin URL + default branch via GitService before persisting the row.
  handle('project:add', async (req) => {
    const projects = new ProjectsRepo(ctx.db);
    const info = await ctx.git.open(req.localPath);
    const name = basename(req.localPath);
    return projects.create({
      name,
      originUrl: info.originUrl,
      defaultBranch: info.defaultBranch,
      repoPath: req.localPath,
      directoryName: await nextProjectDirectoryName(projects, name),
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
    let fetchWarning: string | undefined;
    if (project.originUrl !== '') {
      try {
        await ctx.git.fetch(project.repoPath);
      } catch (error) {
        fetchWarning =
          'Could not refresh the remote. Showing cached local branches.';
        logger.warn(
          `[workspace] branch refresh failed for project ${project.id}; using cached refs: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const branches = await ctx.git.listBranches(project.repoPath);
    return {
      defaultBranch: project.defaultBranch,
      branches,
      ...(fetchWarning ? { fetchWarning } : {}),
    };
  });

  handle('project:getCurrentBranch', async (req) => {
    assertProjectId(req.projectId);
    const project = await new ProjectsRepo(ctx.db).getById(req.projectId);
    if (project === null) {
      throw new AppError('not_found', 'project not found', {
        projectId: req.projectId,
      });
    }
    return { branch: await ctx.git.currentBranch(project.repoPath) };
  });

  handle('workspace:suggestNames', async (req) => {
    assertProjectId(req.projectId);
    const project = await new ProjectsRepo(ctx.db).getById(req.projectId);
    if (project === null) {
      throw new AppError('not_found', 'project not found', {
        projectId: req.projectId,
      });
    }
    const existing = await new WorkspacesRepo(ctx.db).listByProject(
      req.projectId,
    );
    const workspaceName = allocateWorkspaceName(
      existing.map((row) => row.name),
    );
    return {
      workspaceName,
      worktreeName: workspaceName,
      branchName: workspaceName,
    };
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
  handle('workspace:archivePreview', async (req) => {
    if (typeof req.id !== 'string' || req.id === '') {
      throw new AppError('invalid_input', 'workspace id is required');
    }
    return ctx.workspaces.archivePreview(req.id);
  });
  handle('workspace:update', async (req) => {
    if (typeof req.id !== 'string' || req.id === '') {
      throw new AppError('invalid_input', 'workspace id is required');
    }
    return ctx.workspaces.update(req.id, req);
  });

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

  // chat:clear — hide the transcript from future history/resume reconstruction.
  handle('chat:clear', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    await ctx.recorder.clear(req.workspaceId);
  });

  // --- Durable chat tabs (chat_contexts, migration 0016) ---
  // A tab id is later accepted as `turn:start`'s `contextId` and written onto a turn row,
  // so every field is validated and narrowed here before it reaches persistence. The repo
  // is constructed per call (like `todo:*`) — it is stateless, and nothing outside these
  // handlers needs it, so `AppContext` gains no new field.

  // chat:contexts:list — the workspace's tabs, bootstrapping the default one if absent.
  handle('chat:contexts:list', async (req) => {
    assertWorkspaceId(req.workspaceId);
    return new ChatContextsRepo(ctx.db).listOrBootstrap(req.workspaceId);
  });

  // chat:contexts:create — open a new tab at the next position.
  handle('chat:contexts:create', async (req) => {
    assertWorkspaceId(req.workspaceId);
    if (req.label !== undefined && typeof req.label !== 'string') {
      throw new AppError('invalid_input', 'label must be a string');
    }
    if (
      req.initialSessionId !== undefined &&
      req.initialSessionId !== null &&
      (typeof req.initialSessionId !== 'string' || req.initialSessionId === '')
    ) {
      throw new AppError(
        'invalid_input',
        'initialSessionId must be a non-empty string or null',
      );
    }
    return new ChatContextsRepo(ctx.db).create({
      workspaceId: req.workspaceId,
      label: req.label,
      initialSessionId: req.initialSessionId,
    });
  });

  // chat:contexts:rename — relabel a tab (throws not_found if it was already closed).
  handle('chat:contexts:rename', async (req) => {
    assertChatContextId(req.contextId);
    if (typeof req.label !== 'string' || req.label.trim() === '') {
      throw new AppError('invalid_input', 'label is required');
    }
    await new ChatContextsRepo(ctx.db).rename(req.contextId, req.label.trim());
  });

  // chat:contexts:close — orphan the tab's turns then delete it (no-op if already gone).
  handle('chat:contexts:close', async (req) => {
    assertChatContextId(req.contextId);
    await new ChatContextsRepo(ctx.db).close(req.contextId);
  });

  handle('usage:monthly', async (req) => {
    if (
      typeof req.month !== 'string' ||
      !/^\d{4}-\d{2}$/.test(req.month) ||
      typeof req.startAt !== 'number' ||
      !Number.isFinite(req.startAt) ||
      typeof req.endAt !== 'number' ||
      !Number.isFinite(req.endAt) ||
      req.startAt >= req.endAt ||
      req.endAt - req.startAt > 32 * 24 * 60 * 60 * 1000
    ) {
      throw new AppError('invalid_input', 'invalid usage month range');
    }
    return new UsageRepo(ctx.db).monthly(req.month, req.startAt, req.endAt);
  });

  handle('pricing:getCatalog', async () => ctx.pricing.ready());

  // workspace:readFile — read-only preview for chat file tabs. Paths are relative to
  // the selected checkout and are resolved/capped in main before crossing IPC.
  handle('workspace:readFile', async (req) => {
    assertWorkspaceId(req.workspaceId);
    assertWorkspaceFilePath(req.path);
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (workspace === null || workspace.worktreePath === null) {
      throw new AppError('not_found', 'workspace checkout is unavailable');
    }
    const absolutePath = await resolveRealWorkspacePath(
      workspace.worktreePath,
      req.path,
    );
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new AppError('invalid_input', 'path is not a file');
    }
    if (fileStat.size > CHAT_FILE_PREVIEW_MAX_BYTES) {
      throw new AppError('invalid_input', 'file is too large to preview');
    }
    return {
      path: workspaceRelativePath(workspace.worktreePath, req.path),
      content: await readFile(absolutePath, 'utf8'),
    };
  });

  // workspace:listDirectory — lazy, read-only backing for the Git panel's All files
  // tree. Renderer paths are untrusted; realpath confinement also rejects symlinks
  // whose targets escape the selected checkout.
  handle('workspace:listDirectory', async (req) => {
    assertWorkspaceId(req.workspaceId);
    if (
      typeof req.path !== 'string' ||
      req.path.includes('\0') ||
      req.path.length > 4096
    ) {
      throw new AppError('invalid_input', 'invalid workspace directory path');
    }
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (workspace === null || workspace.worktreePath === null) {
      throw new AppError('not_found', 'workspace checkout is unavailable');
    }
    const absolutePath = await resolveRealWorkspacePath(
      workspace.worktreePath,
      req.path,
    );
    const directoryStat = await stat(absolutePath);
    if (!directoryStat.isDirectory()) {
      throw new AppError('invalid_input', 'path is not a directory');
    }

    const entries = await readdir(absolutePath, { withFileTypes: true });
    const realWorkspaceRoot = await realpath(resolve(workspace.worktreePath));
    const parentPath = relative(realWorkspaceRoot, absolutePath)
      .split(sep)
      .join('/');
    return entries
      .map((entry) => ({
        name: entry.name,
        path: [parentPath, entry.name].filter(Boolean).join('/'),
        kind: entry.isDirectory()
          ? ('directory' as const)
          : entry.isFile()
            ? ('file' as const)
            : ('symlink' as const),
      }))
      .sort((left, right) => {
        if (left.kind === 'directory' && right.kind !== 'directory') return -1;
        if (left.kind !== 'directory' && right.kind === 'directory') return 1;
        return left.name.localeCompare(right.name, undefined, {
          sensitivity: 'base',
        });
      });
  });

  // attachment:imagePreview — the renderer identifies an attachment already
  // persisted on this workspace turn. It can never supply an authoritative path.
  handle('attachment:imagePreview', async (req) => {
    if (req === null || typeof req !== 'object') {
      throw new AppError('invalid_input', 'invalid attachment preview request');
    }
    assertWorkspaceId(req.workspaceId);
    if (typeof req.turnId !== 'string' || req.turnId === '') {
      throw new AppError('invalid_input', 'turnId is required');
    }
    if (!Number.isInteger(req.attachmentIndex) || req.attachmentIndex < 0) {
      throw new AppError('invalid_input', 'attachmentIndex is invalid');
    }

    const turn = (await ctx.recorder.history(req.workspaceId)).find(
      (candidate) => candidate.id === req.turnId,
    );
    const attachmentEvent = turn?.events.find(
      ({ event }) => event.kind === 'user_attachments',
    )?.event;
    const attachment =
      attachmentEvent?.kind === 'user_attachments'
        ? attachmentEvent.attachments[req.attachmentIndex]
        : undefined;
    if (
      attachment?.type !== 'image' ||
      !/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(attachment.path)
    ) {
      throw new AppError('not_found', 'image attachment is unavailable');
    }

    const imageStat = await stat(attachment.path).catch(() => null);
    if (
      imageStat === null ||
      !imageStat.isFile() ||
      imageStat.size > 25 * 1024 * 1024
    ) {
      throw new AppError('not_found', 'image attachment is unavailable');
    }
    const preview = await nativeImage.createThumbnailFromPath(attachment.path, {
      width: 1024,
      height: 1024,
    });
    if (preview.isEmpty()) {
      throw new AppError('not_found', 'image attachment is unavailable');
    }
    const png = preview.toPNG();
    if (png.byteLength > 8 * 1024 * 1024) {
      throw new AppError('invalid_input', 'image attachment is too large');
    }
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  });

  // file:revealInFinder — reveal only files already confined to a workspace or the
  // Claude plans directory. The renderer never supplies an authoritative root.
  handle('file:revealInFinder', async (req) => {
    if (req === null || typeof req !== 'object') {
      throw new AppError('invalid_input', 'invalid file reveal request');
    }
    let absolutePath: string;
    if (req.source === 'workspace') {
      assertWorkspaceId(req.workspaceId);
      assertWorkspaceFilePath(req.path);
      if (isAbsolute(req.path) || req.path.length > 4096) {
        throw new AppError(
          'invalid_input',
          'workspace file path must be relative',
        );
      }
      const workspace = await ctx.workspaces.get(req.workspaceId);
      if (workspace === null || workspace.worktreePath === null) {
        throw new AppError('not_found', 'workspace checkout is unavailable');
      }
      absolutePath = await resolveRealWorkspacePath(
        workspace.worktreePath,
        req.path,
      );
    } else if (req.source === 'plan') {
      if (typeof req.path !== 'string' || req.path.length > 4096) {
        throw new AppError('invalid_input', 'invalid plan path');
      }
      absolutePath = await resolveClaudePlanPath(req.path);
    } else {
      throw new AppError('invalid_input', 'invalid file source');
    }
    if (!(await stat(absolutePath)).isFile()) {
      throw new AppError('invalid_input', 'path is not a file');
    }
    shell.showItemInFolder(absolutePath);
  });

  // plan:read — narrowly scoped read-only access for Claude's saved plan handoff.
  handle('plan:read', async (req) => {
    const target = await resolveClaudePlanPath(req.path);
    const fileStat = await stat(target);
    if (!fileStat.isFile() || fileStat.size > CHAT_FILE_PREVIEW_MAX_BYTES) {
      throw new AppError('invalid_input', 'plan file cannot be previewed');
    }
    return { path: target, content: await readFile(target, 'utf8') };
  });

  // workspace:pickFile — open the OS file picker for chat attachments.
  handle('workspace:pickFile', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'] })
      : await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (workspace === null) {
      throw new AppError('not_found', 'workspace not found', {
        workspaceId: req.workspaceId,
      });
    }
    const settings = await settingsForProject(ctx, workspace.projectId);
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

  // workspace:listOpenApps — return only allowlisted apps registered with LaunchServices.
  handle('workspace:listOpenApps', async () => listInstalledWorkspaceApps());

  // workspace:openInApp — resolve the path from persistence and launch a fixed app name.
  // Neither an executable nor a filesystem path is accepted from the renderer.
  handle('workspace:openInApp', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (!WORKSPACE_OPEN_APPS.some((candidate) => candidate.id === req.appId)) {
      throw new AppError('invalid_input', 'unknown workspace application', {
        appId: String(req.appId),
      });
    }
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (!workspace) {
      throw new AppError('not_found', 'workspace not found', {
        workspaceId: req.workspaceId,
      });
    }
    if (!workspace.worktreePath) {
      throw new AppError('conflict', 'workspace has no checkout', {
        workspaceId: req.workspaceId,
      });
    }
    await openWorkspaceInApp(req.appId, workspace.worktreePath);
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
    return diffSetFromGitDiff(gitDiff);
  });

  // diff:file — per-file old/new content + parsed hunks. Chat file previews may pass
  // absolute tool-reported paths; normalize any in-workspace path before DiffService,
  // which intentionally accepts only workspace-relative paths.
  handle('diff:file', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    if (typeof req.path !== 'string' || req.path === '') {
      throw new AppError('invalid_input', 'path is required');
    }
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (workspace === null || workspace.worktreePath === null) {
      throw new AppError('not_found', 'workspace checkout is unavailable');
    }
    return ctx.diff.fileDiff(
      req.workspaceId,
      workspaceRelativePath(workspace.worktreePath, req.path),
    );
  });

  // diff:menu — target-branch and scope metadata for the Git changes panel.
  handle('diff:menu', async (req) => {
    assertWorkspaceId(req.workspaceId);
    if (
      req.targetRef !== undefined &&
      (typeof req.targetRef !== 'string' || req.targetRef === '')
    ) {
      throw new AppError(
        'invalid_input',
        'targetRef must be a non-empty string',
      );
    }
    return ctx.diff.menu(req.workspaceId, req.targetRef);
  });

  // diff:query — explicit target/scope comparison used by the Git menu.
  handle('diff:query', async (req) => {
    assertDiffQuery(req);
    return diffSetFromGitDiff(await ctx.diff.getDiffForQuery(req));
  });

  // diff:fileQuery — per-file contents for the exact target/scope comparison.
  handle('diff:fileQuery', async (req) => {
    assertDiffQuery(req);
    assertWorkspaceFilePath(req.path);
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (workspace === null || workspace.worktreePath === null) {
      throw new AppError('not_found', 'workspace checkout is unavailable');
    }
    return ctx.diff.fileDiffForQuery(
      req,
      workspaceRelativePath(workspace.worktreePath, req.path),
    );
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

  // --- Scheduled agent tasks ---
  // Task prompts eventually become agent input, and model/mode become process args/options,
  // so validate every field at the IPC boundary before touching persistence or scheduler.
  handle('task:list', async (req) => {
    assertWorkspaceId(req.workspaceId);
    return ctx.tasks.list(req.workspaceId);
  });

  handle('task:create', async (req) => {
    assertWorkspaceId(req.workspaceId);
    assertTaskPrompt(req.prompt);
    if (req.mode !== undefined) assertTaskMode(req.mode);
    if (req.model !== undefined) assertTaskModel(req.model);
    if (req.effort !== undefined) assertTaskEffort(req.effort);
    if (req.harnessOverride !== undefined) {
      assertTaskHarness(req.harnessOverride);
    }
    if (req.attachments !== undefined) {
      assertTaskAttachments(req.attachments);
    }
    if (req.scheduledAt !== undefined) assertScheduledAt(req.scheduledAt);
    if (req.origin !== undefined && !TASK_ORIGINS.has(req.origin)) {
      throw new AppError('invalid_input', 'origin must be user|limit_resume');
    }
    const workspace = await ctx.workspaces.get(req.workspaceId);
    if (!workspace) {
      throw new AppError('not_found', 'workspace not found', {
        workspaceId: req.workspaceId,
      });
    }
    const task = await ctx.tasks.create({
      workspaceId: req.workspaceId,
      prompt: req.prompt,
      model: req.model,
      mode: req.mode,
      scheduledAt: req.scheduledAt,
      origin: req.origin,
      harnessOverride: req.harnessOverride,
      attachments: req.attachments,
      effort: req.effort,
    });
    emitTaskChanged(task.workspaceId);
    return task;
  });

  handle('task:update', async (req) => {
    assertTaskId(req.id);
    if (req.prompt !== undefined) assertTaskPrompt(req.prompt);
    if (req.mode !== undefined && req.mode !== null) assertTaskMode(req.mode);
    if (req.model !== undefined && req.model !== null) {
      assertTaskModel(req.model);
    }
    if (req.effort !== undefined && req.effort !== null) {
      assertTaskEffort(req.effort);
    }
    if (req.harnessOverride !== undefined && req.harnessOverride !== null) {
      assertTaskHarness(req.harnessOverride);
    }
    if (req.attachments !== undefined) {
      assertTaskAttachments(req.attachments);
    }
    if (req.scheduledAt !== undefined && req.scheduledAt !== null) {
      assertScheduledAt(req.scheduledAt);
    }
    const task = await ctx.tasks.update(req.id, {
      prompt: req.prompt,
      model: req.model,
      mode: req.mode,
      scheduledAt: req.scheduledAt,
      harnessOverride: req.harnessOverride,
      attachments: req.attachments,
      effort: req.effort,
    });
    emitTaskChanged(task.workspaceId);
    return task;
  });

  handle('task:delete', async (req) => {
    assertTaskId(req.id);
    const task = await ctx.tasks.get(req.id);
    await ctx.tasks.delete(req.id);
    emitTaskChanged(task.workspaceId);
  });

  handle('task:runNow', async (req) => {
    assertTaskId(req.id);
    const task = await ctx.tasks.get(req.id);
    if (!RUNNABLE_TASK_STATES.has(task.state)) {
      throw new AppError('conflict', `cannot run a ${task.state} task`, {
        id: req.id,
      });
    }
    const next = await ctx.scheduler.runNow(req.id);
    emitTaskChanged(next.workspaceId);
    return next;
  });

  handle('task:markDone', async (req) => {
    assertTaskId(req.id);
    const task = await ctx.tasks.get(req.id);
    if (!RUNNABLE_TASK_STATES.has(task.state)) {
      throw new AppError('conflict', `cannot mark a ${task.state} task done`, {
        id: req.id,
      });
    }
    const next = await ctx.tasks.setState(req.id, 'done', {
      errorMessage: null,
    });
    emitTaskChanged(next.workspaceId);
    return next;
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
  handle('github:connectGhCli', async () => connectGithubCliAccount(ctx));

  handle('github:logoutGhCli', async () => {
    await githubCliLogout();
    const accounts = await ctx.integrations.list('github');
    for (const account of accounts) {
      await ctx.integrations.disconnect(account.id);
    }
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
    const repo = await githubRepoForProject(ctx, project);
    const client = new GithubClient(octokit, repo);
    try {
      return await client.listPrs();
    } catch (error) {
      return clarifyGithubRepoError(error, repo);
    }
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
    const repo = await githubRepoForProject(ctx, project);
    const client = new GithubClient(octokit, repo);
    try {
      return await client.listIssues();
    } catch (error) {
      return clarifyGithubRepoError(error, repo);
    }
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
    if (req.layer === 'project-shared') {
      throw new AppError(
        'invalid_input',
        'Project settings must be saved through settings:setProject.',
      );
    }
    if (req.layer !== 'user' && req.layer !== 'project-local') {
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

  const projectSettings = async (
    projectId: unknown,
  ): Promise<{
    project: NonNullable<Awaited<ReturnType<ProjectsRepo['getById']>>>;
    service: SettingsService;
    stored: Awaited<ReturnType<typeof loadStoredProjectSettings>>;
  }> => {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new AppError('invalid_input', 'projectId is required');
    }
    const project = await new ProjectsRepo(ctx.db).getById(projectId);
    if (project === null) {
      throw new AppError('not_found', 'project not found', { projectId });
    }
    const stored = await loadStoredProjectSettings(ctx.db, project);
    const service = new SettingsService();
    service.loadResult({
      projectDir: project.repoPath,
      projectSettings: stored.value,
    });
    return { project, service, stored };
  };

  handle('settings:getProject', async (req) => {
    const { project, service, stored } = await projectSettings(req.projectId);
    const result = service.loadResult({
      projectDir: project.repoPath,
      projectSettings: stored.value,
    });
    return {
      settings: result.settings,
      provenance: result.provenance,
      issues: [...stored.issues, ...result.issues],
    };
  });

  handle('settings:setProject', async (req) => {
    if (typeof req.keyPath !== 'string' || req.keyPath === '') {
      throw new AppError('invalid_input', 'keyPath is required');
    }
    const { project, service } = await projectSettings(req.projectId);
    const projectSettingsValue = await saveStoredProjectSetting(
      ctx.db,
      project,
      req.keyPath,
      req.value,
    );
    const result = service.loadResult({
      projectDir: project.repoPath,
      projectSettings: projectSettingsValue,
    });
    return {
      settings: result.settings,
      provenance: result.provenance,
      issues: result.issues,
    };
  });

  // Sound names are narrowed to the shared allowlist before the privileged main
  // process starts afplay. No renderer-provided executable, path, or shell text is used.
  handle('notifications:previewSound', async (req) => {
    if (!isCompletionSound(req.sound)) {
      throw new AppError('invalid_input', 'Unknown completion sound');
    }
    playCompletionSound(req.sound);
  });

  // slash:list — configured prompts plus native Claude/Codex commands and skills.
  // Configured prompts win, then workspace-native entries, then home-native entries,
  // then the app built-ins.
  handle('slash:list', async (req) => {
    const prompts = ctx.settings.get().agent.prompts;
    const custom = Object.entries(prompts).map(([name, template]) => ({
      name,
      template,
    }));
    const workspaceId =
      req !== undefined &&
      typeof req.workspaceId === 'string' &&
      req.workspaceId.trim() !== ''
        ? req.workspaceId
        : undefined;
    const harness =
      req !== undefined &&
      (req.harness === 'claude_code' ||
        req.harness === 'codex' ||
        req.harness === 'cursor')
        ? req.harness
        : undefined;
    const workspace =
      workspaceId !== undefined ? await ctx.workspaces.get(workspaceId) : null;
    const native = await discoverNativeSlashCommands({
      harness,
      workspaceDir: workspace?.worktreePath ?? null,
    });

    const commands = [...custom, ...native, ...DEFAULT_SLASH_COMMANDS];
    const seen = new Set<string>();
    return commands.filter((command) => {
      if (seen.has(command.name)) return false;
      seen.add(command.name);
      return true;
    });
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
  handle('onboarding:acknowledge', async () => ctx.onboarding.acknowledge());

  // update:getStatus — hydration only. This read cannot trigger network activity.
  handle('update:getStatus', async () => ctx.updater.getStatus());

  // update:check — the sole renderer-reachable operation that starts a network check.
  // Unsigned/dev/no-feed builds return `unsupported` without loading electron-updater.
  handle('update:check', async () => ctx.updater.checkForUpdates());

  // update:install — quit + install a downloaded update. Rejects with a typed AppError
  // (through the boundary) when updates are unsupported or nothing is downloaded yet.
  // Defense in depth: preserve intentional typed failures, but replace any raw/unexpected
  // updater failure before the generic boundary can encode or log sensitive details.
  handle('update:install', async () => {
    try {
      await ctx.updater.install();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'internal',
        'Unable to restart and install the update. Please try again.',
      );
    }
  });

  // Project Knowledge Wiki. The service applies the feature gate and confines every
  // filesystem path to the app-managed bundle; handlers still narrow IPC input first.
  handle('knowledge:config', async (req) => {
    assertProjectId(req?.projectId);
    return ctx.knowledge.getConfig(req.projectId);
  });
  handle('knowledge:initialize', async (req) => {
    assertProjectId(req?.projectId);
    return ctx.knowledge.initializeProject(req.projectId);
  });
  handle('knowledge:listPages', async (req) => {
    assertProjectId(req?.projectId);
    return ctx.knowledge.listPages(req.projectId);
  });
  handle('knowledge:getPage', async (req) => {
    assertProjectId(req?.projectId);
    if (typeof req.path !== 'string' || req.path.trim() === '') {
      throw new AppError('invalid_input', 'path is required');
    }
    return ctx.knowledge.getPage(req.projectId, req.path);
  });
  handle('knowledge:search', async (req) => {
    assertProjectId(req?.projectId);
    if (typeof req.query !== 'string') {
      throw new AppError('invalid_input', 'query must be a string');
    }
    if (
      req.limit !== undefined &&
      (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > 100)
    ) {
      throw new AppError('invalid_input', 'limit must be between 1 and 100');
    }
    return ctx.knowledge.search(req.projectId, req.query, req.limit);
  });
  handle('knowledge:lint', async (req) => {
    assertProjectId(req?.projectId);
    return ctx.knowledge.lint(req.projectId);
  });
  handle('knowledge:updateCatalog', async (req) => {
    assertProjectId(req?.projectId);
    return ctx.knowledge.updateCatalog(req.projectId);
  });
  handle('knowledge:qmdStatus', async () => qmdStatus());
  handle('knowledge:installQmd', async () => installQmd());
  handle('knowledge:createProposal', async (req) => {
    assertProjectId(req?.projectId);
    if (
      typeof req.title !== 'string' ||
      typeof req.summary !== 'string' ||
      !Array.isArray(req.operations)
    ) {
      throw new AppError('invalid_input', 'invalid knowledge proposal');
    }
    return ctx.knowledge.createProposal(req);
  });
  handle('knowledge:listProposals', async (req) => {
    assertProjectId(req?.projectId);
    return ctx.knowledge.listProposals(req.projectId);
  });
  handle('knowledge:acceptProposal', async (req) => {
    assertProjectId(req?.projectId);
    assertProposalId(req?.proposalId);
    return ctx.knowledge.acceptProposal(req.projectId, req.proposalId);
  });
  handle('knowledge:rejectProposal', async (req) => {
    assertProjectId(req?.projectId);
    assertProposalId(req?.proposalId);
    if (req.reason !== undefined && typeof req.reason !== 'string') {
      throw new AppError('invalid_input', 'reason must be a string');
    }
    return ctx.knowledge.rejectProposal(
      req.projectId,
      req.proposalId,
      req.reason,
    );
  });
  handle('knowledge:history', async (req) => {
    assertProjectId(req?.projectId);
    return ctx.knowledge.history(req.projectId);
  });
  handle('knowledge:importZip', async (req, event) => {
    assertProjectId(req?.projectId);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Import project knowledge',
      properties: ['openFile'] as ['openFile'],
      filters: [{ name: 'ZIP archives', extensions: ['zip'] }],
    };
    const selection =
      owner === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(owner, options);
    if (selection.canceled || selection.filePaths[0] === undefined) {
      return {
        imported: false,
        fileCount: 0,
        createdCount: 0,
        updatedCount: 0,
      };
    }
    return ctx.knowledge.importZip(req.projectId, selection.filePaths[0]);
  });
  handle('knowledge:discoverAgentMemory', async (req, event) => {
    assertProjectId(req?.projectId);
    if (req.provider !== 'claude_code' && req.provider !== 'codex') {
      throw new AppError('invalid_input', 'invalid agent memory provider');
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: `Choose ${req.provider === 'claude_code' ? 'Claude Code' : 'Codex'} memory folder (optional)`,
      properties: ['openDirectory'],
      defaultPath:
        req.provider === 'claude_code'
          ? join(homedir(), '.claude', 'projects')
          : join(homedir(), '.codex'),
    };
    const selection =
      owner === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(owner, options);
    return ctx.knowledge.discoverAgentMemory(
      req.projectId,
      req.provider,
      selection.canceled ? undefined : selection.filePaths[0],
    );
  });
  handle('knowledge:createAgentMemoryProposal', async (req) => {
    assertProjectId(req?.projectId);
    if (req.provider !== 'claude_code' && req.provider !== 'codex') {
      throw new AppError('invalid_input', 'invalid agent memory provider');
    }
    if (
      typeof req.discoveryId !== 'string' ||
      req.discoveryId.trim() === '' ||
      !Array.isArray(req.sourceIds) ||
      !req.sourceIds.every(
        (sourceId): sourceId is string =>
          typeof sourceId === 'string' && sourceId.trim() !== '',
      )
    ) {
      throw new AppError('invalid_input', 'invalid agent memory selection');
    }
    return ctx.knowledge.createAgentMemoryProposal(req);
  });
  handle('github:getWorkspacePr', async (req) => {
    if (typeof req.workspaceId !== 'string' || req.workspaceId === '') {
      throw new AppError('invalid_input', 'workspaceId is required');
    }
    const workspace = await new WorkspacesRepo(ctx.db).getById(req.workspaceId);
    if (workspace === null) {
      throw new AppError('not_found', 'workspace not found', {
        workspaceId: req.workspaceId,
      });
    }
    const project = await new ProjectsRepo(ctx.db).getById(workspace.projectId);
    if (project === null) {
      throw new AppError('not_found', 'project not found', {
        projectId: workspace.projectId,
      });
    }
    const octokit = await githubClientForSettings(ctx);
    const repo = await githubRepoForProject(ctx, project);
    const client = new GithubClient(octokit, repo);
    try {
      const pullRequest =
        workspace.prNumber === null
          ? await client.getLatestPr(workspace.branch)
          : await client.getPrByNumber(workspace.prNumber);
      if (pullRequest === null) return null;
      return client.enrichPrWithQueueState(pullRequest);
    } catch (error) {
      return clarifyGithubRepoError(error, repo);
    }
  });
  handle('github:openPrUrl', async (req) => {
    if (typeof req?.url !== 'string' || req.url === '') {
      throw new AppError('invalid_input', 'pull request URL is required');
    }
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new AppError('invalid_input', 'invalid pull request URL');
    }
    if (
      url.origin !== 'https://github.com' ||
      url.username !== '' ||
      url.password !== '' ||
      !/^\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(url.pathname)
    ) {
      throw new AppError(
        'invalid_input',
        'pull request URL must be an HTTPS github.com pull request',
      );
    }
    await shell.openExternal(url.toString());
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
