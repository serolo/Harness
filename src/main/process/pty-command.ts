import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { childProcessEnv } from './childEnv';

export interface PtyCommandLaunch {
  shell: string;
  args: string[];
  env: Record<string, string>;
  configPath: string;
}

interface PtyCommandOptions {
  privateDirectory: string;
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  launcherPath?: string;
  runtimePath?: string;
}

/**
 * Prepare a private, shell-free PTY launch. Provider arguments can contain prompts and
 * secrets, so only the 0600 config path is exposed to the PTY process command line.
 */
export async function preparePtyCommand(
  options: PtyCommandOptions,
): Promise<PtyCommandLaunch> {
  const configPath = join(options.privateDirectory, 'launch.json');
  await writeFile(
    configPath,
    `${JSON.stringify({
      command: options.command,
      args: [...options.args],
      env: options.env ?? {},
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
    })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );

  return {
    shell: options.runtimePath ?? process.execPath,
    args: [options.launcherPath ?? join(__dirname, 'pty-command-launcher.js')],
    env: {
      ...childProcessEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      HARNESS_PTY_COMMAND_CONFIG: configPath,
      // Kept visible to the parent adapter so it can tail the capture files.
      HARNESS_AGENT_STDOUT: options.stdoutPath,
      HARNESS_AGENT_STDERR: options.stderrPath,
    },
    configPath,
  };
}
