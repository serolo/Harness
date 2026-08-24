import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// The test runner is launched under the ELECTRON ABI via scripts/vitest-electron.mjs
// (see `npm test` / `npm run check`) so DB tests can load the native `better-sqlite3`
// build compiled for Electron, not plain Node. `pool: 'forks'` makes Vitest fork
// child processes that inherit the Electron execPath/env, keeping the ABI consistent
// in the workers that actually run the tests.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    globals: true,
    // Fork pool so child workers inherit ELECTRON_RUN_AS_NODE + the electron
    // execPath from the parent (scripts/vitest-electron.mjs) — required for the
    // native-module ABI to match in the process that opens the sqlite file.
    pool: 'forks',
    // ConPTY cannot reliably attach multiple Electron-as-Node fork workers to
    // the same non-interactive Windows CI console. Serial Windows files also
    // prevent SQLite/Git integration tests from exceeding their timeout while
    // competing for the two-core hosted runner.
    maxWorkers: process.platform === 'win32' ? 1 : undefined,
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 20_000 : 10_000,
    setupFiles: ['src/test/setup.ts'],
    exclude: ['node_modules', 'out', 'dist', 'e2e'],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/preload/**/*.test.ts',
            'src/shared/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.ts', 'src/renderer/**/*.test.tsx'],
        },
      },
    ],
  },
});
