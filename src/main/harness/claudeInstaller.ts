import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

import { AppError } from '../error';
import { downloadVerified } from '../integrations/verifiedDownload';
import { claudeCliPath, toolsDir } from '../paths';
import { executableName } from '../process/platform';

const CLAUDE_VERSION = '2.1.220';
const MAX_ARCHIVE_BYTES = 350 * 1024 * 1024;

export interface ClaudeCliAsset {
  url: string;
  sha512: string;
  binaryName: string;
}

const CLAUDE_ASSETS: Record<string, ClaudeCliAsset> = {
  'darwin-x64': {
    url: `https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-x64/-/claude-code-darwin-x64-${CLAUDE_VERSION}.tgz`,
    sha512:
      'hbuoG+YCo37VzSKzKJ47ymRmt/YjASc3dRcsZtCcftLYdopv8KL889x/IbCl3cfp/VqV2rRDZ0f3aUDpHUFweQ==',
    binaryName: 'claude',
  },
  'darwin-arm64': {
    url: `https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-${CLAUDE_VERSION}.tgz`,
    sha512:
      'rmtd41Bf+n+YnhjSjtQ8WG5qy8KKogUp3YRfQrkLsTgPUD0H3j869rBInBJT3SHrKQ0hLghQLGM73CC1C+USLQ==',
    binaryName: 'claude',
  },
  'linux-x64': {
    url: `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${CLAUDE_VERSION}.tgz`,
    sha512:
      '3CGFCnI0gpgsqNeJruFALBDGJaKXOuok3alQEg56ty2yOPpIrOx/r2Y0+T4uhJl7kP5Hzw4IFkxo4DZKWvzQ7Q==',
    binaryName: 'claude',
  },
  'win32-x64': {
    url: `https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-${CLAUDE_VERSION}.tgz`,
    sha512:
      'UGrjH8cGhC6PzhTyZSdgf/RpKxpfk9XJZ/RT/wsG2AJg9yEJLjLg6/TrnlL8RFbEv6Zahu0Quytc02UOpA/GiA==',
    binaryName: 'claude.exe',
  },
};

interface ClaudeCliInstallOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  targetPath?: string;
  tempRoot?: string;
  asset?: ClaudeCliAsset;
  extract?: (archivePath: string, destination: string) => Promise<void>;
  onProgress?: (message: string) => void;
}

export function claudeCliAsset(
  platform: NodeJS.Platform,
  arch: string,
): ClaudeCliAsset {
  const asset = CLAUDE_ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new AppError(
      'integration',
      `Automatic Claude Code installation is unavailable for ${platform}/${arch}`,
    );
  }
  if (asset.binaryName !== executableName('claude', platform)) {
    throw new AppError(
      'internal',
      'Claude platform asset configuration is invalid',
    );
  }
  return asset;
}

export async function installClaudeCli(
  options: ClaudeCliInstallOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = options.asset ?? claudeCliAsset(platform, arch);
  const targetPath = options.targetPath ?? claudeCliPath(platform);
  const tempRoot = options.tempRoot ?? join(toolsDir(), 'claude');
  const installDir = join(tempRoot, `.claude-install-${randomUUID()}`);
  const archivePath = join(installDir, 'claude.tgz');
  const extractDir = join(installDir, 'extract');
  const stagedPath = `${targetPath}.${randomUUID()}.tmp`;
  const extract = options.extract ?? extractTarball;
  const progress = options.onProgress ?? (() => undefined);

  try {
    progress(`Downloading Claude Code ${CLAUDE_VERSION}…`);
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
    progress('Installing Claude Code…');
    await extract(archivePath, extractDir);
    const extractedBinary = join(extractDir, 'package', asset.binaryName);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(extractedBinary, stagedPath);
    if (platform !== 'win32') await chmod(stagedPath, 0o755);
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
    await rm(installDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractTarball(
  archivePath: string,
  destination: string,
): Promise<void> {
  await execa('tar', ['-xzf', archivePath, '-C', destination], {
    timeout: 60_000,
  });
}
