import { defineConfig } from '@playwright/test';

// E2E config for the Electron `_electron` launcher. Specs live in `e2e/` and
// boot the BUILT app from `out/` (run `npm run build` first). Kept minimal for
// Phase 0 — the single boot spec proves the hardened window exposes `window.api`
// and the renderer completes the IPC round trip.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
});
