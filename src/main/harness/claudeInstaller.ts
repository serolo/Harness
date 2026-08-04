import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AppError } from '../error';
import { claudeCliPath, toolsDir } from '../paths';
import { downloadVerified } from '../integrations/verifiedDownload';

const CLAUDE_VERSION = '2.1.220';
const MAX_BINARY_BYTES = 350 * 1024 * 1024;

export interface ClaudeCliAsset {
  url: string;
  sha256: string;
}

const CLAUDE_ASSETS: Record<'x64' | 'arm64', ClaudeCliAsset> = {
  x64: {
    url: `https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/darwin-x64/claude`,
    sha256: 'dca7be0aa7d3d924836d440e0c6d8e3d47ef3c8e61fa5809b54b9017170ce2f3',
  },
  arm64: {
    url: `https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/darwin-arm64/claude`,
    sha256: '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081',
  },
};

interface ClaudeCliInstallOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  targetPath?: string;
  tempRoot?: string;
  asset?: ClaudeCliAsset;
  onProgress?: (message: string) => void;
}

export function claudeCliAsset(
  platform: NodeJS.Platform,
  arch: string,
): ClaudeCliAsset {
  if (platform !== 'darwin' || (arch !== 'x64' && arch !== 'arm64')) {
    throw new AppError(
      'integration',
      `Automatic Claude Code installation is unavailable for ${platform}/${arch}`,
    );
  }
  return CLAUDE_ASSETS[arch];
}

export async function installClaudeCli(
  options: ClaudeCliInstallOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = options.asset ?? claudeCliAsset(platform, arch);
  const targetPath = options.targetPath ?? claudeCliPath();
  const tempRoot = options.tempRoot ?? toolsDir();
  const stagedPath = join(tempRoot, `.claude-${randomUUID()}.tmp`);
  const progress = options.onProgress ?? (() => undefined);

  try {
    progress(`Downloading Claude Code ${CLAUDE_VERSION}…`);
    await mkdir(dirname(stagedPath), { recursive: true });
    await downloadVerified({
      url: asset.url,
      destination: stagedPath,
      algorithm: 'sha256',
      expectedDigest: asset.sha256,
      digestEncoding: 'hex',
      maxBytes: MAX_BINARY_BYTES,
      fetchImpl: options.fetchImpl,
    });
    progress('Installing Claude Code…');
    await chmod(stagedPath, 0o755);
    await mkdir(dirname(targetPath), { recursive: true });
    await rename(stagedPath, targetPath);
    progress('Claude Code is ready. Starting sign-in…');
    return targetPath;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'integration',
      error instanceof Error
        ? `Unable to install Claude Code: ${error.message}`
        : 'Unable to install Claude Code',
    );
  } finally {
    await rm(stagedPath, { force: true }).catch(() => {});
  }
}
