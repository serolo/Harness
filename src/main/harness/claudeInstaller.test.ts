import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  claudeCliAsset,
  installClaudeCli,
  type ClaudeCliAsset,
} from './claudeInstaller';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-claude-installer-'));
  roots.push(root);
  return root;
}

function assetFor(archive: Buffer): ClaudeCliAsset {
  return {
    url: 'https://example.test/claude.tgz',
    sha512: createHash('sha512').update(archive).digest('base64'),
    binaryName: 'claude',
  };
}

describe('claudeCliAsset', () => {
  it('selects pinned native packages for every supported platform', () => {
    expect(claudeCliAsset('darwin', 'x64').url).toContain('darwin-x64');
    expect(claudeCliAsset('darwin', 'arm64').url).toContain('darwin-arm64');
    expect(claudeCliAsset('linux', 'x64').binaryName).toBe('claude');
    expect(claudeCliAsset('win32', 'x64').binaryName).toBe('claude.exe');
  });

  it('rejects unsupported platforms', () => {
    expect(() => claudeCliAsset('linux', 'arm64')).toThrow(
      /unavailable for linux\/arm64/,
    );
  });
});

describe('installClaudeCli', () => {
  it('verifies and atomically installs an executable', async () => {
    const root = await tempRoot();
    const archive = Buffer.from('verified archive');
    const targetPath = join(root, 'tools', 'bin', 'claude');
    const progress: string[] = [];

    await installClaudeCli({
      platform: 'darwin',
      arch: 'arm64',
      asset: assetFor(archive),
      targetPath,
      tempRoot: root,
      fetchImpl: vi.fn(async () => new Response(archive)) as typeof fetch,
      extract: async (_archivePath, destination) => {
        await mkdir(join(destination, 'package'), { recursive: true });
        await writeFile(
          join(destination, 'package', 'claude'),
          '#!/bin/sh\necho claude\n',
        );
      },
      onProgress: (message) => progress.push(message),
    });

    expect(await readFile(targetPath, 'utf8')).toContain('echo claude');
    await expect(access(targetPath, constants.X_OK)).resolves.toBeUndefined();
    expect(progress).toEqual([
      'Downloading Claude Code 2.1.220…',
      'Installing Claude Code…',
      'Claude Code is ready. Starting sign-in…',
    ]);
  });

  it('rejects a digest mismatch without installing', async () => {
    const root = await tempRoot();
    const targetPath = join(root, 'tools', 'bin', 'claude');

    await expect(
      installClaudeCli({
        platform: 'darwin',
        arch: 'arm64',
        asset: {
          ...assetFor(Buffer.from('expected')),
          sha512: Buffer.alloc(64).toString('base64'),
        },
        targetPath,
        tempRoot: root,
        fetchImpl: vi.fn(
          async () => new Response(Buffer.from('downloaded')),
        ) as typeof fetch,
        extract: vi.fn(async () => undefined),
      }),
    ).rejects.toMatchObject({ code: 'integration' });

    await expect(access(targetPath)).rejects.toBeDefined();
  });
});
