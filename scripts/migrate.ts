import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/main/db/migrations/index.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: npm run migrate -- (--database /absolute/scratch.db | --scratch)',
  );
  console.log(
    'Never defaults to the live Harness database. Back up any selected database first.',
  );
  process.exit(0);
}

// Native dependencies are rebuilt for Electron in this desktop app. Relaunch the
// migration worker under Electron-as-Node so the CLI always uses the shipped ABI.
if (process.versions.electron === undefined) {
  const require = createRequire(import.meta.url);
  const electronBin: unknown = require('electron');
  if (typeof electronBin !== 'string') {
    throw new Error('Could not resolve the Electron runtime.');
  }
  const result = spawnSync(
    electronBin,
    [require.resolve('tsx/cli'), fileURLToPath(import.meta.url), ...args],
    {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const databaseIndex = args.indexOf('--database');
let target: string;
if (args.includes('--scratch')) {
  target = join(mkdtempSync(join(tmpdir(), 'harness-migrate-')), 'scratch.db');
} else if (databaseIndex >= 0 && args[databaseIndex + 1]) {
  target = resolve(args[databaseIndex + 1]);
} else {
  throw new Error(
    'Refusing to migrate without --database <path> or --scratch. See --help.',
  );
}
const db = new BetterSqlite3(target);
try {
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  console.log(`Migrations applied to explicitly selected database: ${target}`);
} finally {
  db.close();
}
