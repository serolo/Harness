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

// End-to-end Phase 9 (mid-turn steer & message queue) against the MockHarness
// (AGENTAPP_E2E=1 forces the mock — no real `claude` CLI needed). Drives the REAL
// cross-process IPC via `window.api` (the established e2e style of chat.spec.ts /
// ipc.spec.ts), exercising the `queue:*` + `turn:steer` commands over the sandboxed
// contextBridge → preload → main boundary the renderer wiring depends on.
//
// What this proves end-to-end:
//   1. Queue is DB-backed + FIFO: enqueue two messages, `queue:list` returns them
//      head-first in order; draining the head flushes it as the next turn and advances
//      the queue (the auto-flush-on-idle ordering contract — head sends first).
//   2. Steer-now fallback for the shipped (non-steerable) mock: `turn:steer` REJECTS
//      with a typed `conflict` (never a silent inject), which is exactly what forces the
//      renderer's interrupt+resend fallback. Driving that fallback (interrupt → new
//      turn:start with the steered text) produces a NEW turn boundary — legibly NOT
//      seamless injection.
//
// Deferred (see report): the pixel-level UI auto-flush (Composer/QueueList testids) is
// covered by the renderer unit tests (stores/queue.test.ts, features/chat/QueueList.
// test.tsx); the TRUE-injection path (no interrupt) is covered by the supervisor + mock
// unit tests (supervisor.test.ts steerable case) — the shipped app wires a non-steerable
// `new MockHarness()` with no env hook to make it steerable, and this test does not add
// production wiring to enable it.

const here = dirname(fileURLToPath(import.meta.url));

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
const repoDirs: string[] = [];

/** A fresh, single-commit repo dir per test (project:add rejects a duplicate path). */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-e2e-queue-repo-'));
  initRepo(dir);
  repoDirs.push(dir);
  return dir;
}

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

interface Api {
  invoke(ch: string, req?: unknown): Promise<unknown>;
  stream(
    ch: string,
    arg: unknown,
    onChunk: (c: unknown) => void,
  ): Promise<void>;
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'harness-e2e-queue-'));

  app = await electron.launch({
    args: [join(here, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      AGENTAPP_USER_DATA: userDataDir,
      AGENTAPP_E2E: '1', // forces the MockHarness (non-steerable)
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true });
});

test('queue is DB-backed + FIFO; draining the head flushes it first and advances', async () => {
  const result = await page.evaluate(async (localPath: string) => {
    const api = (window as unknown as { api: Api }).api;

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

    // Enqueue two follow-up messages (as the composer does while a turn is busy).
    await api.invoke('queue:enqueue', {
      workspaceId,
      prompt: 'first queued',
      attachments: [],
    });
    await api.invoke('queue:enqueue', {
      workspaceId,
      prompt: 'second queued',
      attachments: [],
    });

    const afterEnqueue = (await api.invoke('queue:list', {
      workspaceId,
    })) as { id: string; prompt: string; orderIdx: number }[];

    // Auto-flush-on-idle: the HEAD sends first. Simulate the drain the renderer does —
    // send the head as a turn, then remove it from the queue.
    const head = afterEnqueue[0];
    await api.stream(
      'turn:start',
      { workspaceId, prompt: head.prompt, attachments: [] },
      () => {},
    );
    await api.invoke('queue:remove', { id: head.id });

    const afterDrain = (await api.invoke('queue:list', { workspaceId })) as {
      prompt: string;
    }[];

    const history = (await api.invoke('chat:history', { workspaceId })) as {
      turns: { status: string; events: { event: { kind: string } }[] }[];
    };

    return {
      order: afterEnqueue.map((m) => m.prompt),
      orderIdx: afterEnqueue.map((m) => m.orderIdx),
      remaining: afterDrain.map((m) => m.prompt),
      turnCount: history.turns.length,
      lastStatus: history.turns[history.turns.length - 1]?.status,
    };
  }, freshRepo());

  // FIFO, contiguous order indices.
  expect(result.order).toEqual(['first queued', 'second queued']);
  expect(result.orderIdx).toEqual([0, 1]);
  // Head flushed → queue advanced to the second, in order.
  expect(result.remaining).toEqual(['second queued']);
  // The flushed head became a real, completed turn.
  expect(result.turnCount).toBe(1);
  expect(result.lastStatus).toBe('completed');
});

test('steer-now on the non-steerable mock rejects with conflict, forcing interrupt+resend (a new turn boundary)', async () => {
  const result = await page.evaluate(async (localPath: string) => {
    const api = (window as unknown as { api: Api }).api;

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

    // (a) No active turn → steer is a typed conflict, never a silent inject.
    let idleSteerCode: string | undefined;
    try {
      await api.invoke('turn:steer', { workspaceId, text: 'nothing running' });
    } catch (e) {
      idleSteerCode = (e as { code?: string }).code;
    }

    // (b) While a turn is ACTIVE, steer against the non-steerable mock still rejects
    // with conflict. Fire `turn:steer` from inside the `started` frame (the turn is
    // guaranteed live at that point), collect its promise, and AWAIT the stream to
    // completion so no turn is left dangling (single-turn invariant) before the resend.
    let activeSteerCode: string | undefined;
    let steeredTurnId: string | undefined;
    let steerProbe: Promise<void> | undefined;
    await api.stream(
      'turn:start',
      { workspaceId, prompt: 'work to steer', attachments: [] },
      (c) => {
        const frame = c as { kind: string; turnId?: string };
        if (frame.kind === 'started' && !steerProbe) {
          steeredTurnId = frame.turnId;
          steerProbe = api
            .invoke('turn:steer', { workspaceId, text: 'steer me' })
            .then(() => {
              // A resolve here would mean the non-steerable mock silently injected —
              // a defect. Record a sentinel so the assertion fails loudly.
              activeSteerCode = 'unexpectedly-injected';
            })
            .catch((e) => {
              activeSteerCode = (e as { code?: string }).code;
            });
        }
      },
    );
    if (steerProbe) await steerProbe;

    // The renderer's fallback: interrupt (best-effort; the turn just finalized, so this
    // is a no-op) then resend the steered text as a brand-new turn — a legible new turn
    // boundary, NOT seamless injection.
    await api.invoke('turn:interrupt', { workspaceId });
    let resendTurnId: string | undefined;
    await api.stream(
      'turn:start',
      { workspaceId, prompt: 'steer me', attachments: [] },
      (c) => {
        const frame = c as { kind: string; turnId?: string };
        if (frame.kind === 'started') resendTurnId = frame.turnId;
      },
    );

    const history = (await api.invoke('chat:history', { workspaceId })) as {
      turns: { id: string; status: string }[];
    };

    return {
      idleSteerCode,
      activeSteerCode,
      // The resend is a distinct turn from the one we tried to steer.
      newBoundary:
        !!resendTurnId &&
        resendTurnId !== steeredTurnId &&
        history.turns.length >= 2,
      turnCount: history.turns.length,
    };
  }, freshRepo());

  // Steer is never a silent no-op on a non-steerable harness — it is a typed conflict,
  // both idle and mid-turn, which is what routes the renderer to the fallback.
  expect(result.idleSteerCode).toBe('conflict');
  expect(result.activeSteerCode).toBe('conflict');
  // The fallback resend is a NEW turn boundary (interrupt+resend), not seamless injection.
  expect(result.newBoundary).toBe(true);
});
