// Project Knowledge Wiki contracts. The durable representation is OKF v0.1;
// these DTOs are only the typed IPC/UI projection of the files and Git history.

export type WikiPageStatus =
  'canonical' | 'proposed' | 'historical' | 'deprecated' | 'research';

export interface KnowledgeConfig {
  enabled: boolean;
  storage: 'local' | 'github';
  proposalMode: 'review_required';
  injectContext: boolean;
  extractAfterTurn: boolean;
  search: {
    enabled: boolean;
    provider: 'qmd' | 'basic' | 'none';
    maxResults: number;
    rerank: boolean;
  };
  format: {
    name: 'okf';
    version: '0.1';
  };
}

export interface WikiPageSummary {
  id: string;
  path: string;
  title: string;
  type: string;
  status: WikiPageStatus;
  tags: string[];
  updatedAt?: string;
  /** Human-readable catalog summary from OKF `description`. */
  description?: string;
  /** Conditions under which this page should be retrieved. */
  appliesWhen?: string[];
  /** Repository globs associated with this knowledge. */
  globs?: string[];
  /** Stable source references carried by the OKF page. */
  source?: string[];
  /** Related OKF or external links carried by the OKF page. */
  links?: string[];
}

export interface WikiPage extends WikiPageSummary {
  content: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface WikiSearchResult {
  pageId: string;
  path: string;
  title: string;
  heading?: string;
  snippet: string;
  score?: number;
  status: WikiPageStatus;
}

export type WikiOperation =
  | { op: 'create'; path: string; content: string }
  | { op: 'update'; path: string; content: string }
  | { op: 'move'; from: string; to: string };

export type WikiProposalStatus =
  'pending_review' | 'accepted' | 'rejected' | 'conflicted';

export interface WikiProposal {
  id: string;
  projectId: string;
  workspaceId?: string;
  turnId?: string;
  baseWikiCommit: string;
  title: string;
  summary: string;
  operations: WikiOperation[];
  status: WikiProposalStatus;
  createdAt: number;
  reviewedAt?: number;
  acceptedCommit?: string;
  rejectionReason?: string;
}

export interface WikiHistoryEntry {
  commit: string;
  subject: string;
  author: string;
  timestamp: number;
}

export interface WikiLintFinding {
  severity: 'warning' | 'error';
  code:
    | 'invalid_frontmatter'
    | 'missing_type'
    | 'duplicate_id'
    | 'broken_link'
    | 'invalid_reserved_file';
  path: string;
  message: string;
}

export interface WikiLintResult {
  ok: boolean;
  findings: WikiLintFinding[];
}

export interface WikiImportResult {
  imported: boolean;
  fileCount: number;
  createdCount: number;
  updatedCount: number;
  commit?: string;
  /** ZIP imports remain pending until this review proposal is accepted. */
  proposalId?: string;
}

export interface WikiCatalogUpdateResult {
  updated: boolean;
  pageCount: number;
  commit?: string;
}

export interface QmdStatus {
  installed: boolean;
  version?: string;
}

export interface CreateWikiProposalInput {
  projectId: string;
  workspaceId?: string;
  turnId?: string;
  title: string;
  summary: string;
  operations: WikiOperation[];
}

export type AgentMemoryProvider = 'claude_code' | 'codex';

export type AgentMemoryExclusionReason =
  | 'binary'
  | 'secret_detected'
  | 'too_large'
  | 'unsupported'
  | 'unreadable';

export interface AgentMemorySource {
  id: string;
  provider: AgentMemoryProvider;
  label: string;
  displayPath: string;
  size: number;
  kind: 'project_instruction' | 'provider_memory';
  eligible: boolean;
  exclusionReason?: AgentMemoryExclusionReason;
  preview?: string;
}

export interface AgentMemoryDiscovery {
  discoveryId: string;
  provider: AgentMemoryProvider;
  sources: AgentMemorySource[];
  eligibleCount: number;
  excludedCount: number;
}

export interface AgentMemoryProposalResult {
  proposal?: WikiProposal;
  selectedCount: number;
  operationCount: number;
  skippedCount: number;
  excludedCount: number;
}

// --- Progressive knowledge retrieval (APPEND-ONLY) -------------------------

/** Local retrieval metadata shown in chat but never included in the model prompt. */
export interface KnowledgeRetrievalTrace {
  requestedProvider: 'qmd' | 'basic' | 'none';
  providerUsed: 'qmd' | 'basic' | 'none';
  searchEnabled: boolean;
  searchStatus: 'completed' | 'fallback' | 'failed' | 'disabled';
  candidateCount: number;
  selectedCount: number;
  catalogFallback: boolean;
  maxContextTokens: number;
}
