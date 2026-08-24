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
  codexCliAsset,
  installCodexCli,
  type CodexCliAsset,
} from './codexInstaller';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-codex-installer-'));
  roots.push(root);
  return root;
}

function assetFor(archive: Buffer): CodexCliAsset {
  return {
    url: 'https://example.test/codex.tgz',
    sha512: createHash('sha512').update(archive).digest('base64'),
    targetTriple: 'aarch64-apple-darwin',
  };
}

describe('codexCliAsset', () => {
  it('selects pinned packages for every supported platform', () => {
    expect(codexCliAsset('darwin', 'x64')).toMatchObject({
      targetTriple: 'x86_64-apple-darwin',
    });
    expect(codexCliAsset('darwin', 'arm64')).toMatchObject({
      targetTriple: 'aarch64-apple-darwin',
    });
    expect(codexCliAsset('linux', 'x64')).toMatchObject({
      targetTriple: 'x86_64-unknown-linux-musl',
    });
    expect(codexCliAsset('win32', 'x64')).toMatchObject({
      targetTriple: 'x86_64-pc-windows-msvc',
    });
  });

  it('rejects unsupported platforms', () => {
    expect(() => codexCliAsset('linux', 'arm64')).toThrow(
      /unavailable for linux\/arm64/,
    );
  });
});

describe('installCodexCli', () => {
  it('verifies and installs the complete vendor resource layout', async () => {
    const root = await tempRoot();
    const archive = Buffer.from('verified archive');
    const asset = assetFor(archive);
    const targetDir = join(root, 'tools', 'codex', 'current');
    const progress: string[] = [];

    const installed = await installCodexCli({
      platform: 'darwin',
      arch: 'arm64',
      asset,
      targetDir,
      tempRoot: root,
      fetchImpl: vi.fn(async () => new Response(archive)) as typeof fetch,
      extract: async (_archivePath, destination) => {
        const bin = join(
          destination,
          'package',
          'vendor',
          asset.targetTriple,
          'bin',
        );
        await mkdir(bin, { recursive: true });
        await writeFile(join(bin, 'codex'), '#!/bin/sh\necho codex\n');
        await writeFile(join(bin, 'rg'), 'companion resource');
      },
      onProgress: (message) => progress.push(message),
    });

    expect(await readFile(installed, 'utf8')).toContain('echo codex');
    await expect(access(installed, constants.X_OK)).resolves.toBeUndefined();
    expect(
      await readFile(
        join(targetDir, 'package', 'vendor', asset.targetTriple, 'bin', 'rg'),
        'utf8',
      ),
    ).toBe('companion resource');
    expect(progress).toEqual([
      'Downloading Codex 0.145.0…',
      'Installing Codex…',
      'Codex is ready. Starting sign-in…',
    ]);
  });

  it('rejects a digest mismatch before extraction', async () => {
    const root = await tempRoot();
    const targetDir = join(root, 'tools', 'codex', 'current');
    const extract = vi.fn(async () => undefined);

    await expect(
      installCodexCli({
        platform: 'darwin',
        arch: 'arm64',
        asset: {
          ...assetFor(Buffer.from('expected')),
          sha512: Buffer.alloc(64).toString('base64'),
        },
        targetDir,
        tempRoot: root,
        fetchImpl: vi.fn(
          async () => new Response(Buffer.from('downloaded')),
        ) as typeof fetch,
        extract,
      }),
    ).rejects.toMatchObject({ code: 'integration' });

    expect(extract).not.toHaveBeenCalled();
    await expect(access(targetDir)).rejects.toBeDefined();
  });
});
