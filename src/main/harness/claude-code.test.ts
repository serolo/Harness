// MCP passthrough (Phase 6, Track F — verify-only). Proves the `[mcp]` settings that
// flow into `StartTurnOpts.mcpConfig` (register.ts turn:start producer) reach the
// Claude Code adapter as a written `.mcp.json` + a `--mcp-config` flag. Asserts
// against `buildArgs` directly (no real `claude` spawn).

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

import type { AgentEvent, StartTurnOpts } from '@shared/harness';
import type { McpServerConfig } from '@shared/harness';
import type { StreamSink } from '@shared/ipc';
import type {
  RawPtyHandle,
  RawPtySpawner,
  RawPtySpawnOptions,
} from './raw-terminal';
import {
  buildArgs,
  ClaudeCodeHarness,
  parseClaudeAuthDetails,
  parseClaudeAuthStatus,
  parseClaudeCliMetadata,
  resolveClaudeAuthDetails,
} from './claude-code';

describe('Claude Code adapter — authentication status', () => {
  it('accepts only valid logged-in JSON', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true}')).toBe(true);
    expect(parseClaudeAuthStatus('{"loggedIn":false}')).toBe(false);
    expect(parseClaudeAuthStatus('not json')).toBe(false);
  });

  it('distinguishes Claude subscription and Console billing', () => {
    expect(
      parseClaudeAuthDetails(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
        }),
      ),
    ).toEqual({ authenticated: true, authMethod: 'cli' });
    expect(
      parseClaudeAuthDetails(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'console',
          apiProvider: 'firstParty',
        }),
      ),
    ).toEqual({ authenticated: true, authMethod: 'api_key' });
    expect(
      parseClaudeAuthDetails(
        JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      ),
    ).toEqual({ authenticated: false, authMethod: 'none' });
  });

  it('prefers an API credential over account login status', () => {
    expect(
      resolveClaudeAuthDetails(
        JSON.stringify({ loggedIn: false, authMethod: 'none' }),
        true,
      ),
    ).toEqual({ authenticated: true, authMethod: 'api_key' });
    expect(
      resolveClaudeAuthDetails(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
        }),
        true,
      ),
    ).toEqual({ authenticated: true, authMethod: 'api_key' });
  });

  it('reads non-secret Claude account and plan metadata', () => {
    expect(
      parseClaudeCliMetadata(
        JSON.stringify({
          oauthAccount: {
            emailAddress: 'person@example.com',
            organizationRateLimitTier: 'default_claude_max_20x',
          },
        }),
      ),
    ).toEqual({
      providerLabel: 'anthropic',
      planLabel: 'Max',
      authLabel: 'Claude login',
      accountLabel: 'person@example.com',
    });
  });
});

/** Minimal valid StartTurnOpts with the given MCP servers. */
function opts(
  mcpConfig: McpServerConfig[],
  overrides: Partial<StartTurnOpts> = {},
): StartTurnOpts {
  return {
    workspaceDir: '/tmp/ws',
    prompt: 'do the thing',
    attachments: [],
    mcpConfig,
    permissionPolicy: {},
    ...overrides,
  };
}

/** Read the `--mcp-config <path>` value out of an argv, or undefined if absent. */
function mcpConfigPath(args: string[]): string | undefined {
  const i = args.indexOf('--mcp-config');
  return i >= 0 ? args[i + 1] : undefined;
}

function recordingSink(): {
  sink: StreamSink<AgentEvent>;
  events: AgentEvent[];
  endCount: () => number;
} {
  const events: AgentEvent[] = [];
  let ends = 0;
  return {
    events,
    endCount: () => ends,
    sink: {
      push: (e) => events.push(e),
      end: () => {
        ends += 1;
      },
      error: () => {
        ends += 1;
      },
    },
  };
}

function fakeSpawner(): {
  spawner: RawPtySpawner;
  emit: (chunk: string) => void;
  exit: (code: number) => void;
  spawnOptions: () => RawPtySpawnOptions | undefined;
} {
  let dataCb: ((chunk: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  let seen: RawPtySpawnOptions | undefined;

  const handle: RawPtyHandle = {
    ptyId: 'pty-1',
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: () => exitCb?.({ exitCode: 0 }),
  };

  return {
    spawner: {
      spawn: (options) => {
        seen = options;
        return Promise.resolve(handle);
      },
    },
    emit: (chunk) => dataCb?.(chunk),
    exit: (code) => exitCb?.({ exitCode: code }),
    spawnOptions: () => seen,
  };
}

function appendCapturedStdout(
  fake: {
    spawnOptions: () => RawPtySpawnOptions | undefined;
  },
  chunk: string,
): void {
  const stdout = fake.spawnOptions()?.env?.['HARNESS_AGENT_STDOUT'];
  if (stdout === undefined) {
    throw new Error('missing HARNESS_AGENT_STDOUT');
  }
  writeFileSync(stdout, chunk, { flag: 'a' });
}

describe('Claude Code adapter — MCP passthrough (settings → .mcp.json)', () => {
  it('uses native read-only planning mode and keeps other modes non-blocking', () => {
    const planArgs = buildArgs(opts([], { mode: 'plan' }));
    expect(planArgs).toContain('--permission-mode');
    expect(planArgs).toContain('plan');
    expect(planArgs).not.toContain('--dangerously-skip-permissions');

    for (const mode of ['default', 'auto_accept'] as const) {
      const args = buildArgs(opts([], { mode }));
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--permission-mode');
    }
  });

  it('writes the configured servers to .mcp.json and passes --mcp-config', () => {
    const servers: McpServerConfig[] = [
      {
        name: 'my-server',
        command: 'my-cmd',
        args: ['--flag'],
        env: { TOKEN: 'secret' },
      },
    ];
    const args = buildArgs(opts(servers));

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
    const args = buildArgs(opts([]));
    expect(args).not.toContain('--mcp-config');
  });
});

describe('Claude Code adapter — model threading (Phase 12)', () => {
  it('emits ["--model", value] as two discrete argv elements', () => {
    const args = buildArgs({ ...opts([]), model: 'sonnet' });
    const i = args.indexOf('--model');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('sonnet');
  });

  it('omits --model entirely when opts.model is undefined', () => {
    const args = buildArgs(opts([]));
    expect(args).not.toContain('--model');
  });

  it('passes the selected reasoning effort as discrete argv', () => {
    const args = buildArgs({ ...opts([]), effort: 'high' });
    const i = args.indexOf('--effort');
    expect(args.slice(i, i + 2)).toEqual(['--effort', 'high']);
  });

  it('keeps a hostile model string a SINGLE inert argv element (never shell)', () => {
    // Even a string full of shell metacharacters is passed as ONE argument under
    // spawn(shell:false); it is never split or interpreted. (The IPC boundary rejects
    // such a string via MODEL_PATTERN before it reaches here — this is defense in depth.)
    const hostile = 'sonnet; rm -rf / #$(whoami)';
    const args = buildArgs({ ...opts([]), model: hostile });
    const i = args.indexOf('--model');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(hostile);
    // No other argv element contains a fragment of the injected payload.
    const others = args.filter((_, idx) => idx !== i + 1);
    expect(others.some((a) => a.includes('rm -rf'))).toBe(false);
  });
});

describe('Claude Code adapter — PTY JSON stream fallback', () => {
  it('runs Claude through the injected PTY spawner and parses stream-json output', async () => {
    const fake = fakeSpawner();
    const harness = new ClaudeCodeHarness(fake.spawner);
    const rec = recordingSink();

    const handlePromise = harness.startTurn(opts([]), rec.sink);
    await Promise.resolve();

    expect(fake.spawnOptions()?.shell).toBe('/bin/zsh');
    expect(
      fake.spawnOptions()?.args?.some((arg) => arg.includes('claude')),
    ).toBe(true);
    expect(fake.spawnOptions()?.args).toContain('--output-format');

    appendCapturedStdout(
      fake,
      '{"type":"system","subtype":"init","session_id":"sess-pty-1"}\r\n',
    );
    const handle = await handlePromise;
    expect(handle.sessionId).toBe('sess-pty-1');

    appendCapturedStdout(
      fake,
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"session_id":"sess-pty-1"}\r\n',
    );
    appendCapturedStdout(
      fake,
      '{"type":"result","subtype":"success","session_id":"sess-pty-1","usage":{"input_tokens":1,"output_tokens":2},"is_error":false}\r\n',
    );
    fake.exit(0);

    expect(rec.events).toEqual([
      { kind: 'text', delta: 'hello' },
      { kind: 'turn_end', usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
    expect(rec.endCount()).toBe(1);
  });

  it('renders result.result as text when Claude emits only a final result', async () => {
    const fake = fakeSpawner();
    const harness = new ClaudeCodeHarness(fake.spawner);
    const rec = recordingSink();

    const handlePromise = harness.startTurn(opts([]), rec.sink);
    await Promise.resolve();

    appendCapturedStdout(
      fake,
      '{"type":"system","subtype":"init","session_id":"sess-result-only"}\r\n',
    );
    await handlePromise;
    appendCapturedStdout(
      fake,
      '{"type":"result","subtype":"success","result":"final answer","session_id":"sess-result-only","is_error":false}\r\n',
    );
    fake.exit(0);

    expect(rec.events).toEqual([
      { kind: 'text', delta: 'final answer' },
      { kind: 'turn_end' },
    ]);
  });

  it('does not duplicate result.result when assistant text already streamed', async () => {
    const fake = fakeSpawner();
    const harness = new ClaudeCodeHarness(fake.spawner);
    const rec = recordingSink();

    const handlePromise = harness.startTurn(opts([]), rec.sink);
    await Promise.resolve();

    appendCapturedStdout(
      fake,
      '{"type":"system","subtype":"init","session_id":"sess-with-text"}\r\n',
    );
    await handlePromise;
    appendCapturedStdout(
      fake,
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"streamed"}]},"session_id":"sess-with-text"}\r\n',
    );
    appendCapturedStdout(
      fake,
      '{"type":"result","subtype":"success","result":"streamed","session_id":"sess-with-text","is_error":false}\r\n',
    );
    fake.exit(0);

    expect(rec.events).toEqual([
      { kind: 'text', delta: 'streamed' },
      { kind: 'turn_end' },
    ]);
  });
});
