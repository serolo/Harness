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
function opts(mcpConfig: McpServerConfig[]): StartTurnOpts {
  return {
    workspaceDir: '/tmp/ws',
    prompt: 'do the thing',
    attachments: [],
    mcpConfig,
    permissionPolicy: {},
  };
}

/** Read the `--mcp-config <path>` value out of an argv, or undefined if absent. */
function mcpConfigPath(args: string[]): string | undefined {
  const i = args.indexOf('--mcp-config');
  return i >= 0 ? args[i + 1] : undefined;
}

describe('Claude Code adapter — MCP passthrough (settings → .mcp.json)', () => {
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
