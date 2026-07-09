// Run Vitest under the ELECTRON ABI without booting an Electron app.
//
// WHY THIS EXISTS (the crux of Task 10):
//   `better-sqlite3` in node_modules is compiled for Electron's ABI
//   (NODE_MODULE_VERSION 130). Plain `node`/`vitest` runs under the Node ABI
//   (127), so `require('better-sqlite3')` throws a NODE_MODULE_VERSION mismatch.
//   The DB tests open a REAL sqlite file, so they must load the real native
//   module — which means the whole test runner has to execute under the Electron
//   ABI. Electron ships a mode (`ELECTRON_RUN_AS_NODE=1`) that turns the Electron
//   binary into a plain Node runtime with Electron's V8/ABI but no `app`/BrowserWindow.
//
// HOW:
//   `require('electron')` resolves to the absolute path of the Electron binary on
//   this machine (portable — no hardcoded path, no cross-env dependency). We spawn
//   that binary as Node, with `ELECTRON_RUN_AS_NODE=1`, running Vitest's CLI entry
//   and forwarding every CLI arg through. vitest.config.ts pins `pool: 'forks'` so
//   worker children inherit this env + execPath and therefore the same ABI.
//
// Used by both `npm test` and the `vitest` step of `npm run check`.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// `require('electron')` returns the path to the Electron executable.
const electronBin = require('electron');
if (typeof electronBin !== 'string') {
  throw new Error(
    'Could not resolve the Electron binary path from require("electron").',
  );
}

// Vitest's ESM CLI entry point.
const vitestCli = fileURLToPath(
  new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
);

// Forward all args (e.g. `run`, `run src/main/db`, `--reporter=...`).
const args = [vitestCli, ...process.argv.slice(2)];

const child = spawn(electronBin, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  console.error('Failed to launch Vitest under the Electron ABI:', err);
  process.exit(1);
});
