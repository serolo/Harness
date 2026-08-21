// Private stdio launcher for provider CLIs that cannot load an ephemeral MCP config
// file directly. The parent passes only a 0600 config-file path; command arguments and
// environment values never appear in the provider process argv.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

interface LaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isLaunchConfig(value: unknown): value is LaunchConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.command === 'string' &&
    row.command !== '' &&
    Array.isArray(row.args) &&
    row.args.every((entry) => typeof entry === 'string') &&
    isStringRecord(row.env)
  );
}

async function main(): Promise<void> {
  const configPath = process.env.HARNESS_MCP_LAUNCH_CONFIG;
  if (!configPath) throw new Error('Missing MCP launch configuration.');
  const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  if (!isLaunchConfig(parsed))
    throw new Error('Invalid MCP launch configuration.');

  const inherited = { ...process.env };
  // These variables bootstrap this Electron-as-Node launcher only. Do not leak them
  // into arbitrary configured servers unless that server explicitly requested one.
  delete inherited.ELECTRON_RUN_AS_NODE;
  delete inherited.HARNESS_MCP_LAUNCH_CONFIG;
  const child = spawn(parsed.command, parsed.args, {
    env: { ...inherited, ...parsed.env },
    shell: false,
    stdio: 'inherit',
  });
  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  child.once('error', () => {
    process.stderr.write('MCP server failed to start.\n');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

void main().catch(() => {
  process.stderr.write('MCP launcher failed.\n');
  process.exitCode = 1;
});
