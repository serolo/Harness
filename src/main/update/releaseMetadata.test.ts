import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { parse } from 'yaml';

const SCRIPT = resolve('scripts/merge-mac-update-metadata.mjs');
const CHECKSUM = Buffer.alloc(64, 'a').toString('base64');
const fixtureDirectories: string[] = [];

function metadata(
  version: string,
  zip: string,
  dmg: string,
  releaseDate: string,
): string {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${zip}`,
    `    sha512: ${CHECKSUM}`,
    '    size: 100',
    `  - url: ${dmg}`,
    `    sha512: ${CHECKSUM}`,
    '    size: 200',
    `path: ${zip}`,
    `sha512: ${CHECKSUM}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

async function fixtures(): Promise<{
  directory: string;
  arm64: string;
  x64: string;
  output: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-update-metadata-'));
  fixtureDirectories.push(directory);
  return {
    directory,
    arm64: join(directory, 'latest-mac-arm64.yml'),
    x64: join(directory, 'latest-mac-x64.yml'),
    output: join(directory, 'latest-mac.yml'),
  };
}

describe('merge macOS release update metadata', () => {
  afterEach(async () => {
    await Promise.all(
      fixtureDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('combines arm64 and x64 assets into one architecture-selectable manifest', async () => {
    const paths = await fixtures();
    await writeFile(
      paths.arm64,
      metadata(
        '1.2.3',
        'Harness-1.2.3-arm64-mac.zip',
        'Harness-1.2.3-arm64.dmg',
        '2026-08-21T01:00:00.000Z',
      ),
    );
    await writeFile(
      paths.x64,
      metadata(
        '1.2.3',
        'Harness-1.2.3-mac.zip',
        'Harness-1.2.3.dmg',
        '2026-08-21T01:01:00.000Z',
      ),
    );

    await execa('node', [SCRIPT, paths.arm64, paths.x64, paths.output]);

    const merged = parse(await readFile(paths.output, 'utf8')) as {
      version: string;
      files: Array<{ url: string }>;
      path: string;
      releaseDate: string;
    };
    expect(merged.version).toBe('1.2.3');
    expect(merged.files.map((file) => file.url)).toEqual([
      'Harness-1.2.3-arm64-mac.zip',
      'Harness-1.2.3-arm64.dmg',
      'Harness-1.2.3-mac.zip',
      'Harness-1.2.3.dmg',
    ]);
    expect(merged.path).toBe('Harness-1.2.3-mac.zip');
    expect(merged.releaseDate).toBe('2026-08-21T01:01:00.000Z');
  });

  it('fails closed when architecture manifests disagree', async () => {
    const paths = await fixtures();
    await writeFile(
      paths.arm64,
      metadata(
        '1.2.3',
        'Harness-1.2.3-arm64-mac.zip',
        'Harness-1.2.3-arm64.dmg',
        '2026-08-21T01:00:00.000Z',
      ),
    );
    await writeFile(
      paths.x64,
      metadata(
        '1.2.4',
        'Harness-1.2.4-mac.zip',
        'Harness-1.2.4.dmg',
        '2026-08-21T01:01:00.000Z',
      ),
    );

    await expect(
      execa('node', [SCRIPT, paths.arm64, paths.x64, paths.output]),
    ).rejects.toThrow(/version mismatch/);
  });
});
