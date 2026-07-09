// Claude Code stream-JSON parser — a PURE transform from the CLI's
// `--output-format stream-json --verbose` stdout into the frozen `AgentEvent`
// stream (spec §4.2 / phase-doc §3.1; README §9 CLI-drift risk).
//
// This module is deliberately dependency-free: no `child_process`, no
// `electron`, no `node-pty`, no DOM. It imports only pure `@shared/*` types.
// That purity is the whole point — it is unit/contract-tested from recorded
// fixtures with ZERO process spawn, so it is the primary tripwire for CLI
// output drift. The adapter (`claude-code.ts`, Task 3) composes it around a
// real spawned process.
//
// Two responsibilities, kept separate:
//   1. `createJsonLineSplitter()` — split a byte-stream into complete JSON
//      lines, holding a partial trailing line across chunk boundaries (large
//      tool outputs routinely exceed one stdout chunk — phase-doc §8).
//   2. `normalize()` — map ONE parsed stream-JSON object to zero-or-more
//      `AgentEvent`s (or a captured session id). Unknown shapes are ignored
//      for forward-compat.
//
// Coalescing of adjacent text deltas is NOT done here — that is the recorder's
// job (Task 4). The parser emits one result per source construct.

import type { AgentEvent, Todo } from '@shared/harness';

// ---------------------------------------------------------------------------
// (1) Line splitter with partial-line buffering
// ---------------------------------------------------------------------------

export interface JsonLineSplitter {
  /**
   * Feed a stdout chunk; returns the fully-parsed JSON object for each COMPLETE
   * line seen so far. A partial trailing line (no terminating `\n` yet) is held
   * in an internal buffer and completed by a later `push`/`flush`. Malformed
   * lines are skipped (reported via `onWarn`), never thrown — a single garbled
   * line must not tear down the whole turn.
   */
  push(chunk: string): unknown[];
  /**
   * Flush any buffered trailing line at stream end. Parses and returns it when
   * non-empty; a lone trailing newline or trailing whitespace yields nothing.
   */
  flush(): unknown[];
}

/**
 * Create a stateful newline-delimited-JSON splitter. `onWarn`, if supplied, is
 * called with a human-readable message for each unparseable line (the parser
 * stays pure by taking a logger injection rather than importing one — the
 * main-process logger pulls in `electron`, which would break this module's
 * import-safety). Without `onWarn`, malformed lines are silently skipped.
 */
export function createJsonLineSplitter(
  onWarn?: (msg: string) => void,
): JsonLineSplitter {
  // The only mutable state: the not-yet-terminated tail of the stream.
  let buffer = '';

  function parseLine(line: string): unknown[] {
    // Ignore blank/whitespace-only lines (the CLI emits a trailing newline).
    if (line.trim() === '') {
      return [];
    }
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      // Skip, don't throw: never carry the raw line into the warning in case it
      // holds sensitive payload; length is enough to diagnose truncation drift.
      onWarn?.(`skipped malformed stream-json line (${line.length} chars)`);
      return [];
    }
  }

  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const segments = buffer.split('\n');
      // The last segment is everything after the final '\n' — a partial line
      // (possibly empty). Hold it; every earlier segment is a complete line.
      buffer = segments.pop() ?? '';
      const out: unknown[] = [];
      for (const segment of segments) {
        out.push(...parseLine(segment));
      }
      return out;
    },

    flush(): unknown[] {
      const remaining = buffer;
      buffer = '';
      return parseLine(remaining);
    },
  };
}

// ---------------------------------------------------------------------------
// (2) Normalization table
// ---------------------------------------------------------------------------
//
// Return-shape decision: `normalize(obj)` returns `NormalizeResult[]` — ALWAYS
// an array (`[]` for ignored/unknown). A single stream-JSON `assistant` message
// can carry MANY content blocks (text + several tool_use + …), and a `user`
// message can carry multiple `tool_result` blocks, so a one-result-per-call
// signature could not express them. An array is the honest shape and keeps the
// call site a flat `for (const r of normalize(obj))`.
//
// Normalization table (Claude Code `--output-format stream-json --verbose`):
//
//   source object                                   → NormalizeResult(s)
//   ─────────────────────────────────────────────────────────────────────────
//   {type:'system', subtype:'init', session_id}     → { session, sessionId }
//   {type:'assistant', message:{content:[…]}}        → per content block:
//       {type:'text', text}                          → { event: text }
//       {type:'tool_use', name:'TodoWrite', input}   → { event: todo_update }
//       {type:'tool_use', name∈{Write}, input}       → { event: file_edit create }
//       {type:'tool_use', name∈{Edit,MultiEdit,      → { event: file_edit modify }
//                               NotebookEdit}, input}
//       {type:'tool_use', name, input}  (any other)  → { event: tool_use }
//   {type:'user', message:{content:[…]}}             → per content block:
//       {type:'tool_result', content}                → { event: tool_result }
//   {type:'result', subtype:'success', usage, …}     → { event: turn_end }
//   {type:'result', is_error:true | subtype error}   → { event: error }
//   {type:<anything else>} / malformed               → []  (forward-compat)
//
// Notes:
//   • Edit/Write/MultiEdit/NotebookEdit tool_use is mapped to a `file_edit`
//     event ONLY (not double-emitted as a tool_use). Path comes from
//     input.file_path ?? input.path ?? input.notebook_path.
//   • TodoWrite tolerates Claude's `{content,status,activeForm}` todo shape:
//     body ← content, done ← status==='completed', id ← provided id or index.
//   • `result.usage.input_tokens/output_tokens` map to camelCase inputTokens/
//     outputTokens; omitted when not numbers.
//   • An error is NEVER JSON.stringify'd — only a string message is carried.

export type NormalizeResult =
  | { type: 'event'; event: AgentEvent }
  | { type: 'session'; sessionId: string }
  | null; // (kept in the union for callers; normalize itself returns [] not null)

/** Tool names whose `tool_use` is surfaced as a `file_edit` rather than a raw tool call. */
const FILE_EDIT_OPS: Readonly<Record<string, 'create' | 'modify'>> = {
  Write: 'create',
  Edit: 'modify',
  MultiEdit: 'modify',
  NotebookEdit: 'modify',
};

/**
 * Map a single parsed stream-JSON object to zero-or-more `AgentEvent`s (wrapped
 * as `NormalizeResult`s, plus the session-capture result). Pure and total:
 * unrecognized or malformed input yields `[]`, never a throw.
 */
export function normalize(obj: unknown): NormalizeResult[] {
  if (!isRecord(obj)) {
    return [];
  }
  const type = asString(obj.type);
  switch (type) {
    case 'system':
      return normalizeSystem(obj);
    case 'assistant':
      return normalizeAssistant(obj);
    case 'user':
      return normalizeUser(obj);
    case 'result':
      return normalizeResult(obj);
    default:
      // Unknown top-level type — ignore for forward-compat (spec §9).
      return [];
  }
}

/** system/init carries the session id we thread onto the TurnHandle. */
function normalizeSystem(obj: Record<string, unknown>): NormalizeResult[] {
  if (asString(obj.subtype) !== 'init') {
    return [];
  }
  const sessionId = asString(obj.session_id);
  return sessionId ? [{ type: 'session', sessionId }] : [];
}

/** assistant messages fan out over their content blocks. */
function normalizeAssistant(obj: Record<string, unknown>): NormalizeResult[] {
  const content = messageContent(obj);
  const out: NormalizeResult[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const blockType = asString(block.type);
    if (blockType === 'text') {
      const delta = asString(block.text);
      if (delta !== undefined) {
        out.push({ type: 'event', event: { kind: 'text', delta } });
      }
    } else if (blockType === 'tool_use') {
      const event = normalizeToolUse(block);
      if (event) {
        out.push({ type: 'event', event });
      }
    }
    // Other block types (e.g. thinking) are ignored for forward-compat.
  }
  return out;
}

/** A single `tool_use` block → todo_update | file_edit | tool_use. */
function normalizeToolUse(block: Record<string, unknown>): AgentEvent | null {
  const name = asString(block.name);
  if (name === undefined) {
    return null;
  }
  const input = block.input;

  if (name === 'TodoWrite') {
    return { kind: 'todo_update', todos: extractTodos(input) };
  }

  const op = FILE_EDIT_OPS[name];
  if (op !== undefined) {
    const path = extractEditPath(input);
    // A file-edit tool with no resolvable path can't become a file_edit event;
    // fall back to a raw tool_use so the call is still visible in the transcript.
    if (path !== undefined) {
      return { kind: 'file_edit', path, op };
    }
  }

  return { kind: 'tool_use', name, input };
}

/** user messages carry tool_result blocks (one AgentEvent each). */
function normalizeUser(obj: Record<string, unknown>): NormalizeResult[] {
  const content = messageContent(obj);
  const out: NormalizeResult[] = [];
  for (const block of content) {
    if (isRecord(block) && asString(block.type) === 'tool_result') {
      // `content` may be a string or an array of blocks — carry it opaquely.
      out.push({
        type: 'event',
        event: { kind: 'tool_result', output: block.content },
      });
    }
  }
  return out;
}

/** result closes a turn: success → turn_end(usage); error → error(message). */
function normalizeResult(obj: Record<string, unknown>): NormalizeResult[] {
  const subtype = asString(obj.subtype);
  const isError =
    obj.is_error === true || (subtype?.startsWith('error') ?? false);

  if (isError) {
    // Carry only a string message — never JSON.stringify an error object.
    const message = asString(obj.result) ?? subtype ?? 'agent turn failed';
    return [{ type: 'event', event: { kind: 'error', message } }];
  }

  const usage = extractUsage(obj.usage);
  return [
    { type: 'event', event: { kind: 'turn_end', ...(usage ? { usage } : {}) } },
  ];
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

/** The `message.content` array of an assistant/user object, or `[]`. */
function messageContent(obj: Record<string, unknown>): unknown[] {
  const message = obj.message;
  if (!isRecord(message)) {
    return [];
  }
  const content = message.content;
  return Array.isArray(content) ? content : [];
}

/** Resolve a file-edit tool's target path across the CLI's field spellings. */
function extractEditPath(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  return (
    asString(input.file_path) ??
    asString(input.path) ??
    asString(input.notebook_path)
  );
}

/**
 * Map TodoWrite input to the frozen `Todo[]`. Tolerates Claude's native todo
 * shape (`{content, status, activeForm}`) as well as an already-normalized
 * `{id, body, done}`. `source` is always `'agent'` (these come from the agent).
 */
function extractTodos(input: unknown): Todo[] {
  if (!isRecord(input) || !Array.isArray(input.todos)) {
    return [];
  }
  const todos: Todo[] = [];
  input.todos.forEach((raw, index) => {
    if (!isRecord(raw)) {
      return;
    }
    const body = asString(raw.body) ?? asString(raw.content);
    if (body === undefined) {
      return;
    }
    const done =
      typeof raw.done === 'boolean' ? raw.done : raw.status === 'completed';
    const id = asString(raw.id) ?? String(index);
    todos.push({ id, body, done, source: 'agent' });
  });
  return todos;
}

/** Map result `usage` (snake_case) to the frozen `Usage` (camelCase), or undefined. */
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
