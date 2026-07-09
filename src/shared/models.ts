// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
// Row/DTO types that cross the process boundary. Column set matches spec §3 DDL.
// IDs are UUIDv7 strings (generated in main); timestamps are epoch-millis numbers
// (README §6.1). The DB layer (src/main/db, Phase 0 Task 4) maps its row types
// (e.g. INTEGER booleans) to/from these DTOs explicitly.

import type { AgentEvent, AgentMode, HarnessId } from './harness';

/** Lifecycle status of a workspace (spec §3 `workspaces.status`, §5.1). */
export type WorkspaceStatus =
  'idle' | 'working' | 'needs_attention' | 'running' | 'archived';

/** Where a workspace was created from (spec §3 `workspaces.source_kind`). */
export type WorkspaceSourceKind =
  'none' | 'branch' | 'pr' | 'github_issue' | 'linear_issue';

/** A registered git repository managed by the app (spec §3 `projects`). */
export interface Project {
  id: string; // uuid (v7)
  name: string;
  originUrl: string; // origin_url
  defaultBranch: string; // default_branch
  repoPath: string; // repo_path
  createdAt: number; // created_at — epoch millis
}

/**
 * A git worktree + branch + agent session + metadata (spec §3 `workspaces`).
 * Nullable columns per DDL: worktreePath, sourceKind, sourceRef, port, archivedAt.
 */
export interface Workspace {
  id: string; // uuid (v7)
  projectId: string; // project_id
  name: string; // city name, unique per project
  branch: string;
  baseBranch: string; // base_branch
  worktreePath: string | null; // worktree_path — NULL when archived
  status: WorkspaceStatus;
  sourceKind: WorkspaceSourceKind | null; // source_kind
  sourceRef: string | null; // source_ref — PR number / issue key / branch name
  harness: HarnessId;
  port: number | null; // allocated dev-server port
  createdAt: number; // created_at — epoch millis
  archivedAt: number | null; // archived_at — epoch millis
  prNumber: number | null; // pr_number — GitHub PR number (Phase 5, migration 0007), NULL until a PR is opened
}

/**
 * Request shape for creating a workspace (spec §5.1). Shared by the renderer (which
 * builds it from the New-Workspace dialog) and main (`WorkspaceManager.create`). All
 * fields except `projectId` are optional — omitted values are allocated: a unique city
 * `name`, a `<git.branchPrefix>/<name>` branch, the project default `baseBranch`, and
 * the settings default `harness`. `sourceKind`/`sourceRef` describe a PR/issue seed.
 * APPEND-ONLY: Phase 1 addition (README §5.2).
 */
export interface CreateWorkspaceReq {
  projectId: string;
  /** Explicit city name; allocated from the city list when omitted. */
  name?: string;
  /** Explicit branch; derived as `<prefix>/<name>` when omitted. */
  branch?: string;
  /** Base ref the worktree branches from (defaults to the project default branch). */
  baseBranch?: string;
  /** Which harness this workspace uses (defaults to the settings default). */
  harness?: HarnessId;
  /** Origin of the workspace (branch / PR / issue) — defaults to `none`. */
  sourceKind?: WorkspaceSourceKind;
  /** PR number / issue key / branch name matching `sourceKind`. */
  sourceRef?: string;
}

/**
 * Lifecycle of a single agent turn (spec §4.2). `streaming` while events flow;
 * `completed` on a clean `turn_end`; `interrupted` when the user stops it; `error`
 * when the harness reports a failure. APPEND-ONLY: Phase 2 addition (README §5.2).
 */
export type TurnStatus = 'streaming' | 'completed' | 'interrupted' | 'error';

/**
 * One persisted `AgentEvent` within a turn (migration 0003 `events` row → DTO).
 * `kind` is kept as a plain string for forward-compat — an unknown future kind
 * still round-trips — while `event` is the deserialized payload (README §6.3).
 * APPEND-ONLY: Phase 2 addition (README §5.2).
 */
export interface TurnEventRecord {
  id: string; // uuid (v7)
  turnId: string; // turn_id
  kind: string; // AgentEvent kind, kept as string for forward-compat
  event: AgentEvent; // deserialized payload_json
  ts: number; // epoch millis
}

/**
 * A single agent turn plus its ordered events (migration 0003 `turns` row → DTO),
 * used to reconstruct chat history. Nullable columns per DDL: sessionId, mode,
 * endedAt, inputTokens, outputTokens. `events` is filled by the history assembler
 * (empty on the bare row read). APPEND-ONLY: Phase 2 addition (README §5.2).
 */
export interface TurnRecord {
  id: string; // uuid (v7)
  workspaceId: string; // workspace_id
  idx: number; // 0-based ordinal within the workspace
  status: TurnStatus;
  sessionId: string | null; // session_id — harness resume handle
  mode: AgentMode | null; // plan|default|auto_accept
  startedAt: number; // started_at — epoch millis
  endedAt: number | null; // ended_at — epoch millis, null while streaming
  inputTokens: number | null; // input_tokens — usage at turn end
  outputTokens: number | null; // output_tokens
  events: TurnEventRecord[]; // ordered ts ASC; empty on a bare row read
}
