import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  githubCliAsset,
  installGithubCli,
  type GithubCliAsset,
} from './ghInstaller';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-gh-installer-'));
  roots.push(root);
  return root;
}

function assetFor(archive: Buffer): GithubCliAsset {
  return {
    url: 'https://example.test/gh.zip',
    sha256: createHash('sha256').update(archive).digest('hex'),
    archiveRoot: 'gh_test_macOS_arm64',
    archiveType: 'zip',
  };
}

describe('githubCliAsset', () => {
  it('selects pinned assets for every supported platform', () => {
    expect(githubCliAsset('darwin', 'x64').url).toContain('macOS_amd64.zip');
    expect(githubCliAsset('darwin', 'arm64').url).toContain('macOS_arm64.zip');
    expect(githubCliAsset('linux', 'x64')).toMatchObject({
      archiveType: 'tar.gz',
    });
    expect(githubCliAsset('win32', 'x64').url).toContain('windows_amd64.zip');
  });

  it('rejects unsupported platforms', () => {
    expect(() => githubCliAsset('linux', 'arm64')).toThrow(
      /unavailable for linux\/arm64/,
    );
  });
});

describe('installGithubCli', () => {
  it('verifies, extracts, and atomically installs an executable', async () => {
    const root = await tempRoot();
    const archive = Buffer.from('verified archive');
    const asset = assetFor(archive);
    const targetPath = join(root, 'tools', 'bin', 'gh');
    const progress: string[] = [];

    await installGithubCli({
      platform: 'darwin',
      arch: 'arm64',
      asset,
      targetPath,
      tempRoot: root,
      fetchImpl: vi.fn(async () => new Response(archive)) as typeof fetch,
      extract: async (_archivePath, destination) => {
        const bin = join(destination, asset.archiveRoot, 'bin');
        await mkdir(bin, { recursive: true });
        await writeFile(join(bin, 'gh'), '#!/bin/sh\necho gh\n');
      },
      onProgress: (message) => progress.push(message),
    });

    expect(await readFile(targetPath, 'utf8')).toContain('echo gh');
    await expect(access(targetPath, constants.X_OK)).resolves.toBeUndefined();
    expect(progress).toEqual([
      'Downloading GitHub CLI 2.94.0…',
      'Verifying and installing GitHub CLI…',
      'GitHub CLI is ready. Starting sign-in…',
    ]);
  });

  it('rejects a digest mismatch without installing', async () => {
    const root = await tempRoot();
    const targetPath = join(root, 'tools', 'bin', 'gh');
    const extract = vi.fn(async () => undefined);

    await expect(
      installGithubCli({
        platform: 'darwin',
        arch: 'arm64',
        asset: { ...assetFor(Buffer.from('expected')), sha256: '0'.repeat(64) },
        targetPath,
        tempRoot: root,
        fetchImpl: vi.fn(
          async () => new Response(Buffer.from('downloaded')),
        ) as typeof fetch,
        extract,
      }),
    ).rejects.toMatchObject({ code: 'integration' });

    expect(extract).not.toHaveBeenCalled();
    await expect(access(targetPath)).rejects.toBeDefined();
  });
});
