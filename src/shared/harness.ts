// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
//
// FROZEN: README §6.3 — supersedes spec §4.1 (push-based sink).
// README §6.3 and spec §4.1 disagree on the Harness shape. README §6.3 WINS and
// is copied verbatim below: startTurn is push-based (takes a StreamSink), adds
// capabilities() + detect(), mcpConfig is REQUIRED, and TurnHandle carries only
// { sessionId; interrupt() } — there is NO pull-based `events: AsyncIterable`.
// Do not merge the two shapes; Phase 2 builds against this one.

import type { StreamSink } from './ipc';

export type HarnessId = 'claude_code' | 'codex' | 'cursor';

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
  attachments: Attachment[]; // files, images, diff comments
  sessionId?: string; // resume previous session
  mode?: AgentMode; // "plan" | "default" | "auto_accept"
  mcpConfig: McpServerConfig[];
  permissionPolicy: PermissionPolicy;
  /** Optional model override passed to the CLI (e.g. `--model sonnet`). APPEND-ONLY (Phase 12). */
  model?: string;
}

export interface TurnHandle {
  sessionId: string;
  interrupt(): Promise<void>;
}

export type AgentEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'tool_use'; name: string; input: unknown }
  | { kind: 'tool_result'; output: unknown }
  | { kind: 'file_edit'; path: string; op: 'create' | 'modify' | 'delete' }
  | { kind: 'todo_update'; todos: Todo[] }
  | { kind: 'turn_end'; usage?: Usage }
  | { kind: 'error'; message: string };

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
}
