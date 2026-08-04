import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
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

function assetFor(binary: Buffer): ClaudeCliAsset {
  return {
    url: 'https://example.test/claude',
    sha256: createHash('sha256').update(binary).digest('hex'),
  };
}

describe('claudeCliAsset', () => {
  it('selects pinned Intel and Apple Silicon native binaries', () => {
    expect(claudeCliAsset('darwin', 'x64').url).toContain('/darwin-x64/');
    expect(claudeCliAsset('darwin', 'arm64').url).toContain('/darwin-arm64/');
  });

  it('rejects unsupported platforms', () => {
    expect(() => claudeCliAsset('win32', 'x64')).toThrow(
      /unavailable for win32\/x64/,
    );
  });
});

describe('installClaudeCli', () => {
  it('verifies and atomically installs an executable', async () => {
    const root = await tempRoot();
    const binary = Buffer.from('#!/bin/sh\necho claude\n');
    const targetPath = join(root, 'tools', 'bin', 'claude');
    const progress: string[] = [];

    await installClaudeCli({
      platform: 'darwin',
      arch: 'arm64',
      asset: assetFor(binary),
      targetPath,
      tempRoot: root,
      fetchImpl: vi.fn(async () => new Response(binary)) as typeof fetch,
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
          sha256: '0'.repeat(64),
        },
        targetPath,
        tempRoot: root,
        fetchImpl: vi.fn(
          async () => new Response(Buffer.from('downloaded')),
        ) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'integration' });

    await expect(access(targetPath)).rejects.toBeDefined();
  });
});
