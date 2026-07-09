import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// End-to-end chat turn against the MockHarness (AGENTAPP_E2E=1 forces the mock, so no
// real `claude` CLI is needed — plan Task 9 / DoD). Drives the real cross-process IPC:
// create a project + workspace, stream a turn over `turn:start` (assert `started` +
// events + terminal), then reconstruct the transcript via `chat:history` (proves the
// turns/events persistence round-trips). Mirrors the window.api-level style of ipc.spec.ts.

const here = dirname(fileURLToPath(import.meta.url));

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let repoDir: string;

/** Init a throwaway git repo with one commit so a workspace worktree can branch off it. */
function initRepo(dir: string): void {
  const git = (args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  };
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git(['config', 'user.email', 'e2e@example.com']);
  git(['config', 'user.name', 'E2E']);
  writeFileSync(join(dir, 'README.md'), '# demo\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'harness-e2e-chat-'));
  repoDir = mkdtempSync(join(tmpdir(), 'harness-e2e-repo-'));
  initRepo(repoDir);

  app = await electron.launch({
    args: [join(here, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      AGENTAPP_USER_DATA: userDataDir,
      AGENTAPP_E2E: '1', // forces the MockHarness
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

test('send a prompt → tokens stream → turn ends → history reconstructs', async () => {
  const result = await page.evaluate(async (localPath: string) => {
    interface Api {
      invoke(ch: string, req?: unknown): Promise<unknown>;
      stream(
        ch: string,
        arg: unknown,
        onChunk: (c: unknown) => void,
      ): Promise<void>;
    }
    const api = (window as unknown as { api: Api }).api;

    // 1. Register the project + create a workspace (Phase 1 flows).
    const project = (await api.invoke('project:add', { localPath })) as {
      id: string;
    };
    let workspaceId = '';
    await api.stream('workspace:create', { projectId: project.id }, (c) => {
      const frame = c as { kind: string; workspace?: { id: string } };
      if (frame.kind === 'created' && frame.workspace) {
        workspaceId = frame.workspace.id;
      }
    });

    // 2. Stream a turn.
    const streamed: string[] = [];
    let started = false;
    let sawTurnEnd = false;
    await api.stream(
      'turn:start',
      { workspaceId, prompt: 'hello agent', attachments: [] },
      (c) => {
        const frame = c as {
          kind: string;
          event?: { kind: string; delta?: string };
        };
        if (frame.kind === 'started') started = true;
        else if (frame.kind === 'event' && frame.event) {
          if (frame.event.kind === 'text' && frame.event.delta) {
            streamed.push(frame.event.delta);
          }
          if (frame.event.kind === 'turn_end') sawTurnEnd = true;
        }
      },
    );

    // 3. Reconstruct from persistence.
    const history = (await api.invoke('chat:history', { workspaceId })) as {
      turns: { status: string; events: { event: { kind: string } }[] }[];
    };

    return {
      workspaceId,
      started,
      streamedText: streamed.join(''),
      sawTurnEnd,
      turnCount: history.turns.length,
      lastStatus: history.turns[history.turns.length - 1]?.status,
      historyHasText: history.turns.some((t) =>
        t.events.some((e) => e.event.kind === 'text'),
      ),
    };
  }, repoDir);

  expect(result.workspaceId).not.toBe('');
  expect(result.started).toBe(true);
  expect(result.streamedText.length).toBeGreaterThan(0);
  expect(result.sawTurnEnd).toBe(true);
  // Persistence round-trip: exactly one turn, completed, with text reconstructed.
  expect(result.turnCount).toBe(1);
  expect(result.lastStatus).toBe('completed');
  expect(result.historyHasText).toBe(true);
});
