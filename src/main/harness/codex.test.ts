// Contract tests for the Codex harness adapter (plan Task 1). Proves the two
// load-bearing properties NOW: the Codex normalization table (each fixture → the
// expected AgentEvent[] + captured session id) and the `buildArgs` argv shape (the
// command-injection / MCP-passthrough surface). No real `codex` process is spawned.
//
// IMPORTANT — CLI-drift tripwire: the fixtures under ./fixtures/codex are HAND-AUTHORED
// samples of an ASSUMED `codex` JSON event stream (~v0.x). They MUST be re-recorded
// against a real CLI to become a true drift detector; until then they only prove the
// mapping logic, not fidelity to the current CLI output.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { describe, it, expect } from 'vitest';

import type {
  AgentEvent,
  McpServerConfig,
  StartTurnOpts,
} from '@shared/harness';
import { createJsonLineSplitter } from './parser';
import {
  buildArgs,
  normalizeCodex,
  prepareCodexMcpConfig,
  parseCodexCliMetadata,
  parseCodexAuthMethod,
  resolveCodexAuthMethod,
} from './codex';

describe('Codex adapter — authentication status', () => {
  it('distinguishes ChatGPT and API-key login', () => {
    expect(parseCodexAuthMethod('Logged in using ChatGPT')).toBe('cli');
    expect(parseCodexAuthMethod('Logged in using an API key')).toBe('api_key');
    expect(parseCodexAuthMethod('Not logged in')).toBe('none');
  });

  it('prefers an environment API key over ChatGPT login status', () => {
    expect(resolveCodexAuthMethod('Logged in using ChatGPT', true)).toBe(
      'api_key',
    );
    expect(resolveCodexAuthMethod('', true, false)).toBe('api_key');
    expect(resolveCodexAuthMethod('', false, false)).toBe('none');
  });

  it('detects CLI login from stderr and falls back to a successful status exit', () => {
    expect(
      resolveCodexAuthMethod(
        'WARNING: PATH aliases unavailable\nLogged in using ChatGPT',
        false,
        true,
      ),
    ).toBe('cli');
    expect(resolveCodexAuthMethod('', false, true)).toBe('cli');
  });

  it('reads non-secret account and plan metadata from the local ID token', () => {
    const payload = Buffer.from(
      JSON.stringify({
        email: 'person@example.com',
        'https://api.openai.com/auth.chatgpt_plan_type': 'plus',
      }),
    ).toString('base64url');
    const metadata = parseCodexCliMetadata(
      JSON.stringify({ tokens: { id_token: `header.${payload}.signature` } }),
    );

    expect(metadata).toEqual({
      providerLabel: 'openai',
      planLabel: 'Plus',
      authLabel: 'ChatGPT login',
      accountLabel: 'person@example.com',
    });
  });
});

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
  it('maps the current exec --json thread, message, and turn protocol', () => {
    const { events, sessionIds } = run(
      [
        '{"type":"thread.started","thread_id":"thread-current-1"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}',
        '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":4,"output_tokens":5}}',
      ].join('\n'),
    );
    expect(sessionIds).toEqual(['thread-current-1']);
    expect(events).toEqual([
      { kind: 'text', delta: 'hello' },
      {
        kind: 'turn_end',
        usage: {
          inputTokens: 12,
          cachedInputTokens: 4,
          outputTokens: 5,
        },
      },
    ]);
  });

  it('maps current item.started events to live activity', () => {
    expect(
      normalizeCodex({
        type: 'item.started',
        item: { id: 'item_0', type: 'agent_message' },
      }),
    ).toEqual([
      { type: 'event', event: { kind: 'activity', title: 'Responding' } },
    ]);

    expect(
      normalizeCodex({
        type: 'item.started',
        item: { id: 'item_1', type: 'web_search', query: 'Harness' },
      }),
    ).toEqual([
      { type: 'event', event: { kind: 'activity', title: 'Web search' } },
    ]);
  });

  it('maps app-server questions and approvals to distinct interactions', () => {
    expect(
      normalizeCodex({
        method: 'item/tool/requestUserInput',
        id: 41,
        params: {
          questions: [
            {
              id: 'style',
              header: 'Style',
              question: 'Which style should I use?',
              options: [{ label: 'Compact', description: 'Less detail' }],
            },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'event',
        event: {
          kind: 'question_request',
          requestId: '41',
          questions: [
            {
              id: 'style',
              header: 'Style',
              question: 'Which style should I use?',
              multiSelect: undefined,
              options: [{ label: 'Compact', description: 'Less detail' }],
            },
          ],
        },
      },
    ]);

    expect(
      normalizeCodex({
        method: 'item/commandExecution/requestApproval',
        id: 42,
        params: { command: 'npm publish', reason: 'Writes to the registry' },
      }),
    ).toEqual([
      {
        type: 'event',
        event: {
          kind: 'permission_request',
          requestId: '42',
          title: undefined,
          description: 'Writes to the registry',
          toolName: 'command_execution',
          input: { command: 'npm publish', reason: 'Writes to the registry' },
        },
      },
    ]);
  });

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

/** Collect the values supplied through Codex's native `-c key=value` overrides. */
function configOverrides(args: string[]): string[] {
  return args.flatMap((arg, index) =>
    arg === '-c' && args[index + 1] !== undefined ? [args[index + 1]!] : [],
  );
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

  it('uses the exec resume subcommand when resuming a session', () => {
    const args = buildArgs(opts({ sessionId: 'codex-sess-1' }));
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(args.slice(-3)).toEqual(['--', 'codex-sess-1', 'do the thing']);
  });

  it('does not pretend app plan mode is a Codex CLI capability', () => {
    for (const mode of ['default', 'plan', 'auto_accept'] as const) {
      const args = buildArgs(opts({ mode }));
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('--sandbox');
      expect(args).not.toContain('--ask-for-approval');
    }
  });

  it('uses provider-native non-interactive read-only args for review roles', () => {
    const args = buildArgs(
      opts({ mode: 'default', readOnlyMode: true, prompt: '--inspect-only' }),
    );

    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).not.toContain('--ask-for-approval');
    expect(configOverrides(args)).toContain('approval_policy="never"');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.slice(-2)).toEqual(['--', '--inspect-only']);
  });

  it('uses workspace-write sandboxing for writable meta children', () => {
    const args = buildArgs(
      opts({ mode: 'default', scopedWriteMode: true, metaRunId: 'run-1' }),
    );

    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('--ask-for-approval');
    expect(configOverrides(args)).toContain('approval_policy="never"');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('passes the selected reasoning effort through a config override', () => {
    const args = buildArgs(opts({ effort: 'xhigh' }));
    const i = args.indexOf('-c');
    expect(args.slice(i, i + 2)).toEqual([
      '-c',
      'model_reasoning_effort="xhigh"',
    ]);
  });

  it('passes MCP servers through Codex-native config overrides', () => {
    const servers: McpServerConfig[] = [
      {
        name: 'my-server',
        command: 'my-cmd',
        args: ['--flag'],
        env: { TOKEN: 'secret' },
      },
    ];
    const prepared = prepareCodexMcpConfig(servers);
    try {
      expect(() => buildArgs(opts({ mcpConfig: servers }))).toThrow(
        'Codex MCP configuration was not prepared',
      );
      const args = buildArgs(opts({ mcpConfig: servers }), prepared.override);
      const override = configOverrides(args).find((value) =>
        value.startsWith('mcp_servers='),
      );
      expect(args).not.toContain('--mcp-config');
      expect(override).toBeDefined();
      expect(override).not.toContain('my-cmd');
      expect(override).not.toContain('secret');

      const parsed = parseToml(override!) as {
        mcp_servers: Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >;
      };
      const proxy = parsed.mcp_servers['my-server'];
      expect(proxy?.command).toBe(process.execPath);
      expect(proxy?.args[0]).toMatch(/mcp-launcher\.js$/);
      expect(proxy?.env.ELECTRON_RUN_AS_NODE).toBe('1');
      const configPath = proxy!.env.HARNESS_MCP_LAUNCH_CONFIG!;
      expect(statSync(configPath).isFile()).toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
      }
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
        command: 'my-cmd',
        args: ['--flag'],
        env: { TOKEN: 'secret' },
      });
      prepared.cleanup();
      expect(existsSync(configPath)).toBe(false);
    } finally {
      prepared.cleanup();
    }
  });

  it('quotes provider configuration so names and values remain inert TOML data', () => {
    const servers: McpServerConfig[] = [
      {
        name: 'server.with spaces',
        command: 'node',
        args: ['$(touch /tmp/nope)', 'line\nbreak'],
        env: { 'TOKEN.NAME': 'a"b\\c' },
      },
    ];
    const prepared = prepareCodexMcpConfig(servers);
    try {
      const args = buildArgs(opts({ mcpConfig: servers }), prepared.override);
      const override = configOverrides(args).find((value) =>
        value.startsWith('mcp_servers='),
      );
      expect(override).toBeDefined();
      expect(override).not.toContain('$(touch /tmp/nope)');
      expect(override).not.toContain('a\\"b');
      expect(parseToml(override!)).toHaveProperty([
        'mcp_servers',
        'server.with spaces',
      ]);
    } finally {
      prepared.cleanup();
    }
  });

  it('omits MCP configuration when there are no MCP servers', () => {
    const prepared = prepareCodexMcpConfig([]);
    const args = buildArgs(opts(), prepared.override);
    expect(args).not.toContain('--mcp-config');
    expect(
      configOverrides(args).some((value) => value.startsWith('mcp_servers=')),
    ).toBe(false);
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
      supportsReadOnlyMode: true,
      supportsReadOnlyMcp: false,
      supportsScopedWriteMode: true,
    });
  });
});
