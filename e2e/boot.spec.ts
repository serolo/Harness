import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';

// ESM module (package.json `"type": "module"`) — derive __dirname from import.meta.
const here = dirname(fileURLToPath(import.meta.url));

// Phase 0 DoD boot check: launch the BUILT Electron app and assert the hardened
// renderer completes the IPC round trip AND that no Node/ipcRenderer globals leak
// into the page. This is the end-to-end proof the unit tests structurally cannot
// give (contextBridge + sandboxed CJS preload only exist in a real Electron run).
//
// Regression guard for the sandboxed-preload format bug: a `.mjs`/ESM preload
// under `sandbox: true` never loads, `window.api` stays undefined, and the
// IpcHealth indicator would be red — this test would then fail at `data-state`.

let app: ElectronApplication;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'harness-e2e-'));
  app = await electron.launch({
    args: [join(here, '..', 'out', 'main', 'index.js')],
    // Point the app's on-disk data at a throwaway dir (paths.ts test seam) so the
    // boot test never touches the developer's real Application Support data.
    env: { ...process.env, AGENTAPP_USER_DATA: userDataDir },
  });
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test('boots, exposes window.api, and flips the IPC indicator to OK', async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // The IpcHealth indicator reaches "ok" only after invoke('app:ping') → 'ok'
  // has round-tripped renderer → preload → main → back.
  const health = window.locator('[data-testid="ipc-health"]');
  await expect(health).toHaveAttribute('data-state', 'ok', { timeout: 20_000 });

  // window.api is the ONLY bridge, and it must be a real function.
  const apiIsFn = await window.evaluate(
    () =>
      typeof (window as unknown as { api?: { invoke?: unknown } }).api
        ?.invoke === 'function',
  );
  expect(apiIsFn).toBe(true);
});

test('does not leak ipcRenderer or Node globals into the renderer', async () => {
  const window = await app.firstWindow();
  const leaked = await window.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      ipcRenderer: w['ipcRenderer'] !== undefined,
      require: w['require'] !== undefined,
      process: w['process'] !== undefined,
    };
  });
  expect(leaked).toEqual({
    ipcRenderer: false,
    require: false,
    process: false,
  });
});
