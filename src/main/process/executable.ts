import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import { childProcessEnv } from './childEnv';

export function resolveExecutable(command: string): string {
  if (command.includes('/') || isAbsolute(command)) {
    assertExecutable(command);
    return command;
  }

  const env = childProcessEnv();
  const path = env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
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
