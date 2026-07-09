// Contract tests for the Codex harness adapter (plan Task 1). Proves the two
// load-bearing properties NOW: the Codex normalization table (each fixture → the
// expected AgentEvent[] + captured session id) and the `buildArgs` argv shape (the
// command-injection / MCP-passthrough surface). No real `codex` process is spawned.
//
// IMPORTANT — CLI-drift tripwire: the fixtures under ./fixtures/codex are HAND-AUTHORED
// samples of an ASSUMED `codex` JSON event stream (~v0.x), since no real `codex` CLI is
// available in this environment (plan §9). They MUST be re-recorded against a real CLI
// to become a true drift detector; until then they only prove the mapping logic, not
// fidelity to the current CLI output.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import type {
  AgentEvent,
  McpServerConfig,
  StartTurnOpts,
} from '@shared/harness';
import { createJsonLineSplitter } from './parser';
import { buildArgs, normalizeCodex } from './codex';

/** Read a Codex fixture file (resolved relative to this test) as a raw string. */
function readFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/codex/${name}`, import.meta.url)),
    'utf8',
  );
}

/**
 * Feed a whole fixture through the splitter (+flush) and normalize every object,
 * collecting the AgentEvents and any captured session id. This is the same funnel the
 * adapter uses: splitter → normalizeCodex → sink.
 */
function run(raw: string): { events: AgentEvent[]; sessionIds: string[] } {
  const splitter = createJsonLineSplitter();
  const objects = [...splitter.push(raw), ...splitter.flush()];
  const events: AgentEvent[] = [];
  const sessionIds: string[] = [];
  for (const obj of objects) {
    for (const result of normalizeCodex(obj)) {
      if (result.type === 'session') {
        sessionIds.push(result.sessionId);
      } else {
        events.push(result.event);
      }
    }
  }
  return { events, sessionIds };
}

describe('normalizeCodex — normalization table (ASSUMED codex format)', () => {
  it('captures the session id and maps text deltas + turn_end (text fixture)', () => {
    const { events, sessionIds } = run(readFixture('text.jsonl'));
    expect(sessionIds).toEqual(['codex-sess-text-001']);
    expect(events).toEqual([
      { kind: 'text', delta: 'Hello, ' },
      { kind: 'text', delta: 'world.' },
      { kind: 'turn_end', usage: { inputTokens: 123, outputTokens: 45 } },
    ]);
  });

  it('maps a tool_call to a tool_use (arguments carried as input)', () => {
    const { events, sessionIds } = run(readFixture('tool_use.jsonl'));
    expect(sessionIds).toEqual(['codex-sess-tool-001']);
    expect(events).toEqual([
      {
        kind: 'tool_use',
        name: 'shell',
        input: { command: 'ls -la', description: 'List files' },
      },
      { kind: 'turn_end', usage: { inputTokens: 200, outputTokens: 30 } },
    ]);
  });

  it('maps file_change add/modify/delete to file_edit ops', () => {
    const { events } = run(readFixture('file_edit.jsonl'));
    expect(events).toEqual([
      { kind: 'file_edit', path: '/repo/src/new.ts', op: 'create' },
      { kind: 'file_edit', path: '/repo/src/existing.ts', op: 'modify' },
      { kind: 'file_edit', path: '/repo/src/old.ts', op: 'delete' },
      { kind: 'turn_end', usage: { inputTokens: 300, outputTokens: 80 } },
    ]);
  });

  it('maps an error event carrying ONLY a string message', () => {
    const { events } = run(readFixture('error.jsonl'));
    expect(events).toEqual([
      { kind: 'error', message: 'The agent hit an unrecoverable error.' },
    ]);
  });

  it('captures session on resume and maps the resumed turn', () => {
    const { events, sessionIds } = run(readFixture('resume.jsonl'));
    expect(sessionIds).toEqual(['codex-sess-resume-abc']);
    expect(events).toEqual([
      { kind: 'text', delta: 'Resuming where we left off.' },
      {
        kind: 'tool_use',
        name: 'apply_patch',
        input: { path: '/repo/src/parser.ts' },
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
    expect(normalizeCodex(null)).toEqual([]);
    expect(normalizeCodex(42)).toEqual([]);
    expect(normalizeCodex('a string')).toEqual([]);
    expect(normalizeCodex([])).toEqual([]);
    expect(normalizeCodex({ type: 'session_configured' })).toEqual([]); // no session_id
  });

  it('drops empty text deltas and unmappable/incomplete constructs', () => {
    expect(normalizeCodex({ type: 'agent_message_delta', delta: '' })).toEqual(
      [],
    );
    expect(normalizeCodex({ type: 'tool_call' })).toEqual([]); // no name
    expect(
      normalizeCodex({ type: 'file_change', path: '/x', kind: 'renamed' }),
    ).toEqual([]); // unknown kind
    expect(normalizeCodex({ type: 'file_change', kind: 'add' })).toEqual([]); // no path
  });

  it('falls back to a default message when an error carries no message string', () => {
    expect(normalizeCodex({ type: 'error' })).toEqual([
      { type: 'event', event: { kind: 'error', message: 'agent turn failed' } },
    ]);
  });

  it('omits usage when turn_complete carries none', () => {
    expect(normalizeCodex({ type: 'turn_complete' })).toEqual([
      { type: 'event', event: { kind: 'turn_end' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildArgs — the spawn argv (command-injection + capability surface)
// ---------------------------------------------------------------------------

/** Minimal valid StartTurnOpts, overridable per test. */
function opts(overrides: Partial<StartTurnOpts> = {}): StartTurnOpts {
  return {
    workspaceDir: '/tmp/ws',
    prompt: 'do the thing',
    attachments: [],
    mcpConfig: [],
    permissionPolicy: {},
    ...overrides,
  };
}

/** Read the `--mcp-config <path>` value out of an argv, or undefined if absent. */
function mcpConfigPath(args: string[]): string | undefined {
  const i = args.indexOf('--mcp-config');
  return i >= 0 ? args[i + 1] : undefined;
}

describe('Codex adapter — buildArgs', () => {
  it('passes exec --json and the prompt as the final positional after `--`', () => {
    const args = buildArgs(opts());
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    // Prompt is the last argument, guarded by a `--` end-of-flags separator so a
    // dash-leading prompt can never be read as a flag (arg-injection defense).
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('do the thing');
  });

  it('appends serialized attachments to the single prompt argument', () => {
    const args = buildArgs(
      opts({
        attachments: [{ type: 'file', path: '/repo/README.md' }],
      }),
    );
    const prompt = args[args.length - 1];
    expect(prompt).toContain('do the thing');
    expect(prompt).toContain('[Attached file: /repo/README.md]');
  });

  it('adds --resume when resuming a session (supportsResume)', () => {
    const args = buildArgs(opts({ sessionId: 'codex-sess-1' }));
    const i = args.indexOf('--resume');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('codex-sess-1');
  });

  it('maps auto_accept mode to --full-auto but never emits a plan flag', () => {
    expect(buildArgs(opts({ mode: 'auto_accept' }))).toContain('--full-auto');
    // No plan-mode support: a `plan` request degrades to the default (no flag, no throw).
    const planArgs = buildArgs(opts({ mode: 'plan' }));
    expect(planArgs).not.toContain('--full-auto');
    expect(planArgs.join(' ')).not.toContain('plan');
    expect(buildArgs(opts({ mode: 'default' }))).not.toContain('--full-auto');
  });

  it('writes configured MCP servers to .mcp.json and passes --mcp-config', () => {
    const servers: McpServerConfig[] = [
      {
        name: 'my-server',
        command: 'my-cmd',
        args: ['--flag'],
        env: { TOKEN: 'secret' },
      },
    ];
    const args = buildArgs(opts({ mcpConfig: servers }));

    const path = mcpConfigPath(args);
    expect(path).toBeDefined();
    const written = JSON.parse(readFileSync(path!, 'utf8')) as {
      mcpServers: Record<
        string,
        { command: string; args?: string[]; env?: Record<string, string> }
      >;
    };
    expect(written.mcpServers['my-server']).toEqual({
      command: 'my-cmd',
      args: ['--flag'],
      env: { TOKEN: 'secret' },
    });
  });

  it('omits --mcp-config entirely when there are no MCP servers', () => {
    expect(buildArgs(opts())).not.toContain('--mcp-config');
  });
});

// ---------------------------------------------------------------------------
// capabilities — the point the UI degrades on
// ---------------------------------------------------------------------------

describe('CodexHarness — capabilities', () => {
  it('reports resume + MCP, no plan-mode, raw-terminal fallback', async () => {
    const { CodexHarness } = await import('./codex');
    const harness = new CodexHarness();
    expect(harness.id).toBe('codex');
    expect(harness.capabilities()).toEqual({
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: false,
      rawTerminalFallback: true,
    });
  });
});
