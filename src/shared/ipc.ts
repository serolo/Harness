// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
// The typed IPC surface shared by main (handlers), preload (bridge), and
// renderer (calls). No codegen: these TS types ARE the contract (README §6.2).
//
// Later phases APPEND entries to the Commands / Events / StreamChannels maps.
// They never reorder or rewrite existing entries.

import type { AppError } from './errors';
import type { ChecksResult } from './checks';
import type { GitSshKey } from './git';
import type {
  ConnectStatus,
  GithubCliAuthStatus,
  GithubAccount,
  IssueListItem,
  MergeMethod,
  PrListItem,
  PrSummary,
} from './github';
import type { LinearAccount, LinearIssue, LinearConnectStatus } from './linear';
import type {
  AgentEvent,
  AgentMode,
  Attachment,
  DetectResult,
  HarnessCapabilities,
  HarnessId,
  ReasoningEffort,
  Todo,
} from './harness';
import type {
  ChatContextRecord,
  CreateWorkspaceReq,
  Project,
  TurnRecord,
  Workspace,
} from './models';
import type {
  Checkpoint,
  CommitInfo,
  DiffComment,
  DiffCommentState,
  DiffMenuInfo,
  DiffQuery,
  DiffSet,
  FileDiff,
  NewDiffComment,
  ReviewPrompt,
  SendToAgentResult,
  TodoInput,
} from './review';
import type {
  CompletionSound,
  EffectiveSettings,
  ProjectSettingsSnapshot,
  SettingsIssue,
  SettingsProvenance,
  WritableSettingLayer,
} from './settings';
import type { SlashCommand } from './slash';
import type { CreateTaskReq, ScheduledTask, UpdateTaskReq } from './tasks';
import type { MonthlyUsage, PricingCatalogSnapshot } from './billing';
import type {
  AgentFileResult,
  AgentValidationDiagnostic,
  MetaAgentChangeEvent,
  MetaAgentDetail,
  MetaAgentSummary,
  MetaRunChangeEvent,
  MetaRunDetail,
  MetaRunSummary,
  MetaRunTurnStartedEvent,
  StartMetaRunRequest,
  ValidateAgentFileRequest,
} from './agents';
import type {
  CreateWikiProposalInput,
  KnowledgeConfig,
  QmdStatus,
  WikiHistoryEntry,
  WikiImportResult,
  WikiCatalogUpdateResult,
  WikiLintResult,
  WikiPage,
  WikiPageSummary,
  WikiProposal,
  WikiSearchResult,
  AgentMemoryDiscovery,
  AgentMemoryProposalResult,
  AgentMemoryProvider,
} from './knowledge';

/**
 * Main-side push handle produced by the stream helper `createStream()`
 * (README §6.2). A service pushes chunks into it; the helper marshals them to
 * the renderer over a scoped channel (or a MessageChannelMain port for
 * high-throughput streams). Consumed by `Harness.startTurn` (README §6.3).
 */
export interface StreamSink<T> {
  /** Emit one chunk to the subscribed renderer. */
  push(chunk: T): void;
  /** Signal normal completion; no further chunks will be pushed. */
  end(): void;
  /** Signal abnormal termination with a typed error. */
  error(e: AppError): void;
}

/** Static app/version info returned by the `app:info` command. */
export interface AppInfo {
  name: string;
  version: string;
  electron: string;
}

/**
 * Chunks streamed over the `project:clone` scoped stream (Phase 1). Progress frames
 * carry a phase + percent parsed from `git clone --progress`; the single terminal
 * `done` frame carries the persisted `Project` so the renderer receives the created
 * row over the SAME stream (mirrors the `app:echoStream` result-over-stream shape, no
 * token correlation). APPEND-ONLY addition.
 */
export type CloneProgress =
  | {
      phase: 'counting' | 'compressing' | 'receiving' | 'resolving';
      percent: number;
    }
  | { phase: 'done'; project: Project };

/**
 * Chunks streamed over the `workspace:create` scoped stream (Phase 1). `phase` frames
 * mark lifecycle steps, `setupLog` frames carry combined stdout/stderr from the setup
 * script. The `created` frame carries the persisted `Workspace` before setup starts,
 * allowing creation UI to close while setup continues. APPEND-ONLY.
 */
export type WorkspaceCreateEvent =
  | {
      kind: 'phase';
      phase: 'fetching' | 'worktree' | 'port' | 'setup';
      message?: string;
    }
  | { kind: 'setupLog'; chunk: string }
  | { kind: 'created'; workspace: Workspace };

/** Progress emitted while archiving a workspace. */
export type WorkspaceArchiveEvent =
  | {
      kind: 'phase';
      phase: 'script' | 'stopping' | 'worktree' | 'complete';
      message: string;
    }
  | { kind: 'log'; chunk: string };

/**
 * Request→response command map. Handlers live in `src/main/ipc/register.ts`
 * (each delegating to a service on AppContext); the renderer calls a typed
 * `api.invoke('<domain>:<verb>', req)`. Errors reject with a serialized AppError.
 *
 * Each entry is `{ req; res }`. Use `void` for absent request/response bodies.
 * APPEND-ONLY: later phases add channels like `workspace:create`, `diff:get`, …
 */
export interface Commands {
  'app:ping': { req: void; res: 'ok' };
  'app:info': { req: void; res: AppInfo };
  // Streaming demo command — kicks off the `app:echoStream` scoped stream.
  // The actual chunks flow over the StreamChannels entry of the same name.
  'app:echoStream': { req: { text: string }; res: void };

  /** Whether destructive fresh-install tooling is available in this process. */
  'app:isDevelopment': { req: void; res: boolean };
  /** Clear all Harness-owned state and restart. Rejected outside a development run. */
  'app:resetDevelopmentData': { req: void; res: void };
  /** Return the branch currently checked out in a project's primary checkout. */
  'project:getCurrentBranch': {
    req: { projectId: string };
    res: { branch: string };
  };
  /** Suggest collision-safe initial names for the New Workspace form. */
  'workspace:suggestNames': {
    req: { projectId: string };
    res: { workspaceName: string; worktreeName: string; branchName: string };
  };

  // --- Phase 1: projects + workspaces (APPEND-ONLY) ---
  /** Register a local repo directory as a project (resolves its default branch). */
  'project:add': { req: { localPath: string }; res: Project };
  /** List all registered projects, newest first. */
  'project:list': { req: void; res: Project[] };
  /** Fetch latest refs, then list branches available as workspace base refs. */
  'project:listBranches': {
    req: { projectId: string };
    res: {
      defaultBranch: string;
      branches: string[];
      /** Present when remote refresh failed and cached local refs were returned. */
      fetchWarning?: string;
    };
  };
  /** Open the OS directory picker; resolves the chosen path or null if cancelled. */
  'project:pickDirectory': { req: void; res: string | null };
  /** Read the directory where Harness stores managed repositories and workspaces. */
  'app:getRootDirectory': {
    req: void;
    res: { path: string; defaultPath: string };
  };
  /** Persist a new managed root. Existing files are intentionally not moved. */
  'app:setRootDirectory': { req: { path: string }; res: { path: string } };
  /** Choose a managed root with the native directory picker. */
  'app:pickRootDirectory': {
    req: { defaultPath?: string };
    res: string | null;
  };
  /** List a project's workspaces (archived filtered out unless `includeArchived`). */
  'workspace:list': {
    req: { projectId: string; includeArchived?: boolean };
    res: Workspace[];
  };
  /** Fetch a single workspace DTO by id, or null if it does not exist. */
  'workspace:get': { req: { id: string }; res: Workspace | null };
  /** Archive a workspace; configured policy decides whether its worktree is removed. */
  'workspace:archive': { req: { id: string }; res: void };
  /** Restore an archived workspace (worktree re-created, status back to `idle`). */
  'workspace:restore': { req: { id: string }; res: Workspace };

  // --- Phase 2: harness + chat (APPEND-ONLY) ---
  /** Interrupt the active turn for a workspace (SIGINT); no-op if none active. */
  'turn:interrupt': { req: { workspaceId: string }; res: void };
  /**
   * Full chat history for a workspace (turns + their events), for reconstruction on
   * open. Fetching it also clears a `needs_attention` workspace back to `idle` (D4).
   */
  'chat:history': { req: { workspaceId: string }; res: ChatHistory };
  /** Delete all persisted turns/events for a workspace transcript. */
  'chat:clear': { req: { workspaceId: string }; res: void };
  /**
   * Durable chat tabs for a workspace, in `position` order. Bootstraps a single
   * 'Untitled' tab when the workspace has none, so the renderer never invents one
   * (one source of truth, no duplicate-default race across panel mounts). APPEND-ONLY.
   */
  'chat:contexts:list': {
    req: { workspaceId: string };
    res: ChatContextRecord[];
  };
  /** Open a new chat tab at the next `position`. APPEND-ONLY. */
  'chat:contexts:create': {
    req: {
      workspaceId: string;
      label?: string;
      initialSessionId?: string | null;
    };
    res: ChatContextRecord;
  };
  /** Relabel a chat tab. APPEND-ONLY. */
  'chat:contexts:rename': {
    req: { contextId: string; label: string };
    res: void;
  };
  /**
   * Close a chat tab: its turns are orphaned (`contextId` → null) and the tab row is
   * deleted, in one transaction. Turn history itself is never deleted. APPEND-ONLY.
   */
  'chat:contexts:close': { req: { contextId: string }; res: void };
  /** Global estimated spend aggregated across all non-reverted turns. */
  'usage:monthly': {
    req: { month: string; startAt: number; endAt: number };
    res: MonthlyUsage;
  };
  /** Read a text file from the workspace checkout for a read-only chat tab preview. */
  'workspace:readFile': {
    req: { workspaceId: string; path: string };
    res: { path: string; content: string };
  };
  /** Read a Claude plan Markdown file confined to the user's ~/.claude/plans folder. */
  'plan:read': {
    req: { path: string };
    res: { path: string; content: string };
  };
  /** Open the OS file picker and return the selected path, or null if cancelled. */
  'workspace:pickFile': { req: void; res: string | null };
  /** Probe whether a registered harness CLI is installed/authenticated. */
  'harness:detect': { req: { id: HarnessId }; res: DetectResult };
  /** List registered harnesses with capabilities + a detect summary. */
  'harness:list': { req: void; res: HarnessInfo[] };

  // --- Phase 3: terminals + run scripts (APPEND-ONLY) ---
  /** Write keystrokes/data to an open PTY (keyed by the id from the `pty:open` stream). */
  'pty:write': { req: { ptyId: string; data: string }; res: void };
  /** Resize an open PTY's viewport (cols×rows). */
  'pty:resize': {
    req: { ptyId: string; cols: number; rows: number };
    res: void;
  };
  /** Close an open PTY (kills the shell + deregisters it from the ProcessRegistry). */
  'pty:close': { req: { ptyId: string }; res: void };
  /** Stop a running run-script, terminating its whole process tree (SIGTERM→SIGKILL). */
  'run:stop': { req: { workspaceId: string; runId: string }; res: void };
  /** List a workspace's configured run scripts with their current running state. */
  'run:list': { req: { workspaceId: string }; res: RunScriptInfo[] };
  /** Open a workspace's worktree in an external IDE (arg-array spawn, no shell). */
  'ide:open': { req: { workspaceId: string; ide: IdeName }; res: void };

  // --- Phase 4: diff review + checkpoints (APPEND-ONLY) ---
  /** Compute the current diff for a workspace (worktree vs merge-base; no patch). */
  'diff:get': { req: { workspaceId: string }; res: DiffSet };
  /** Fetch one file's old/new content + parsed hunks, fetched lazily by Monaco. */
  'diff:file': { req: { workspaceId: string; path: string }; res: FileDiff };
  /** Fetch target-branch and scope metadata for the Git changes panel. */
  'diff:menu': {
    req: { workspaceId: string; targetRef?: string };
    res: DiffMenuInfo;
  };
  /** Compute a diff for an explicit target/scope query. */
  'diff:query': { req: DiffQuery; res: DiffSet };
  /** Fetch one file for an explicit target/scope query. */
  'diff:fileQuery': {
    req: DiffQuery & { path: string };
    res: FileDiff;
  };
  /** List commits in `base..HEAD`, for the diff viewer's commit filter. */
  'diff:commits': { req: { workspaceId: string }; res: CommitInfo[] };
  /** Create an inline diff comment (starts in `open` state). */
  'comment:create': { req: NewDiffComment; res: DiffComment };
  /** List inline comments for a workspace, optionally filtered by state. */
  'comment:list': {
    req: { workspaceId: string; state?: DiffCommentState };
    res: DiffComment[];
  };
  /** Transition a comment to `resolved` (e.g. the user dismisses it). */
  'comment:resolve': { req: { commentId: string }; res: void };
  /** Delete an inline comment. */
  'comment:remove': { req: { commentId: string }; res: void };
  /** Build `diff_comment` attachments from open comments and mark them `sent`. */
  'comment:sendToAgent': {
    req: { workspaceId: string };
    res: SendToAgentResult;
  };
  /** Compose a review-turn prompt from `settings.agent.reviewPrompt` + the diff. */
  'review:run': { req: { workspaceId: string }; res: ReviewPrompt };
  /** List a workspace's per-turn checkpoints, ordered by turn index. */
  'checkpoint:list': { req: { workspaceId: string }; res: Checkpoint[] };
  /** Revert the workspace to the checkpoint at a turn index (auto-backs up first). */
  'checkpoint:revert': {
    req: { workspaceId: string; turnIdx: number };
    res: void;
  };
  /** List a workspace's todos (user + agent-sourced). */
  'todo:list': { req: { workspaceId: string }; res: Todo[] };
  /** Create a user-authored todo. */
  'todo:create': { req: TodoInput; res: Todo };
  /** Toggle a todo's `done` state. */
  'todo:toggle': { req: { id: string }; res: Todo };

  // --- Phase 5: GitHub + checks + PR (APPEND-ONLY) ---
  /** List connected GitHub accounts (for the integrations UI). */
  'github:accounts': { req: void; res: GithubAccount[] };
  /** Disconnect a GitHub integration and delete its ciphertext blob. */
  'github:disconnect': { req: { integrationId: string }; res: void };
  /** Inspect local GitHub CLI auth state. Never returns a token. */
  'github:cliStatus': { req: void; res: GithubCliAuthStatus };
  /** Connect using the local `gh auth token`; token stays in main. */
  'github:connectGhCli': { req: void; res: GithubAccount };
  /** Discover local SSH identities for Git operations. Private key contents are never read. */
  'git:sshKeys': { req: void; res: GitSshKey[] };
  /** Fetch the aggregated merge-readiness checks for a workspace (spec §5.5). */
  'checks:get': { req: { workspaceId: string }; res: ChecksResult };
  /** Open (or return) a pull request for a workspace's branch (spec §5.6, ⌘⇧P). */
  'pr:open': {
    req: {
      workspaceId: string;
      draft?: boolean;
      title?: string;
      body?: string;
    };
    res: PrSummary;
  };
  /** Merge a workspace's PR with the given strategy (enabled only when green). */
  'pr:merge': { req: { workspaceId: string; method: MergeMethod }; res: void };
  /** Prepare an agent turn to address the PR's unresolved review threads. */
  'pr:fixReviews': {
    req: { workspaceId: string };
    res: { prompt: string; attachments: Attachment[] };
  };
  /** Prepare an agent turn to fix the PR's failing CI checks. */
  'pr:fixChecks': {
    req: { workspaceId: string };
    res: { prompt: string; attachments: Attachment[] };
  };
  /** List a project's open pull requests (for the project PR list). */
  'github:listPrs': { req: { projectId: string }; res: PrListItem[] };
  /** List a project's open issues (for the project issue list). */
  'github:listIssues': { req: { projectId: string }; res: IssueListItem[] };
  /** Mark a GitHub review thread resolved for a workspace's PR (spec §5.5). */
  'review:resolveThread': {
    req: { workspaceId: string; threadId: string };
    res: void;
  };

  // --- Phase 6: settings write path + provenance + hot-reload (APPEND-ONLY) ---
  /** The effective (merged) settings snapshot for the Settings UI. */
  'settings:getEffective': { req: void; res: EffectiveSettings };
  /** Per-leaf provenance: which layer supplied each effective value. */
  'settings:getProvenance': { req: void; res: SettingsProvenance };
  /**
   * Write one setting into a single layer's file and return the new effective
   * settings. Heightened-scrutiny: the handler narrows `layer` + `keyPath` (rejecting
   * traversal / prototype pollution) before the write; `value` is validated by the
   * re-merge in the settings service.
   */
  'settings:set': {
    req: { layer: WritableSettingLayer; keyPath: string; value: unknown };
    res: EffectiveSettings;
  };
  /** Load the effective settings for one registered repository. */
  'settings:getProject': {
    req: { projectId: string };
    res: ProjectSettingsSnapshot;
  };
  /** Write a repository setting to the app database. */
  'settings:setProject': {
    req: { projectId: string; keyPath: string; value: unknown };
    res: ProjectSettingsSnapshot;
  };
  /** The fully-defaulted settings object (a value-shaped schema for the UI to key off). */
  'settings:schema': { req: void; res: EffectiveSettings };

  // --- Phase 6: polish — slash / deep links / auto-update / onboarding (APPEND-ONLY) ---
  /**
   * Slash catalogue for the composer: configured prompts plus native Claude/Codex
   * commands and skills. Optional workspace/harness scope lets main prefer workspace
   * skills and filter provider-specific skill roots.
   */
  'slash:list': {
    req: { workspaceId?: string; harness?: HarnessId } | void;
    res: SlashCommand[];
  };
  /** Parse an `harness://…` deep link into a nav target, or null if unroutable. */
  'deepLink:resolve': { req: { url: string }; res: DeepLinkTarget | null };
  /** Check for an application update; returns the current updater status (spec §6.5). */
  'update:check': { req: void; res: UpdateStatus };
  /** Quit and install a downloaded update. No-op/typed error when none is ready. */
  'update:install': { req: void; res: void };
  /** Compose the onboarding readiness state (harness / GitHub / projects) (spec §7). */
  'onboarding:state': { req: void; res: OnboardingState };
  /** Persist completion of the current onboarding version in the main process. */
  'onboarding:acknowledge': { req: void; res: void };
  /**
   * Layer validation issues from the most recent non-throwing settings load
   * (`loadResult` / hot-reload). Lets the Settings UI point at a bad file + key
   * instead of silently dropping the layer. Empty after a clean `load()`.
   */
  'settings:getIssues': { req: void; res: SettingsIssue[] };

  // --- Phase 7: Linear integration (APPEND-ONLY, mirrors github:*) ---
  // Tokens NEVER cross to the renderer: account rows map to the token-free `LinearAccount`.
  // Handlers narrow their untrusted payloads and degrade to a typed AppError (via
  // `LinearService.linear()`) when no account is connected. The connect flow itself is the
  // `linear:connect` StreamChannel below (mirrors github:connect).
  /** Connected Linear accounts for the integrations UI (token-free). */
  'linear:accounts': { req: void; res: LinearAccount[] };
  /** Disconnect a Linear integration + delete its ciphertext blob. */
  'linear:disconnect': { req: { integrationId: string }; res: void };
  /** Issues for the active Linear account (the issue picker); `first` bounds the page. */
  'linear:listIssues': { req: { first?: number }; res: LinearIssue[] };
  /** Write a workspace's branch and/or PR URL back to a Linear issue as attachment link(s). */
  'linear:link': {
    req: { issueId: string; branchUrl?: string; prUrl?: string };
    res: void;
  };
  /** Settings-gated workflow-state transition (e.g. on PR open/merge). */
  'linear:transition': { req: { issueId: string; stateId: string }; res: void };

  // --- Workspace archive safety (APPEND-ONLY) ---
  /** Inspect dirty state and deletion behavior before confirming an archive. */
  'workspace:archivePreview': {
    req: { id: string };
    res: WorkspaceArchivePreview;
  };

  // --- External workspace applications (APPEND-ONLY) ---
  /** Detect supported applications currently registered with macOS. */
  'workspace:listOpenApps': { req: void; res: WorkspaceOpenApp[] };
  /** Open a workspace checkout in one detected application. */
  'workspace:openInApp': {
    req: { workspaceId: string; appId: WorkspaceOpenAppId };
    res: void;
  };

  // --- Workspace context-menu actions (APPEND-ONLY) ---
  /** Update user-controlled workspace metadata and/or its visible lifecycle status. */
  'workspace:update': {
    req: {
      id: string;
      name?: string;
      renameBranch?: boolean;
      status?: Workspace['status'];
      isUnread?: boolean;
      isPinned?: boolean;
    };
    res: Workspace;
  };

  // --- Completion-sound settings (APPEND-ONLY) ---
  /** Preview one allowlisted macOS completion sound from Settings. */
  'notifications:previewSound': {
    req: { sound: CompletionSound };
    res: void;
  };

  // --- Scheduled agent tasks (APPEND-ONLY) ---
  /** List scheduled/manual tasks for one workspace. */
  'task:list': { req: { workspaceId: string }; res: ScheduledTask[] };
  /** Create a scheduled/manual agent task. */
  'task:create': { req: CreateTaskReq; res: ScheduledTask };
  /** Update an existing scheduled/manual agent task. */
  'task:update': { req: UpdateTaskReq; res: ScheduledTask };
  /** Delete a scheduled/manual agent task. */
  'task:delete': { req: { id: string }; res: void };
  /** Fire a pending/scheduled/missed/error task immediately. */
  'task:runNow': { req: { id: string }; res: ScheduledTask };
  /** Mark a pending/scheduled/missed/error task done without running it. */
  'task:markDone': { req: { id: string }; res: ScheduledTask };

  // --- Project Knowledge Wiki (APPEND-ONLY) ---
  'knowledge:config': { req: { projectId: string }; res: KnowledgeConfig };
  'knowledge:initialize': {
    req: { projectId: string };
    res: { commit: string };
  };
  'knowledge:listPages': {
    req: { projectId: string };
    res: WikiPageSummary[];
  };
  'knowledge:getPage': {
    req: { projectId: string; path: string };
    res: WikiPage;
  };
  'knowledge:search': {
    req: { projectId: string; query: string; limit?: number };
    res: WikiSearchResult[];
  };
  'knowledge:lint': { req: { projectId: string }; res: WikiLintResult };
  'knowledge:createProposal': {
    req: CreateWikiProposalInput;
    res: WikiProposal;
  };
  'knowledge:listProposals': {
    req: { projectId: string };
    res: WikiProposal[];
  };
  'knowledge:acceptProposal': {
    req: { projectId: string; proposalId: string };
    res: WikiProposal;
  };
  'knowledge:rejectProposal': {
    req: { projectId: string; proposalId: string; reason?: string };
    res: WikiProposal;
  };
  'knowledge:history': {
    req: { projectId: string };
    res: WikiHistoryEntry[];
  };
  /** Rebuild index.md from the canonical OKF pages and commit changes. */
  'knowledge:updateCatalog': {
    req: { projectId: string };
    res: WikiCatalogUpdateResult;
  };
  /** Detect the optional local QMD CLI used by the hybrid search provider. */
  'knowledge:qmdStatus': { req: void; res: QmdStatus };
  /** Install the optional QMD CLI after explicit user action. */
  'knowledge:installQmd': { req: void; res: QmdStatus };
  /** Pick an OKF ZIP bundle and create a secret-scanned review proposal. */
  'knowledge:importZip': {
    req: { projectId: string };
    res: WikiImportResult;
  };
  /** Discover project-associated Claude Code or Codex memory for explicit review. */
  'knowledge:discoverAgentMemory': {
    req: { projectId: string; provider: AgentMemoryProvider };
    res: AgentMemoryDiscovery;
  };
  /** Convert selected discovered memories into a pending wiki proposal. */
  'knowledge:createAgentMemoryProposal': {
    req: {
      projectId: string;
      provider: AgentMemoryProvider;
      discoveryId: string;
      sourceIds: string[];
    };
    res: AgentMemoryProposalResult;
  };
  /** Fetch the live GitHub state for the pull request linked to a workspace. */
  'github:getWorkspacePr': {
    req: { workspaceId: string };
    res: PrSummary | null;
  };
  /** Latest validated pricing catalogue, or null when only bundled rates are available. */
  'pricing:getCatalog': { req: void; res: PricingCatalogSnapshot | null };
  /** Hydrate the latest updater snapshot without starting network activity. */
  'update:getStatus': { req: void; res: UpdateStatus };
  /** Log out the local GitHub CLI account and remove Harness's stored GitHub credentials. */
  'github:logoutGhCli': { req: void; res: void };
  /** Read token-free metadata for Harness's encrypted Claude API key. */
  'agent:claudeApiKeyStatus': {
    req: void;
    res: { configured: boolean; hint?: string };
  };
  /** Reveal the Claude API key only after explicit user action. */
  'agent:revealClaudeApiKey': { req: void; res: { apiKey: string } };
  /** Encrypt and activate a replacement Claude API key. */
  'agent:setClaudeApiKey': {
    req: { apiKey: string };
    res: { configured: true; hint: string };
  };
  /** Delete Harness's encrypted Claude API key and remove it from child environments. */
  'agent:deleteClaudeApiKey': { req: void; res: void };
  /** Read token-free metadata for Harness's encrypted Codex API key. */
  'agent:codexApiKeyStatus': {
    req: void;
    res: { configured: boolean; hint?: string };
  };
  /** Reveal the Codex API key only after explicit user action. */
  'agent:revealCodexApiKey': { req: void; res: { apiKey: string } };
  /** Encrypt and activate a replacement Codex API key. */
  'agent:setCodexApiKey': {
    req: { apiKey: string };
    res: { configured: true; hint: string };
  };
  /** Delete Harness's encrypted Codex API key and remove it from child environments. */
  'agent:deleteCodexApiKey': { req: void; res: void };
  // --- Project-scoped meta agents and supervised runs (APPEND-ONLY) ---
  'metaAgent:list': { req: { projectId: string }; res: MetaAgentSummary[] };
  'metaAgent:get': {
    req: { projectId: string; agentId: string };
    res: MetaAgentDetail;
  };
  'metaAgent:create': {
    req: { projectId: string; slug: string; name: string };
    res: MetaAgentDetail;
  };
  'metaAgent:duplicate': {
    req: { projectId: string; agentId: string; slug: string };
    res: MetaAgentDetail;
  };
  'metaAgent:import': {
    req: { projectId: string };
    res: MetaAgentDetail | null;
  };
  'metaAgent:readFile': {
    req: { projectId: string; agentId: string; path: string };
    res: AgentFileResult;
  };
  'metaAgent:validateFile': {
    req: ValidateAgentFileRequest;
    res: AgentValidationDiagnostic[];
  };
  'metaAgent:saveFile': {
    req: ValidateAgentFileRequest & { agentId: string };
    res: MetaAgentDetail;
  };
  /** Atomically create, edit, or delete a validated set of confined bundle files. APPEND-ONLY. */
  'metaAgent:saveBundleFiles': {
    req: {
      projectId: string;
      agentId: string;
      files: { path: string; content: string | null }[];
    };
    res: MetaAgentDetail;
  };
  'metaAgent:delete': {
    req: { projectId: string; agentId: string };
    res: void;
  };
  'metaAgent:startRun': { req: StartMetaRunRequest; res: MetaRunDetail };
  'metaRun:list': { req: { projectId: string }; res: MetaRunSummary[] };
  'metaRun:get': {
    req: { projectId: string; runId: string };
    res: MetaRunDetail;
  };
  'metaRun:cancel': {
    req: { projectId: string; runId: string };
    res: MetaRunDetail;
  };
  'metaRun:takeOver': {
    req: { projectId: string; runId: string };
    res: MetaRunDetail;
  };

  /** List one directory in a workspace checkout for the lazy All files browser. */
  'workspace:listDirectory': {
    req: { workspaceId: string; path: string };
    res: WorkspaceDirectoryEntry[];
  };
  /** Open a validated github.com pull-request URL in the system browser. */
  'github:openPrUrl': { req: { url: string }; res: void };
  /** Reveal a validated, currently displayed file in the operating-system file manager. */
  'file:revealInFinder': {
    req:
      | { source: 'workspace'; workspaceId: string; path: string }
      | { source: 'plan'; path: string };
    res: void;
  };
  /** Load a bounded raster preview from an attachment already persisted on this turn. */
  'attachment:imagePreview': {
    req: { workspaceId: string; turnId: string; attachmentIndex: number };
    res: { dataUrl: string };
  };
}

export type CommandChannel = keyof Commands;
export type CommandReq<C extends CommandChannel> = Commands[C]['req'];
export type CommandRes<C extends CommandChannel> = Commands[C]['res'];

/**
 * Broadcast event map: `webContents.send('<domain>:<event>', payload)` from
 * `src/main/ipc/events.ts`; the renderer subscribes via `api.on(...)`.
 *
 * Frozen names per README §6.2. Entries marked "reserved" are typed now but
 * only emitted by their owning phase — do not remove or rename them.
 * APPEND-ONLY.
 */
export interface Events {
  // --- Active from Phase 1 ---
  'workspace:status': { workspaceId: string; status: Workspace['status'] };
  'workspace:created': { workspace: Workspace };
  'workspace:archived': {
    workspaceId: string;
    /** Null when deleted; retained when archive deletion is disabled. */
    worktreePath?: string | null;
  };

  // --- Reserved for later phases (typed now, emitted later) ---
  /** Reserved (Phase 2): a single streamed AgentEvent chunk for a turn. */
  'turn:event': { workspaceId: string; turnId: string; event: AgentEvent };
  /** Reserved (Phase 3): a chunk of PTY output. */
  'pty:data': { ptyId: string; data: string };
  /** Reserved (Phase 3): a chunk of run-script log output. */
  'run:log': { workspaceId: string; runId: string; chunk: string };
  /** Reserved (Phase 4): the diff for a workspace changed and should refetch. */
  'diff:changed': { workspaceId: string };
  /** Reserved (Phase 5): merge-readiness checks were recomputed. */
  'checks:updated': { workspaceId: string; checks: unknown };
  /** Reserved (Phase 6): effective settings changed (hot-reload). */
  'settings:changed': Record<string, never>;
  'knowledge:proposalsCreated': {
    workspaceId: string;
    turnId: string;
    projectId: string;
    proposalIds: string[];
  };
  /** Reserved (Phase 2/5): a workspace needs the user's attention. */
  'notify:needsAttention': { workspaceId: string; reason: string };
  /** A scheduled task changed and subscribers should refetch that workspace's list. */
  'task:changed': { workspaceId: string };

  // --- Phase 6: deep-link navigation + app menu accelerators (APPEND-ONLY) ---
  /**
   * Navigate to a resolved deep-link target (`harness://…` → workspace + optional
   * pane). Broadcast from main after `resolveDeepLink`; the renderer's nav store
   * selects the workspace/pane and focuses it.
   */
  'nav:deepLink': DeepLinkTarget;
  /**
   * A global menu / accelerator action was triggered in main (spec §5.4 shortcuts).
   * `actionId` is a `shortcuts.ts` action id (e.g. `openSettings`, `showDiff`,
   * `selectWorkspace:<n>`); the renderer dispatches it against the current UI.
   */
  'menu:action': { actionId: string };
  /** A scheduled task allocated a fresh provider session and should open its own chat tab. */
  'task:turnStarted': {
    workspaceId: string;
    taskId: string;
    turnId: string;
    sessionId: string;
    prompt: string;
  };
  /** The application updater transitioned to a new observable state. */
  'update:status': UpdateStatus;
  /** A managed agent definition changed or produced new validation diagnostics. */
  'metaAgent:changed': MetaAgentChangeEvent;
  /** A meta run or one of its dispatches changed. */
  'metaRun:changed': MetaRunChangeEvent;
  /** Coordinator/child turn metadata for navigation and live run inspection. */
  'metaRun:turnStarted': MetaRunTurnStartedEvent;
}

export type EventChannel = keyof Events;
export type EventPayload<E extends EventChannel> = Events[E];

/**
 * Scoped stream map: each entry describes a stream initiated with a start
 * argument (`arg`) and delivering repeated `chunk` payloads until an `end`
 * marker. Backed by `createStream()` (README §6.2). APPEND-ONLY.
 */
export interface StreamChannels {
  // Streaming demo: echoes `text` back in chunks then ends. Proves the helper
  // end-to-end (README §6.2, phase-0 DoD).
  'app:echoStream': { arg: { text: string }; chunk: string };

  // --- Phase 1: clone + workspace-create progress streams (APPEND-ONLY) ---
  // Both deliver progress AND a terminal result frame over the same scoped stream
  // (see CloneProgress / WorkspaceCreateEvent). Adding these forces the matching
  // `streamProducers` entries in src/main/ipc/register.ts (tsc-enforced exhaustiveness).
  /** Clone a remote repo, streaming git progress, ending with the persisted Project. */
  'project:clone': { arg: { url: string }; chunk: CloneProgress };
  /** Create a workspace, streaming lifecycle/setup-log frames, ending with the Workspace. */
  'workspace:create': { arg: CreateWorkspaceReq; chunk: WorkspaceCreateEvent };
  /** Archive a workspace while streaming teardown and worktree-removal progress. */
  'workspace:archiveStream': {
    arg: { id: string };
    chunk: WorkspaceArchiveEvent;
  };

  // --- Phase 2: the per-turn agent event stream (APPEND-ONLY) ---
  // One scoped stream per turn: a leading `started` frame carries the turnId +
  // resolved sessionId, then `event` frames carry each normalized AgentEvent, and the
  // stream `end`s after the terminal (turn_end/error) event. Mirrors workspace:create's
  // progress-plus-terminal-over-one-stream shape. Adding this forces the matching
  // `turn:start` producer in register.ts (tsc-enforced exhaustiveness).
  'turn:start': { arg: TurnStartArg; chunk: TurnStreamChunk };

  // --- Phase 3: PTY + run-script streams (APPEND-ONLY) ---
  // Each carries a leading `started` frame with the allocated id (mirrors turn:start),
  // then repeated data/log frames; writes/resize/close/stop are separate Commands keyed
  // by that id. Adding these forces the matching `pty:open`/`run:start` producers in
  // src/main/ipc/register.ts (tsc-enforced exhaustiveness).
  /** Open a PTY in a workspace's worktree; leading frame carries the allocated ptyId. */
  'pty:open': { arg: PtyOpenArg; chunk: PtyStreamChunk };
  /** Start a run script; leading frame carries the runId, then log frames, then exit. */
  'run:start': { arg: RunStartArg; chunk: RunStreamChunk };

  // --- Phase 5: GitHub connect (device flow / PAT) stream (APPEND-ONLY) ---
  // Drives the OAuth device flow: the leading `device_code` frame carries the user
  // code + verification URI, then `pending`/`slow_down` poll frames, ending with a
  // `connected` (account) or `error` frame (see ConnectStatus). Adding this forces
  // the matching `github:connect` producer in src/main/ipc/register.ts
  // (tsc-enforced exhaustiveness — the producer lands in Task 8).
  'github:connect': {
    arg: { mode: 'device' | 'pat'; token?: string };
    chunk: ConnectStatus;
  };

  // --- Phase 7: Linear connect (API-key paste) stream (APPEND-ONLY) ---
  // Mirrors github:connect for pattern parity. The API-key path is synchronous, so only
  // the terminal `connected`/`error` frame is emitted (LinearConnectStatus); the stream
  // shape leaves room for a future OAuth flow's progress frames. Adding this forces the
  // matching `linear:connect` producer in src/main/ipc/register.ts (tsc exhaustiveness).
  'linear:connect': {
    arg: { mode: 'apiKey'; token?: string };
    chunk: LinearConnectStatus;
  };

  // --- Onboarding provider login terminal (APPEND-ONLY) ---
  /** Run one allowlisted provider login command in an interactive onboarding PTY. */
  'onboarding:login': {
    arg: OnboardingLoginArg;
    chunk: OnboardingLoginChunk;
  };
}

export type StreamChannel = keyof StreamChannels;
export type StreamArg<S extends StreamChannel> = StreamChannels[S]['arg'];
export type StreamChunk<S extends StreamChannel> = StreamChannels[S]['chunk'];

// --- Phase 2 DTOs (APPEND-ONLY) ----------------------------------------------

/** Start argument for the `turn:start` stream. `mode` defaults to the settings default. */
export interface TurnStartArg {
  workspaceId: string;
  prompt: string;
  attachments: Attachment[];
  mode?: AgentMode;
  /** Optional per-turn harness override; omitted means use the workspace's harness. */
  harness?: HarnessId;
  /** Optional provider model id selected for this turn. */
  model?: string;
  /** Optional provider reasoning-effort override. */
  effort?: ReasoningEffort;
  /**
   * Resume a specific context session. `null` explicitly starts a fresh context;
   * omitted preserves the legacy behaviour of resuming the workspace's latest session.
   */
  sessionId?: string | null;
  /** The chat tab this turn belongs to. Omitted turns are orphaned (context_id = NULL). */
  contextId?: string;
  /** User-facing text when `prompt` contains an expanded slash command. APPEND-ONLY. */
  displayPrompt?: string;
}

/**
 * Frames over the `turn:start` stream. The leading `started` frame establishes the
 * turn (id + resolved session id); subsequent `event` frames carry each normalized
 * `AgentEvent`. The stream is scoped to ONE turn, so `event` frames need no turnId.
 */
export type TurnStreamChunk =
  | {
      kind: 'started';
      turnId: string;
      sessionId: string;
      /** Resolved mode, including the settings default when the request omitted it. */
      mode: AgentMode;
    }
  | { kind: 'event'; event: AgentEvent };

/** Reconstructable chat for a workspace: turns in order, each carrying its events. */
export interface ChatHistory {
  turns: TurnRecord[];
}

/** A registered harness: its id, capabilities, and a detect summary (for `harness:list`). */
export interface HarnessInfo {
  id: HarnessId;
  capabilities: HarnessCapabilities;
  detect: DetectResult;
}

// --- Phase 3 DTOs (APPEND-ONLY) ----------------------------------------------

/** External IDEs that can be launched at a workspace worktree. */
export type IdeName = 'cursor' | 'code';

/** Safe allowlisted applications that can open a workspace checkout. */
export type WorkspaceOpenAppId =
  | 'finder'
  | 'terminal'
  | 'iterm'
  | 'warp'
  | 'vscode'
  | 'cursor'
  | 'sublime'
  | 'xcode'
  | 'webstorm'
  | 'fork'
  | 'devin';

/** An allowlisted application that macOS reports as installed. */
export interface WorkspaceOpenApp {
  id: WorkspaceOpenAppId;
  label: string;
  kind: 'finder' | 'terminal' | 'editor' | 'git';
  /** Native application icon encoded as a data URL when the platform provides one. */
  icon?: string;
}

/** Start argument for the `pty:open` stream. `cols`/`rows` seed the initial viewport. */
export interface PtyOpenArg {
  workspaceId: string;
  cols?: number;
  rows?: number;
}

/**
 * Frames over the `pty:open` stream. The leading `started` frame carries the allocated
 * ptyId (used to key `pty:write`/`pty:resize`/`pty:close`); subsequent `data` frames
 * carry raw shell output. The stream is scoped to ONE pty, so `data` frames need no id.
 */
export type PtyStreamChunk =
  { kind: 'started'; ptyId: string } | { kind: 'data'; data: string };

/** Start argument for the `run:start` stream: which configured script to run. */
export interface RunStartArg {
  workspaceId: string;
  scriptName: string;
}

/**
 * Frames over the `run:start` stream. The leading `started` frame carries the allocated
 * runId (used to key `run:stop`); `log` frames carry combined stdout/stderr; the terminal
 * `exit` frame carries the exit code (null if killed) and total duration.
 */
export type RunStreamChunk =
  | { kind: 'started'; runId: string }
  | { kind: 'log'; chunk: string }
  | { kind: 'exit'; code: number | null; durationMs: number };

/** A workspace's configured run script + its current running state (for `run:list`). */
export interface RunScriptInfo {
  name: string;
  label?: string;
  icon?: string;
  running: boolean;
  runId?: string;
}

/** Safety information shown before archiving a workspace. */
export interface WorkspaceArchivePreview {
  hasUncommittedChanges: boolean;
  changedFileCount: number;
  willDeleteWorktree: boolean;
}

// --- Phase 6 DTOs (APPEND-ONLY) ----------------------------------------------

/**
 * The resolved target of an `harness://…` deep link (spec §5.8). The renderer's nav
 * store drives selection off this: the workspace to open and, optionally, which pane
 * to focus. `pane` is absent for a bare `harness://workspace/<id>` link.
 */
export interface DeepLinkTarget {
  workspaceId: string;
  pane?: 'diff' | 'pr' | 'knowledge';
}

/**
 * Auto-update status (spec §6.5, electron-updater). A snapshot returned by
 * `update:check` and (later) pushed as the updater progresses. `state` is the coarse
 * phase; `version` is the available/downloaded version when known; `message` carries
 * a human-readable note (e.g. the descope reason in an unsigned/dev build).
 */
export interface UpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'unsupported';
  version?: string;
  message?: string;
  /** Version of the running application. */
  currentVersion?: string;
  /** Bounded download completion percentage (`0..100`). */
  percent?: number;
}

/**
 * Onboarding readiness (spec §7): composed from provider auth detection, a valid and
 * imported GitHub CLI session, and optional project/QMD status. `complete` requires
 * GitHub plus at least one authenticated model provider.
 */
export interface OnboardingState {
  harnessReady: boolean;
  githubConnected: boolean;
  hasProjects: boolean;
  qmdInstalled: boolean;
  acknowledged: boolean;
  complete: boolean;
  claudeReady: boolean;
  codexReady: boolean;
}

/** Provider whose allowlisted login command may run in the onboarding terminal. */
export type OnboardingLoginProvider = 'github' | 'claude' | 'codex';

/** Initial dimensions for an interactive provider-login terminal. */
export interface OnboardingLoginArg {
  provider: OnboardingLoginProvider;
  cols?: number;
  rows?: number;
  /** Requested provider auth path when Settings switches methods. APPEND-ONLY. */
  method?: 'cli' | 'api_key';
  /** Run login even when status currently reports connected. APPEND-ONLY. */
  force?: boolean;
}

/** Frames emitted while an onboarding provider login command runs. */
export type OnboardingLoginChunk =
  | { kind: 'started'; ptyId: string; command: string }
  | { kind: 'data'; data: string }
  | {
      kind: 'finished';
      provider: OnboardingLoginProvider;
      authenticated: boolean;
    }
  | { kind: 'progress'; message: string };

/** A direct child returned by the workspace's lazy directory browser. APPEND-ONLY. */
export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'symlink';
}
