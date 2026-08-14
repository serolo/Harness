// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
//
// FROZEN: README §6.3 — supersedes spec §4.1 (push-based sink).
// README §6.3 and spec §4.1 disagree on the Harness shape. README §6.3 WINS and
// is copied verbatim below: startTurn is push-based (takes a StreamSink), adds
// capabilities() + detect(), mcpConfig is REQUIRED, and TurnHandle carries only
// { sessionId; interrupt() } — there is NO pull-based `events: AsyncIterable`.
// Do not merge the two shapes; Phase 2 builds against this one.

import type { StreamSink } from './ipc';
import type { KnowledgeRetrievalTrace } from './knowledge';

export type HarnessId = 'claude_code' | 'codex' | 'cursor';
export type AgentAuthMethod = 'cli' | 'api_key' | 'none';
/** Provider-neutral reasoning effort; adapters validate/map supported levels. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Harness {
  id: HarnessId;
  capabilities(): HarnessCapabilities; // supportsResume, supportsMcp, supportsPlanMode, rawTerminalFallback
  detect(): Promise<DetectResult>; // { installed, version?, authenticated }
  startTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle>;
}

export interface StartTurnOpts {
  workspaceDir: string;
  prompt: string;
  /** Original user-authored text, excluding app-injected model context. */
  displayPrompt?: string;
  /** Knowledge pages selected while preparing this turn. */
  knowledgeSources?: {
    path: string;
    title: string;
    /** Approximate tokens contributed by this source's injected section. APPEND-ONLY. */
    estimatedTokens?: number;
  }[];
  /** Local retrieval metadata for the transcript; never appended to `prompt`. APPEND-ONLY. */
  knowledgeRetrieval?: KnowledgeRetrievalTrace;
  /** Private main-process trace transport. Never persist, render, or expose over IPC. APPEND-ONLY. */
  knowledgeTrace?: { filePath: string; cleanupDir: string };
  attachments: Attachment[]; // files, images, diff comments
  sessionId?: string; // resume previous session
  mode?: AgentMode; // "plan" | "default" | "auto_accept"
  mcpConfig: McpServerConfig[];
  permissionPolicy: PermissionPolicy;
  /** Optional model override passed to the CLI (e.g. `--model sonnet`). APPEND-ONLY (Phase 12). */
  model?: string;
  /** Optional reasoning-effort override passed to providers that support it. APPEND-ONLY. */
  effort?: ReasoningEffort;
  /**
   * The chat tab (`ChatContextRecord.id`) this turn belongs to; persisted onto the turn
   * row, never passed to a CLI. Omitted leaves the turn unowned. APPEND-ONLY.
   */
  contextId?: string;
}

export interface TurnHandle {
  sessionId: string;
  interrupt(): Promise<void>;
}

export type AgentEvent =
  /** Harness metadata used by main-process persistence; not rendered as transcript content. */
  | { kind: 'model_info'; model: string }
  /** Latest provider request's context snapshot; distinct from cumulative turn billing. */
  | { kind: 'context_usage'; usage: Usage }
  | { kind: 'text'; delta: string }
  | { kind: 'activity'; title: string; detail?: string }
  | { kind: 'tool_use'; name: string; input: unknown }
  | { kind: 'tool_result'; output: unknown }
  | { kind: 'file_edit'; path: string; op: 'create' | 'modify' | 'delete' }
  | { kind: 'todo_update'; todos: Todo[] }
  | {
      kind: 'knowledge_proposal';
      projectId: string;
      proposalIds: string[];
    }
  | {
      kind: 'knowledge_context';
      sources: {
        path: string;
        title: string;
        /** Approximate tokens contributed by this source's injected section. APPEND-ONLY. */
        estimatedTokens?: number;
      }[];
      /** Local selection trace rendered in chat, not model context. APPEND-ONLY. */
      retrieval?: KnowledgeRetrievalTrace;
    }
  | { kind: 'turn_end'; usage?: Usage }
  | { kind: 'error'; message: string }
  /** App-originated prompt persisted beside harness events for chat reconstruction. */
  | { kind: 'user_message'; text: string }
  /** Attachments submitted with the adjacent user message. APPEND-ONLY. */
  | { kind: 'user_attachments'; attachments: Attachment[] }
  /** A structured question that needs a conversational answer from the user. */
  | {
      kind: 'question_request';
      requestId?: string;
      questions: AgentQuestion[];
    }
  /** A tool/action permission prompt. This is intentionally distinct from a question. */
  | {
      kind: 'permission_request';
      requestId?: string;
      title?: string;
      description?: string;
      toolName?: string;
      input?: unknown;
    }
  | {
      /** Sanitized usage emitted by Harness's read-only project-knowledge gateway. APPEND-ONLY. */
      kind: 'knowledge_retrieval';
      operation: 'search' | 'read';
      provider: 'qmd' | 'basic' | 'none';
      contextTokens: number;
      resultCount?: number;
      path?: string;
      truncated?: boolean;
    };

/** Provider-neutral shape used by Claude Code and Codex question prompts. */
export interface AgentQuestion {
  id?: string;
  header?: string;
  question: string;
  multiSelect?: boolean;
  options?: AgentQuestionOption[];
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

// Attachment format is frozen in Phase 2 and consumed by Phase 4:
export type Attachment =
  | { type: 'file'; path: string }
  | { type: 'image'; path: string }
  | {
      type: 'diff_comment';
      file: string;
      lineStart: number;
      lineEnd: number;
      side: 'old' | 'new';
      excerpt: string;
      body: string;
    };

// ---------------------------------------------------------------------------
// Supporting types README §6.3 references but does not fully spell out.
// Frozen here so every harness adapter (Phase 2, 7) shares one definition.
// ---------------------------------------------------------------------------

/** Per-harness feature flags letting the UI degrade gracefully (spec §4.3). */
export interface HarnessCapabilities {
  supportsResume: boolean;
  supportsMcp: boolean;
  supportsPlanMode: boolean;
  rawTerminalFallback: boolean;
}

/** Result of probing whether a harness CLI is installed/authenticated. */
export interface DetectResult {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  /** Active local authentication source when the provider exposes it. APPEND-ONLY. */
  authMethod?: AgentAuthMethod;
  /** Non-secret trailing credential characters for settings display. APPEND-ONLY. */
  credentialHint?: string;
  /** Human-readable provider name for connected-auth details. APPEND-ONLY. */
  providerLabel?: string;
  /** Human-readable subscription or billing plan when locally available. APPEND-ONLY. */
  planLabel?: string;
  /** Human-readable authentication mechanism. APPEND-ONLY. */
  authLabel?: string;
  /** Non-secret account identity such as an email address. APPEND-ONLY. */
  accountLabel?: string;
}

/** Agent run mode (spec §4.1). */
export type AgentMode = 'plan' | 'default' | 'auto_accept';

/** A single MCP server passed through to the agent CLI (spec §4.2 / §5.7 [mcp]). */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Agent permission policy (spec §7). `allowedTools` is the harness-native
 * tool allowlist; `allow`/`deny` are command allow/deny lists;
 * `confirmBeforeRun` surfaces as `needs_attention` before executing.
 */
export interface PermissionPolicy {
  allowedTools?: string[];
  allow?: string[];
  deny?: string[];
  confirmBeforeRun?: boolean;
}

/** A todo item (matches spec §3 `todos` table + the `todo_update` event). */
export interface Todo {
  id: string;
  body: string;
  done: boolean;
  source: 'user' | 'agent';
}

/** Token accounting reported at turn end. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens served from a provider cache; included in inputTokens when reported. */
  cachedInputTokens?: number;
  /** Input tokens written to a provider prompt cache. */
  cacheWriteInputTokens?: number;
}
