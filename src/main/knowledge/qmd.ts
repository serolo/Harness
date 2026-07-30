import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { projectDir } from '../paths';
import { resolveExecutable } from '../process/executable';
import { childProcessEnv } from '../process/childEnv';
import type { QmdStatus } from '@shared/knowledge';
import { AppError } from '@shared/errors';

const execFileAsync = promisify(execFile);

export interface QmdCommandResult {
  stdout: string;
  stderr: string;
}

export type QmdRunner = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<QmdCommandResult>;

export interface QmdResult {
  path: string;
  title?: string;
  snippet?: string;
  score?: number;
}

interface QmdJsonResult {
  file?: unknown;
  path?: unknown;
  title?: unknown;
  snippet?: unknown;
  context?: unknown;
  score?: unknown;
}

const defaultRunner: QmdRunner = async (args, env) => {
  const result = await execFileAsync(resolveExecutable('qmd'), args, {
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 5 * 60_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export async function qmdStatus(): Promise<QmdStatus> {
  try {
    const result = await execFileAsync(
      resolveExecutable('qmd'),
      ['--version'],
      {
        env: childProcessEnv({ NO_COLOR: '1' }),
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    const version = result.stdout.trim() || result.stderr.trim();
    return { installed: true, ...(version === '' ? {} : { version }) };
  } catch {
    return { installed: false };
  }
}

export async function installQmd(): Promise<QmdStatus> {
  try {
    await execFileAsync(
      resolveExecutable('npm'),
      ['install', '--global', '@tobilu/qmd'],
      {
        env: childProcessEnv({ NO_COLOR: '1' }),
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10 * 60_000,
      },
    );
  } catch (error) {
    throw new AppError(
      'integration',
      `QMD installation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const status = await qmdStatus();
  if (!status.installed) {
    throw new AppError(
      'integration',
      'QMD was installed but its executable is not available on PATH',
    );
  }
  return status;
}

function collectionName(projectId: string): string {
  return `harness-${projectId}`;
}

function resultPath(raw: string, collection: string): string {
  const prefix = `qmd://${collection}/`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

export class QmdSearchProvider {
  private readonly indexedCommits = new Map<string, string>();

  constructor(private readonly run: QmdRunner = defaultRunner) {}

  async search(options: {
    projectId: string;
    root: string;
    commit: string;
    query: string;
    limit: number;
    rerank: boolean;
  }): Promise<QmdResult[]> {
    const collection = collectionName(options.projectId);
    const configHome = join(projectDir(options.projectId), 'qmd-config');
    const cacheHome = join(projectDir(options.projectId), 'qmd-cache');
    await Promise.all([
      mkdir(configHome, { recursive: true }),
      mkdir(cacheHome, { recursive: true }),
    ]);
    const env: NodeJS.ProcessEnv = {
      ...childProcessEnv(),
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: cacheHome,
      NO_COLOR: '1',
    };

    if (this.indexedCommits.get(options.projectId) !== options.commit) {
      try {
        await this.run(['collection', 'show', collection], env);
      } catch {
        await this.run(
          [
            'collection',
            'add',
            options.root,
            '--name',
            collection,
            '--mask',
            '**/*.md',
          ],
          env,
        );
      }
      await this.run(['update'], env);
      await this.run(['embed', '-c', collection], env);
      this.indexedCommits.set(options.projectId, options.commit);
    }

    const args = [
      'query',
      options.query,
      '--json',
      '-n',
      String(options.limit),
      '-c',
      collection,
    ];
    if (!options.rerank) args.push('--no-rerank');
    const { stdout } = await this.run(args, env);
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      throw new Error('QMD returned an invalid JSON result');
    }
    return parsed.flatMap((item): QmdResult[] => {
      if (item === null || typeof item !== 'object') return [];
      const result = item as QmdJsonResult;
      const rawPath =
        typeof result.file === 'string'
          ? result.file
          : typeof result.path === 'string'
            ? result.path
            : undefined;
      if (rawPath === undefined) return [];
      return [
        {
          path: resultPath(rawPath, collection),
          title: typeof result.title === 'string' ? result.title : undefined,
          snippet:
            typeof result.snippet === 'string'
              ? result.snippet
              : typeof result.context === 'string'
                ? result.context
                : undefined,
          score: typeof result.score === 'number' ? result.score : undefined,
        },
      ];
    });
  }
}
