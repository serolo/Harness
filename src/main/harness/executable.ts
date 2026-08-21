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

  try {
    // Resolving the managed location ultimately consults Electron's app paths.
    // That API is unavailable in headless/ELECTRON_RUN_AS_NODE processes, so keep
    // the same command fallback used when the managed executable is simply absent.
    const managed = command === 'claude' ? claudeCliPath() : codexCliPath();
    accessSync(managed, constants.X_OK);
    return managed;
  } catch {
    return command;
  }
}
