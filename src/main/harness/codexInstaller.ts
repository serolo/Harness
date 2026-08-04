import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

import { AppError } from '../error';
import { codexCliPath, codexInstallDir, toolsDir } from '../paths';
import { downloadVerified } from '../integrations/verifiedDownload';

const CODEX_VERSION = '0.145.0';
const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024;

export interface CodexCliAsset {
  url: string;
  sha512: string;
  targetTriple: string;
}

const CODEX_ASSETS: Record<'x64' | 'arm64', CodexCliAsset> = {
  x64: {
    url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-darwin-x64.tgz`,
    sha512:
      'FCYzVKCa9VoLtg9gVyzKpqylonfgZrfcWZN6HsXAZPeuo8CukdMqdgTUOhDn2V6h3MbqS0z6VqQVKUllN/yKhA==',
    targetTriple: 'x86_64-apple-darwin',
  },
  arm64: {
    url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-darwin-arm64.tgz`,
    sha512:
      'h6aQ0UxnaP8mIM/9/qPAH9MNkRliJo88toq1T36IxNM2L5JSU0TFamu+MZn7YkFgDsrp0RfiI+97Tm8AVVxqtA==',
    targetTriple: 'aarch64-apple-darwin',
  },
};

interface CodexCliInstallOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  targetDir?: string;
  tempRoot?: string;
  asset?: CodexCliAsset;
  extract?: (archivePath: string, destination: string) => Promise<void>;
  onProgress?: (message: string) => void;
}

export function codexCliAsset(
  platform: NodeJS.Platform,
  arch: string,
): CodexCliAsset {
  if (platform !== 'darwin' || (arch !== 'x64' && arch !== 'arm64')) {
    throw new AppError(
      'integration',
      `Automatic Codex installation is unavailable for ${platform}/${arch}`,
    );
  }
  return CODEX_ASSETS[arch];
}

export async function installCodexCli(
  options: CodexCliInstallOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = options.asset ?? codexCliAsset(platform, arch);
  const targetDir = options.targetDir ?? codexInstallDir();
  const tempRoot = options.tempRoot ?? join(toolsDir(), 'codex');
  const installDir = join(tempRoot, `.codex-install-${randomUUID()}`);
  const archivePath = join(installDir, 'codex.tgz');
  const extractDir = join(installDir, 'extract');
  const extract = options.extract ?? extractTarball;
  const progress = options.onProgress ?? (() => undefined);

  try {
    progress(`Downloading Codex ${CODEX_VERSION}…`);
    await mkdir(extractDir, { recursive: true });
    await downloadVerified({
      url: asset.url,
      destination: archivePath,
      algorithm: 'sha512',
      expectedDigest: asset.sha512,
      digestEncoding: 'base64',
      maxBytes: MAX_ARCHIVE_BYTES,
      fetchImpl: options.fetchImpl,
    });
    progress('Installing Codex…');
    await extract(archivePath, extractDir);
    const extractedBinary = join(
      extractDir,
      'package',
      'vendor',
      asset.targetTriple,
      'bin',
      'codex',
    );
    await chmod(extractedBinary, 0o755);
    await mkdir(dirname(targetDir), { recursive: true });
    await rm(targetDir, { recursive: true, force: true });
    await rename(extractDir, targetDir);
    progress('Codex is ready. Starting sign-in…');
    return options.targetDir
      ? join(targetDir, 'package', 'vendor', asset.targetTriple, 'bin', 'codex')
      : codexCliPath(arch);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'integration',
      error instanceof Error
        ? `Unable to install Codex: ${error.message}`
        : 'Unable to install Codex',
    );
  } finally {
    await rm(installDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractTarball(
  archivePath: string,
  destination: string,
): Promise<void> {
  await execa('/usr/bin/tar', ['-xzf', archivePath, '-C', destination], {
    timeout: 60_000,
  });
}
