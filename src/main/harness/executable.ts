import { accessSync, constants } from 'node:fs';

import { claudeCliPath, codexCliPath } from '../paths';
import { resolveExecutable } from '../process/executable';

export type ManagedHarnessCommand = 'claude' | 'codex';

/** Prefer a system provider CLI, then Harness's verified app-managed installation. */
export function resolveHarnessExecutable(
  command: ManagedHarnessCommand,
): string {
  const system = resolveExecutable(command);
  if (system !== command) return system;

  const managed = command === 'claude' ? claudeCliPath() : codexCliPath();
  try {
    accessSync(managed, constants.X_OK);
    return managed;
  } catch {
    return command;
  }
}
