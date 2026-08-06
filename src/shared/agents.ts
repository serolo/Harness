// Serializable contracts for project-scoped, file-configured meta agents.
// This module is import-safe from main, preload, and renderer.

import type { HarnessId } from './harness';

export const META_AGENT_SCHEMA_VERSION = 1 as const;

export type MetaAgentOrigin = 'builtin' | 'project';
/** Closed runtime protocol with semantics enforced beyond the generic role graph. */
export type MetaAgentProtocol = 'debby';
export type MetaAgentCapability =
  | 'delegate'
  | 'continue_dispatch'
  | 'await_dispatches'
  | 'cancel_dispatch'
  | 'push_with_consent'
  | 'open_pr_with_consent';
export type AgentDiagnosticSeverity = 'error' | 'warning';
export type MetaRunStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'taken_over';
export type AgentDispatchStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type AgentDispatchPurpose =
  'research' | 'plan' | 'implement' | 'test' | 'review' | 'verify' | 'critique';

export interface AgentValidationDiagnostic {
  severity: AgentDiagnosticSeverity;
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface AdapterCoordinatorCapability {
  mcpControl: boolean;
  readOnlyMode: boolean;
}

export interface AgentRunPolicy {
  maxDispatches: number;
  maxParallel: number;
  maxDepth: 1;
  turnTimeoutMs: number;
  runTimeoutMs: number;
  maxRequestBytes: number;
  maxResultBytes: number;
  critiqueRounds: number;
}

export interface AgentExecutorSnapshot {
  harness: HarnessId;
  model?: string;
  mode: 'plan' | 'default';
  readOnlyMode?: boolean;
}

export interface AgentRoleSnapshot {
  slug: string;
  name: string;
  description?: string;
  prompt: string;
  instructions?: string;
  executor: AgentExecutorSnapshot;
  purposes: AgentDispatchPurpose[];
  independentProvider?: boolean;
}

export interface NormalizedAgentSnapshot {
  schemaVersion: typeof META_AGENT_SCHEMA_VERSION;
  slug: string;
  name: string;
  description: string;
  revision: string;
  prompt: string;
  instructions?: string;
  coordinator: AgentExecutorSnapshot;
  roles: AgentRoleSnapshot[];
  skills: { slug: string; content: string }[];
  capabilities: MetaAgentCapability[];
  requiredProviders: HarnessId[];
  policy: AgentRunPolicy;
  /** Stable protocol identity preserved when a built-in is duplicated. APPEND-ONLY. */
  protocol?: MetaAgentProtocol;
}

export interface MetaAgentSummary {
  id: string;
  projectId: string | null;
  slug: string;
  origin: MetaAgentOrigin;
  name: string;
  description: string;
  revision: string;
  valid: boolean;
  diagnostics: AgentValidationDiagnostic[];
  requiredProviders: HarnessId[];
  capabilities: MetaAgentCapability[];
  available: boolean;
  unavailableReasons: string[];
  editable: boolean;
  /** Stable protocol identity preserved when a built-in is duplicated. APPEND-ONLY. */
  protocol?: MetaAgentProtocol;
}

export interface MetaAgentDetail extends MetaAgentSummary {
  files: string[];
}

export interface AgentDispatchSummary {
  id: string;
  runId: string;
  parentDispatchId: string | null;
  role: string;
  purpose: AgentDispatchPurpose;
  childAgentSlug: string;
  workspaceId: string | null;
  branch: string | null;
  turnId: string | null;
  sessionId: string | null;
  harness: HarnessId;
  model: string | null;
  status: AgentDispatchStatus;
  summary: string | null;
  changedFiles: string[];
  diffStat: string | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Debby protocol stage; absent for ordinary meta agents. APPEND-ONLY. */
  debateStage?: 'partner' | 'critique';
  /** One-based critique round; partner responses use round 0. APPEND-ONLY. */
  debateRound?: number;
}

export interface MetaRunSummary {
  id: string;
  projectId: string;
  sourceWorkspaceId: string;
  coordinatorWorkspaceId: string | null;
  agentId: string;
  agentName: string;
  agentRevision: string;
  goal: string;
  status: MetaRunStatus;
  allowPush: boolean;
  allowOpenPr: boolean;
  finalSummary: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Protocol copied from the immutable stored snapshot. APPEND-ONLY. */
  agentProtocol?: MetaAgentProtocol;
}

export interface MetaRunDetail extends MetaRunSummary {
  dispatches: AgentDispatchSummary[];
}

export interface StartMetaRunRequest {
  projectId: string;
  agentId: string;
  sourceWorkspaceId: string;
  goal: string;
  allowPush?: boolean;
  allowOpenPr?: boolean;
  policy?: Partial<AgentRunPolicy>;
}

export interface AgentFileResult {
  path: string;
  content: string;
  diagnostics: AgentValidationDiagnostic[];
}

export interface ValidateAgentFileRequest {
  projectId: string;
  agentId?: string;
  path: string;
  content: string;
}

export interface MetaAgentChangeEvent {
  projectId: string;
  agentId?: string;
  reason: 'created' | 'changed' | 'deleted' | 'validation';
}

export interface MetaRunChangeEvent {
  projectId: string;
  runId: string;
  status: MetaRunStatus;
}

export interface MetaRunTurnStartedEvent {
  runId: string;
  dispatchId?: string;
  workspaceId: string;
  turnId: string;
  sessionId: string;
  role: string;
}
