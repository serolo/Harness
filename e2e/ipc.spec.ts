import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

// Real cross-process IPC contract tests (regression guards for two confirmed issues):
//  1. AppError code/details must survive an ipcMain.handle rejection. Electron carries
//     ONLY the message across that boundary, so main encodes the serialized shape into
//     it and the preload decodes it — this asserts a renderer `catch` sees code+details.
//  2. app:echoStream must stream end-to-end through createStream()/webContents.send:
//     chunks arrive in order and the stream completes (DoD "demonstrates end-to-end").
// Launched with AGENTAPP_E2E=1 so the main process registers the test-only throw channel.

const here = dirname(fileURLToPath(import.meta.url));

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'harness-e2e-ipc-'));
  app = await electron.launch({
    args: [join(here, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, AGENTAPP_USER_DATA: userDataDir, AGENTAPP_E2E: '1' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test('a thrown AppError arrives in the renderer with its code and details intact', async () => {
  const result = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        api: { invoke(ch: string, req?: unknown): Promise<unknown> };
      }
    ).api;
    try {
      await api.invoke('test:throwAppError');
      return { threw: false as const };
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown; details?: unknown };
      return {
        threw: true as const,
        code: err.code,
        message: err.message,
        details: err.details,
      };
    }
  });

  expect(result.threw).toBe(true);
  // Without the message codec this would collapse to code 'internal' and lose details.
  expect(result.code).toBe('conflict');
  expect(result.message).toBe('name taken');
  expect(result.details).toEqual({ name: 'paris' });
});

test('app:echoStream streams chunks in order and completes', async () => {
  const received = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        api: {
          stream(
            ch: string,
            arg: unknown,
            onChunk: (c: unknown) => void,
          ): Promise<void>;
        };
      }
    ).api;
    const chunks: string[] = [];
    await api.stream('app:echoStream', { text: 'hello brave world' }, (c) => {
      chunks.push(c as string);
    });
    return chunks;
  });

  // Chunks are word/whitespace fragments; concatenation reconstructs the input, and the
  // Promise resolving proves the `end` frame fired and teardown ran.
  expect(received.length).toBeGreaterThan(1);
  expect(received.join('')).toBe('hello brave world');
});
