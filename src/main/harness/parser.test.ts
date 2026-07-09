// Self-validation for the stream-JSON parser (Task 2). Proves the two load-bearing
// properties NOW: the normalization table (each fixture → the expected AgentEvent[])
// and partial-line buffering across arbitrary chunk boundaries. The test-author will
// later layer full `toMatchSnapshot()` coverage on top (phase-doc §9 / plan Task 9).
//
// IMPORTANT — CLI-drift tripwire: the fixtures under ./fixtures are HAND-AUTHORED
// representative samples of `claude --output-format stream-json --verbose`, since no
// real `claude` CLI is available in this environment. They MUST be re-recorded against
// a real CLI to become a true drift detector; until then they only prove the mapping
// logic, not fidelity to the current CLI output.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@shared/harness';
import {
  createJsonLineSplitter,
  normalize,
  type NormalizeResult,
} from './parser';

/** Read a fixture file (resolved relative to this test) as a raw string. */
function readFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    'utf8',
  );
}

/**
 * Feed a whole fixture through the splitter in one push (+flush) and normalize
 * every object, collecting the AgentEvents and any captured session id. This is
 * the same funnel the adapter uses: splitter → normalize → sink.
 */
function run(raw: string): { events: AgentEvent[]; sessionIds: string[] } {
  const splitter = createJsonLineSplitter();
  const objects = [...splitter.push(raw), ...splitter.flush()];
  return collect(objects);
}

function collect(objects: unknown[]): {
  events: AgentEvent[];
  sessionIds: string[];
} {
  const events: AgentEvent[] = [];
  const sessionIds: string[] = [];
  for (const obj of objects) {
    for (const result of normalize(obj)) {
      applyResult(result, events, sessionIds);
    }
  }
  return { events, sessionIds };
}

function applyResult(
  result: NormalizeResult,
  events: AgentEvent[],
  sessionIds: string[],
): void {
  if (result === null) {
    return;
  }
  if (result.type === 'session') {
    sessionIds.push(result.sessionId);
  } else {
    events.push(result.event);
  }
}

describe('createJsonLineSplitter', () => {
  it('parses complete lines and holds a partial trailing line', () => {
    const splitter = createJsonLineSplitter();
    // Two complete lines + a partial third with no terminating newline.
    const first = splitter.push('{"type":"a"}\n{"type":"b"}\n{"type":"c"');
    expect(first).toEqual([{ type: 'a' }, { type: 'b' }]);
    // Complete the third line; only it comes out now.
    const second = splitter.push('}\n');
    expect(second).toEqual([{ type: 'c' }]);
  });

  it('buffers a JSON object split across arbitrary byte boundaries', () => {
    const raw = readFixture('text.jsonl');
    // Split at every single character to stress the cross-chunk buffering: the
    // result must be identical to feeding the whole payload at once.
    const splitter = createJsonLineSplitter();
    const objects: unknown[] = [];
    for (const ch of raw) {
      objects.push(...splitter.push(ch));
    }
    objects.push(...splitter.flush());

    const whole = createJsonLineSplitter();
    const expected = [...whole.push(raw), ...whole.flush()];
    expect(objects).toEqual(expected);
    expect(objects).toHaveLength(4); // init + 2 assistant + result
  });

  it('flushes a final line that lacks a trailing newline', () => {
    const splitter = createJsonLineSplitter();
    expect(splitter.push('{"type":"result","subtype":"success"}')).toEqual([]);
    expect(splitter.flush()).toEqual([{ type: 'result', subtype: 'success' }]);
  });

  it('skips malformed lines (reports via onWarn) without throwing', () => {
    const warnings: string[] = [];
    const splitter = createJsonLineSplitter((msg) => warnings.push(msg));
    const out = splitter.push('{"type":"a"}\nnot json at all\n{"type":"b"}\n');
    expect(out).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('malformed');
  });
});

describe('normalize — normalization table', () => {
  it('captures the session id from the system/init event (text fixture)', () => {
    const { events, sessionIds } = run(readFixture('text.jsonl'));
    expect(sessionIds).toEqual(['sess-text-001']);
    expect(events).toEqual([
      { kind: 'text', delta: 'Hello, ' },
      { kind: 'text', delta: 'world.' },
      { kind: 'turn_end', usage: { inputTokens: 123, outputTokens: 45 } },
    ]);
  });

  it('maps a tool_use + tool_result + success result', () => {
    const { events, sessionIds } = run(readFixture('tool_use.jsonl'));
    expect(sessionIds).toEqual(['sess-tool-001']);
    expect(events).toEqual([
      {
        kind: 'tool_use',
        name: 'Bash',
        input: { command: 'ls -la', description: 'List files' },
      },
      {
        kind: 'tool_result',
        output: 'total 0\ndrwxr-xr-x  2 user staff 64 file.txt',
      },
      { kind: 'turn_end', usage: { inputTokens: 200, outputTokens: 30 } },
    ]);
  });

  it('maps Write→create and Edit→modify file_edit events (not raw tool_use)', () => {
    const { events } = run(readFixture('file_edit.jsonl'));
    expect(events).toEqual([
      { kind: 'file_edit', path: '/repo/src/new.ts', op: 'create' },
      { kind: 'file_edit', path: '/repo/src/existing.ts', op: 'modify' },
      { kind: 'turn_end', usage: { inputTokens: 300, outputTokens: 80 } },
    ]);
  });

  it('maps a result with is_error:true to an error event carrying only a message', () => {
    const { events } = run(readFixture('error.jsonl'));
    expect(events).toEqual([
      { kind: 'error', message: 'The agent hit an unrecoverable error.' },
    ]);
  });

  it('captures session on resume and maps TodoWrite to a todo_update', () => {
    const { events, sessionIds } = run(readFixture('resume.jsonl'));
    expect(sessionIds).toEqual(['sess-resume-abc']);
    expect(events).toEqual([
      { kind: 'text', delta: 'Resuming where we left off.' },
      {
        kind: 'todo_update',
        todos: [
          { id: '0', body: 'Read the spec', done: true, source: 'agent' },
          {
            id: '1',
            body: 'Implement the parser',
            done: false,
            source: 'agent',
          },
        ],
      },
      { kind: 'turn_end', usage: { inputTokens: 500, outputTokens: 60 } },
    ]);
  });

  it('ignores an unknown top-level type (forward-compat)', () => {
    const { events, sessionIds } = run(readFixture('unknown.jsonl'));
    expect(events).toEqual([]);
    expect(sessionIds).toEqual([]);
  });

  it('returns [] for non-record and structurally-empty input', () => {
    expect(normalize(null)).toEqual([]);
    expect(normalize(42)).toEqual([]);
    expect(normalize('a string')).toEqual([]);
    expect(normalize([])).toEqual([]);
    expect(normalize({ type: 'assistant' })).toEqual([]); // no message.content
  });

  it('falls back to a subtype message when an error result has no result string', () => {
    expect(normalize({ type: 'result', subtype: 'error_max_turns' })).toEqual([
      { type: 'event', event: { kind: 'error', message: 'error_max_turns' } },
    ]);
  });

  it('omits usage when the result carries none', () => {
    expect(normalize({ type: 'result', subtype: 'success' })).toEqual([
      { type: 'event', event: { kind: 'turn_end' } },
    ]);
  });

  it('falls back to raw tool_use when a file-edit tool has no resolvable path', () => {
    expect(
      normalize({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: {} }],
        },
      }),
    ).toEqual([
      { type: 'event', event: { kind: 'tool_use', name: 'Edit', input: {} } },
    ]);
  });
});
