// Cross-platform PTY transport. The Electron executable runs this entry as Node and
// it launches the real command without a shell, preserving argument boundaries while
// capturing stdout/stderr separately for structured agent and git parsers.

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

interface LaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

function stringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function validConfig(value: unknown): value is LaunchConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.command === 'string' &&
    row.command !== '' &&
    Array.isArray(row.args) &&
    row.args.every((entry) => typeof entry === 'string') &&
    stringRecord(row.env) &&
    typeof row.stdoutPath === 'string' &&
    row.stdoutPath !== '' &&
    typeof row.stderrPath === 'string' &&
    row.stderrPath !== ''
  );
}

async function main(): Promise<void> {
  const configPath = process.env.HARNESS_PTY_COMMAND_CONFIG;
  if (!configPath) throw new Error('Missing PTY command configuration.');
  const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  if (!validConfig(parsed))
    throw new Error('Invalid PTY command configuration.');

  const inherited = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'HARNESS_PTY_COMMAND_CONFIG',
    'HARNESS_AGENT_STDOUT',
    'HARNESS_AGENT_STDERR',
  ]) {
    delete inherited[key];
  }

  const stdout = openSync(parsed.stdoutPath, 'a');
  const stderr = openSync(parsed.stderrPath, 'a');
  const child = spawn(parsed.command, parsed.args, {
    env: { ...inherited, ...parsed.env },
    shell: false,
    stdio: ['inherit', stdout, stderr],
    windowsHide: true,
  });
  const closeCaptures = (): void => {
    try {
      closeSync(stdout);
    } catch {
      // Already closed during another terminal path.
    }
    try {
      closeSync(stderr);
    } catch {
      // Already closed during another terminal path.
    }
  };
  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  child.once('error', () => {
    closeCaptures();
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    closeCaptures();
    process.exitCode = code ?? 1;
  });
}

void main().catch(() => {
  process.exitCode = 1;
});
