import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { childProcessEnv } from './childEnv';

export function resolveExecutable(command: string): string {
  if (command.includes('/') || isAbsolute(command)) {
    assertExecutable(command);
    return command;
  }

  const env = childProcessEnv();
  const pathDirs = (env.PATH ?? '').split(delimiter);
  // Apps launched from Finder inherit launchd's minimal PATH rather than the PATH
  // configured by the user's interactive shell. Claude's native installer uses
  // ~/.local/bin, so a packaged app must check that location explicitly. The two
  // system locations cover the common Homebrew/npm installs without invoking a
  // shell or sourcing user-controlled startup files.
  const fallbackDirs =
    process.platform === 'darwin'
      ? [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
      : [join(homedir(), '.local', 'bin')];

  for (const dir of [...pathDirs, ...fallbackDirs]) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    try {
      assertExecutable(candidate);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }

  return command;
}

function assertExecutable(path: string): void {
  accessSync(path, constants.X_OK);
}
