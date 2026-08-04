import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

import { AppError } from '../../error';
import { githubCliPath, toolsBinDir } from '../../paths';

const GH_VERSION = '2.94.0';
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export interface GithubCliAsset {
  url: string;
  sha256: string;
  archiveRoot: string;
}

const GH_ASSETS: Record<'x64' | 'arm64', GithubCliAsset> = {
  x64: {
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_macOS_amd64.zip`,
    sha256: '733ee8fa49247d27cd94a6c7384455bdecaa82172a3bcfad63ac1ecc2867251d',
    archiveRoot: `gh_${GH_VERSION}_macOS_amd64`,
  },
  arm64: {
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_macOS_arm64.zip`,
    sha256: '4f9bc1a5e77500737290a307b40b4c396a4d23729f55340f2a83f414410165a1',
    archiveRoot: `gh_${GH_VERSION}_macOS_arm64`,
  },
};

interface GithubCliInstallOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  targetPath?: string;
  tempRoot?: string;
  asset?: GithubCliAsset;
  extract?: (archivePath: string, destination: string) => Promise<void>;
  onProgress?: (message: string) => void;
}

export function githubCliAsset(
  platform: NodeJS.Platform,
  arch: string,
): GithubCliAsset {
  if (platform !== 'darwin' || (arch !== 'x64' && arch !== 'arm64')) {
    throw new AppError(
      'integration',
      `Automatic GitHub CLI installation is unavailable for ${platform}/${arch}`,
    );
  }
  return GH_ASSETS[arch];
}

/** Download, verify, and atomically install the pinned official GitHub CLI binary. */
export async function installGithubCli(
  options: GithubCliInstallOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = options.asset ?? githubCliAsset(platform, arch);
  const targetPath = options.targetPath ?? githubCliPath();
  const tempRoot = options.tempRoot ?? join(toolsBinDir(), '..');
  const installDir = join(tempRoot, `.gh-install-${randomUUID()}`);
  const archivePath = join(installDir, 'gh.zip');
  const extractDir = join(installDir, 'extract');
  const stagedPath = `${targetPath}.${randomUUID()}.tmp`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const extract = options.extract ?? extractZip;
  const progress = options.onProgress ?? (() => undefined);

  try {
    progress(`Downloading GitHub CLI ${GH_VERSION}…`);
    await mkdir(extractDir, { recursive: true });
    const response = await fetchImpl(asset.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new AppError(
        'integration',
        `GitHub CLI download failed with HTTP ${response.status}`,
      );
    }
    const declaredSize = Number(response.headers.get('content-length') ?? '0');
    if (declaredSize > MAX_ARCHIVE_BYTES) {
      throw new AppError('integration', 'GitHub CLI download is unexpectedly large');
    }
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
      throw new AppError('integration', 'GitHub CLI download has an invalid size');
    }
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== asset.sha256) {
      throw new AppError(
        'integration',
        'GitHub CLI download failed integrity verification',
      );
    }

    progress('Verifying and installing GitHub CLI…');
    await writeFile(archivePath, archive, { mode: 0o600 });
    await extract(archivePath, extractDir);
    const extractedBinary = join(extractDir, asset.archiveRoot, 'bin', 'gh');
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(extractedBinary, stagedPath);
    await chmod(stagedPath, 0o755);
    await rename(stagedPath, targetPath);
    progress('GitHub CLI is ready. Starting sign-in…');
    return targetPath;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'integration',
      error instanceof Error
        ? `Unable to install GitHub CLI: ${error.message}`
        : 'Unable to install GitHub CLI',
    );
  } finally {
    await rm(stagedPath, { force: true }).catch(() => {});
    await rm(installDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractZip(
  archivePath: string,
  destination: string,
): Promise<void> {
  await execa('/usr/bin/ditto', ['-x', '-k', archivePath, destination], {
    timeout: 30_000,
  });
}
