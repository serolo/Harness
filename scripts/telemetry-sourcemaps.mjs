import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const outputDirectory = new URL('../out/', import.meta.url);

async function removeSourceMaps(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const url = new URL(entry.name, directory);
      if (entry.isDirectory())
        return removeSourceMaps(new URL(`${entry.name}/`, directory));
      if (entry.isFile() && entry.name.endsWith('.map')) await rm(url);
    }),
  );
}

const command = process.argv[2];
if (command === 'strip') {
  await removeSourceMaps(outputDirectory);
} else if (command === 'upload') {
  for (const name of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) {
    if (!process.env[name])
      throw new Error(`${name} is required to upload source maps`);
  }
  const executable = require.resolve('@sentry/cli/bin/sentry-cli');
  await execFileAsync(
    process.execPath,
    [
      executable,
      'sourcemaps',
      'upload',
      '--org',
      process.env.SENTRY_ORG,
      '--project',
      process.env.SENTRY_PROJECT,
      '--release',
      version,
      '--rewrite',
      new URL('../out', import.meta.url).pathname,
    ],
    { env: process.env },
  );
  await removeSourceMaps(outputDirectory);
} else {
  throw new Error('usage: telemetry-sourcemaps.mjs <upload|strip>');
}
