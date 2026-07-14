// MCP passthrough (Phase 6, Track F — verify-only). Proves the `[mcp]` settings that
// flow into `StartTurnOpts.mcpConfig` (register.ts turn:start producer) reach the
// Claude Code adapter as a written `.mcp.json` + a `--mcp-config` flag. Asserts
// against `buildArgs` directly (no real `claude` spawn).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import type { StartTurnOpts } from '@shared/harness';
import type { McpServerConfig } from '@shared/harness';
import { buildArgs } from './claude-code';

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

describe('Claude Code adapter — MCP passthrough (settings → .mcp.json)', () => {
  it('always bypasses permission prompts in every app mode', () => {
    for (const mode of ['default', 'plan', 'auto_accept'] as const) {
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
