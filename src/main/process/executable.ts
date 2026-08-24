import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { childProcessEnv } from './childEnv';

interface ResolveExecutableOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string>;
  homeDirectory?: string;
}

export function executableCandidates(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32' || /\.[A-Za-z0-9]+$/.test(command)) return [command];
  return [`${command}.exe`, command];
}

export function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): string {
  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    assertExecutable(command);
    return command;
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? childProcessEnv();
  const pathValue =
    env.PATH ?? (platform === 'win32' ? (env.Path ?? env.path ?? '') : '');
  const pathDirs = pathValue.split(platform === 'win32' ? ';' : ':');
  // Apps launched from Finder inherit launchd's minimal PATH rather than the PATH
  // configured by the user's interactive shell. Claude's native installer uses
  // ~/.local/bin, so a packaged app must check that location explicitly. The two
  // system locations cover the common Homebrew/npm installs without invoking a
  // shell or sourcing user-controlled startup files.
  const fallbackDirs =
    platform === 'darwin'
      ? [
          join(options.homeDirectory ?? homedir(), '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ]
      : [join(options.homeDirectory ?? homedir(), '.local', 'bin')];

  for (const dir of [...pathDirs, ...fallbackDirs]) {
    if (dir === '') continue;
    for (const name of executableCandidates(command, platform)) {
      const candidate = join(dir, name);
      try {
        assertExecutable(candidate);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }

  return command;
}

function assertExecutable(path: string): void {
  accessSync(path, constants.X_OK);
}
