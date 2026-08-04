// GitHub CLI auth bridge. Used by Settings > Git to import an already-authenticated
// `gh` session without ever exposing the token to the renderer.

import { execa } from 'execa';
import { accessSync, constants } from 'node:fs';

import { AppError } from '../../error';
import { githubCliPath } from '../../paths';
import { resolveExecutable } from '../../process/executable';
import type { GithubCliAuthStatus } from '@shared/github';

/** Prefer a system `gh`, then the verified app-managed onboarding installation. */
export function githubCliExecutable(): string {
  const system = resolveExecutable('gh');
  if (system !== 'gh') return system;

  const managed = githubCliPath();
  try {
    accessSync(managed, constants.X_OK);
    return managed;
  } catch {
    return 'gh';
  }
}

/** Inspect local `gh auth status` for github.com. Token-free. */
export async function githubCliAuthStatus(): Promise<GithubCliAuthStatus> {
  try {
    const result = await execa(
      githubCliExecutable(),
      ['auth', 'status', '--hostname', 'github.com'],
      {
        reject: false,
        timeout: 10_000,
      },
    );
    // Execa resolves spawn failures when `reject: false`; ENOENT therefore arrives
    // as a failed result rather than entering the catch block.
    if (isNotFound(result)) {
      return {
        available: false,
        authenticated: false,
        message: 'GitHub CLI is not installed.',
      };
    }
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      return {
        available: true,
        authenticated: false,
        login: parseLogin(output),
        message: firstLine(output) ?? 'GitHub CLI is not authenticated.',
      };
    }
    return {
      available: true,
      authenticated: true,
      login: parseLogin(output),
      message: firstLine(output),
    };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        available: false,
        authenticated: false,
        message: 'GitHub CLI is not installed.',
      };
    }
    return {
      available: true,
      authenticated: false,
      message: err instanceof Error ? err.message : 'GitHub CLI auth failed.',
    };
  }
}

/** Remove the configured github.com account from the local GitHub CLI. */
export async function githubCliLogout(): Promise<void> {
  const status = await githubCliAuthStatus();
  if (!status.available || status.login === undefined) return;

  try {
    const result = await execa(
      githubCliExecutable(),
      ['auth', 'logout', '--hostname', 'github.com', '--user', status.login],
      { reject: false, timeout: 10_000 },
    );
    if (isNotFound(result)) return;
    if (result.exitCode !== 0) {
      throw new AppError('integration', 'GitHub CLI logout failed');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isNotFound(err)) return;
    throw new AppError('integration', 'GitHub CLI logout failed');
  }
}

/** Read the local `gh auth token`. The returned token must stay in main. */
export async function githubCliToken(): Promise<string> {
  try {
    const result = await execa(
      githubCliExecutable(),
      ['auth', 'token', '--hostname', 'github.com'],
      {
        timeout: 10_000,
      },
    );
    const token = result.stdout.trim();
    if (token === '') {
      throw new AppError('integration', 'GitHub CLI returned an empty token');
    }
    return token;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isNotFound(err)) {
      throw new AppError('integration', 'GitHub CLI is not installed');
    }
    throw new AppError('integration', 'GitHub CLI is not authenticated');
  }
}

function firstLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
}

function parseLogin(output: string): string | undefined {
  const match = /account\s+([^\s]+)/i.exec(output);
  return match?.[1];
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
