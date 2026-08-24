import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

import { AppError } from '../../error';
import { githubCliPath, toolsBinDir } from '../../paths';
import { executableName } from '../../process/platform';

const GH_VERSION = '2.94.0';
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export interface GithubCliAsset {
  url: string;
  sha256: string;
  archiveRoot: string;
  archiveType: 'zip' | 'tar.gz';
}

const GH_ASSETS: Record<string, GithubCliAsset> = {
  'darwin-x64': {
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_macOS_amd64.zip`,
    sha256: '733ee8fa49247d27cd94a6c7384455bdecaa82172a3bcfad63ac1ecc2867251d',
    archiveRoot: `gh_${GH_VERSION}_macOS_amd64`,
    archiveType: 'zip',
  },
  'darwin-arm64': {
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_macOS_arm64.zip`,
    sha256: '4f9bc1a5e77500737290a307b40b4c396a4d23729f55340f2a83f414410165a1',
    archiveRoot: `gh_${GH_VERSION}_macOS_arm64`,
    archiveType: 'zip',
  },
  'linux-x64': {
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz`,
    sha256: 'a757f1ba6db18f4de8cbadb244843a5f89bc75b5e7c6fc127d2bd77fbd12ed62',
    archiveRoot: `gh_${GH_VERSION}_linux_amd64`,
    archiveType: 'tar.gz',
  },
  'win32-x64': {
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_windows_amd64.zip`,
    sha256: 'c0766af54195dfa0bcd9a0cb63a45c313fbaffdebb9f736f666e9ba4be8c91e8',
    archiveRoot: `gh_${GH_VERSION}_windows_amd64`,
    archiveType: 'zip',
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
  const asset = GH_ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new AppError(
      'integration',
      `Automatic GitHub CLI installation is unavailable for ${platform}/${arch}`,
    );
  }
  return asset;
}

/** Download, verify, and atomically install the pinned official GitHub CLI binary. */
export async function installGithubCli(
  options: GithubCliInstallOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = options.asset ?? githubCliAsset(platform, arch);
  const targetPath = options.targetPath ?? githubCliPath(platform);
  const tempRoot = options.tempRoot ?? join(toolsBinDir(), '..');
  const installDir = join(tempRoot, `.gh-install-${randomUUID()}`);
  const archivePath = join(
    installDir,
    asset.archiveType === 'zip' ? 'gh.zip' : 'gh.tar.gz',
  );
  const extractDir = join(installDir, 'extract');
  const stagedPath = `${targetPath}.${randomUUID()}.tmp`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const extract =
    options.extract ??
    ((path: string, destination: string) =>
      extractArchive(path, destination, platform, asset.archiveType));
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
      throw new AppError(
        'integration',
        'GitHub CLI download is unexpectedly large',
      );
    }
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
      throw new AppError(
        'integration',
        'GitHub CLI download has an invalid size',
      );
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
    const extractedBinary = join(
      extractDir,
      asset.archiveRoot,
      'bin',
      executableName('gh', platform),
    );
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(extractedBinary, stagedPath);
    if (platform !== 'win32') await chmod(stagedPath, 0o755);
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

async function extractArchive(
  archivePath: string,
  destination: string,
  platform: NodeJS.Platform,
  archiveType: GithubCliAsset['archiveType'],
): Promise<void> {
  if (platform === 'darwin' && archiveType === 'zip') {
    await execa('/usr/bin/ditto', ['-x', '-k', archivePath, destination], {
      timeout: 30_000,
    });
    return;
  }
  await execa(
    'tar',
    [archiveType === 'tar.gz' ? '-xzf' : '-xf', archivePath, '-C', destination],
    { timeout: 30_000 },
  );
}
