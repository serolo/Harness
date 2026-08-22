import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parse, stringify } from 'yaml';

const ALLOWED_KEYS = new Set([
  'version',
  'files',
  'path',
  'sha512',
  'releaseDate',
]);
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message) {
  throw new Error(`Invalid macOS update metadata: ${message}`);
}

function isSha512(value) {
  if (typeof value !== 'string') return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === value;
}

function validatedMetadata(source, architecture) {
  const metadata = parse(source);
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    fail(`${architecture} document must be a mapping`);
  }
  for (const key of Object.keys(metadata)) {
    if (!ALLOWED_KEYS.has(key))
      fail(`${architecture} contains unknown key ${key}`);
  }
  if (typeof metadata.version !== 'string' || metadata.version.trim() === '') {
    fail(`${architecture} version is missing`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== 2) {
    fail(`${architecture} must contain exactly one ZIP and one DMG`);
  }

  const files = metadata.files.map((file, index) => {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      fail(`${architecture} file ${index} must be a mapping`);
    }
    const keys = Object.keys(file);
    if (keys.some((key) => !['url', 'sha512', 'size'].includes(key))) {
      fail(`${architecture} file ${index} contains an unknown key`);
    }
    if (typeof file.url !== 'string' || !SAFE_ASSET_NAME.test(file.url)) {
      fail(`${architecture} file ${index} has an unsafe URL`);
    }
    if (!isSha512(file.sha512)) {
      fail(`${architecture} file ${index} has an invalid checksum`);
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      fail(`${architecture} file ${index} has an invalid size`);
    }
    return { url: file.url, sha512: file.sha512, size: file.size };
  });

  const zipFiles = files.filter((file) => file.url.endsWith('.zip'));
  const dmgFiles = files.filter((file) => file.url.endsWith('.dmg'));
  if (zipFiles.length !== 1 || dmgFiles.length !== 1) {
    fail(`${architecture} must contain exactly one ZIP and one DMG`);
  }
  const zip = zipFiles[0];
  if (metadata.path !== zip.url || metadata.sha512 !== zip.sha512) {
    fail(`${architecture} legacy path/checksum must identify its ZIP`);
  }
  if (
    typeof metadata.releaseDate !== 'string' ||
    !Number.isFinite(Date.parse(metadata.releaseDate))
  ) {
    fail(`${architecture} release date is invalid`);
  }

  const hasArm64Name = (file) => file.url.includes('arm64');
  if (architecture === 'arm64' && files.some((file) => !hasArm64Name(file))) {
    fail('arm64 asset names must include arm64');
  }
  if (architecture === 'x64' && files.some(hasArm64Name)) {
    fail('x64 asset names must not include arm64');
  }

  return {
    version: metadata.version,
    files,
    zip,
    releaseDate: metadata.releaseDate,
  };
}

export function mergeMacUpdateMetadata(arm64Source, x64Source) {
  const arm64 = validatedMetadata(arm64Source, 'arm64');
  const x64 = validatedMetadata(x64Source, 'x64');
  if (arm64.version !== x64.version) {
    fail(`version mismatch (${arm64.version} != ${x64.version})`);
  }

  const files = [...arm64.files, ...x64.files];
  if (new Set(files.map((file) => file.url)).size !== files.length) {
    fail('asset names must be unique across architectures');
  }

  return stringify({
    version: arm64.version,
    files,
    // Legacy electron-updater fields cannot express two architectures. Prefer
    // x64 here; current clients select the correct ZIP from `files` above.
    path: x64.zip.url,
    sha512: x64.zip.sha512,
    releaseDate: new Date(
      Math.max(Date.parse(arm64.releaseDate), Date.parse(x64.releaseDate)),
    ).toISOString(),
  });
}

async function main() {
  const [, , arm64Path, x64Path, outputPath] = process.argv;
  if (!arm64Path || !x64Path || !outputPath) {
    throw new Error(
      'Usage: merge-mac-update-metadata.mjs <arm64-yml> <x64-yml> <output-yml>',
    );
  }
  const [arm64Source, x64Source] = await Promise.all([
    readFile(arm64Path, 'utf8'),
    readFile(x64Path, 'utf8'),
  ]);
  await writeFile(outputPath, mergeMacUpdateMetadata(arm64Source, x64Source), {
    flag: 'wx',
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
