import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let repoDir: string;
let projectId: string;
let workspaceId: string;
let agentId: string;

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'e2e@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'E2E']);
  writeFileSync(join(dir, 'README.md'), '# meta harness\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial']);
}

async function openAgentsPanel(): Promise<void> {
  await page.getByTestId('workspace-item').first().click();
  await page.getByTestId('workspace-tab-agents').click();
  await expect(page.getByTestId('agents-panel')).toBeVisible();
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'harness-e2e-meta-'));
  repoDir = mkdtempSync(join(tmpdir(), 'harness-e2e-meta-repo-'));
  initRepo(repoDir);
  writeFileSync(
    join(userDataDir, 'onboarding.json'),
    JSON.stringify({ version: 3, acknowledged: true }),
  );
  app = await electron.launch({
    args: [
      join(here, '..', 'out', 'main', 'index.js'),
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      AGENTAPP_USER_DATA: userDataDir,
      AGENTAPP_E2E: '1',
      ELECTRON_RENDERER_URL: '',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const seeded = await page.evaluate(async (localPath) => {
    const api = (
      window as unknown as {
        api: {
          invoke(channel: string, request?: unknown): Promise<unknown>;
          stream(
            channel: string,
            request: unknown,
            onChunk: (chunk: unknown) => void,
            opts: { id: string },
          ): Promise<void>;
        };
      }
    ).api;
    try {
      const project = (await api.invoke('project:add', { localPath })) as {
        id: string;
      };
      let workspace = '';
      await api.stream(
        'workspace:create',
        { projectId: project.id, name: 'meta-e2e' },
        (chunk) => {
          const frame = chunk as { kind: string; workspace?: { id: string } };
          if (frame.kind === 'created') workspace = frame.workspace?.id ?? '';
        },
        { id: crypto.randomUUID() },
      );
      const agent = (await api.invoke('metaAgent:create', {
        projectId: project.id,
        slug: 'e2e-agent',
        name: 'E2E agent',
      })) as { id: string };
      return {
        ok: true as const,
        projectId: project.id,
        workspaceId: workspace,
        agentId: agent.id,
      };
    } catch (reason) {
      return { ok: false as const, reason };
    }
  }, repoDir);
  if (!seeded.ok) {
    throw new Error(`E2E setup failed: ${JSON.stringify(seeded.reason)}`);
  }
  ({ projectId, workspaceId, agentId } = seeded);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

test('edits with validation recovery, runs through the mock provider, and snapshots a scheduled task', async () => {
  await expect(page.getByTestId('workspace-item')).toHaveCount(1);
  await page.getByTestId('workspace-item').click();
  await page.getByTestId('workspace-tab-agents').click();
  await expect(page.getByTestId('agent-e2e-agent')).toBeVisible();
  const polly = page.getByTestId('agent-polly');
  await expect(polly).toBeVisible();
  await polly.getByRole('button', { name: 'Inspect' }).click();
  await expect(page.getByLabel('Agent bundle file')).toHaveAttribute(
    'readonly',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await polly.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByTestId('agent-polly-copy')).toBeVisible();

  await page
    .getByTestId('agent-e2e-agent')
    .getByRole('button', { name: /Inspect/ })
    .click();
  const editor = page.getByLabel('Agent bundle file');
  await expect(editor).toHaveValue(/name: E2E agent/);
  const valid = await editor.inputValue();
  await editor.fill('name: [');
  await page
    .getByRole('button', { name: 'Validate and save atomically' })
    .click();
  await expect(
    page.getByText(/flow sequence in block collection/i),
  ).toBeVisible();
  await editor.fill(valid.replace('E2E agent', 'Recovered E2E agent'));
  await page
    .getByRole('button', { name: 'Validate and save atomically' })
    .click();
  await expect(page.getByText('Recovered E2E agent bundle')).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();

  await page
    .getByTestId('agent-e2e-agent')
    .getByRole('button', { name: 'Run' })
    .click();
  await page
    .getByLabel('Run goal')
    .fill('Exercise the deterministic coordinator');
  await expect(page.getByText(/Merging is never delegated/)).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Recovered E2E agent run')).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();

  const task = await page.evaluate(
    async ({
      projectId: currentProject,
      workspaceId: currentWorkspace,
      agentId: currentAgent,
    }) => {
      const api = (
        window as unknown as {
          api: { invoke(channel: string, request?: unknown): Promise<unknown> };
        }
      ).api;
      const created = (await api.invoke('task:create', {
        workspaceId: currentWorkspace,
        prompt: 'Scheduled agent work',
        agentId: currentAgent,
      })) as { agentId?: string; agentRevision?: string; agentName?: string };
      const agents = (await api.invoke('metaAgent:list', {
        projectId: currentProject,
      })) as { id: string; revision: string }[];
      return {
        task: created,
        revision: agents.find((agent) => agent.id === currentAgent)?.revision,
      };
    },
    { projectId, workspaceId, agentId },
  );
  expect(task.task.agentId).toBe(agentId);
  expect(task.task.agentName).toBe('Recovered E2E agent');
  expect(task.task.agentRevision).toBe(task.revision);
});

test('fans out two isolated children, awaits them, and continues one provider session', async () => {
  const result = await page.evaluate(
    async ({ currentProject, currentWorkspace }) => {
      const api = (
        window as unknown as {
          api: { invoke(channel: string, request?: unknown): Promise<unknown> };
        }
      ).api;
      const started = (await api.invoke('metaAgent:startRun', {
        projectId: currentProject,
        agentId: 'builtin:polly',
        sourceWorkspaceId: currentWorkspace,
        goal: 'E2E_META_TWO_CHILDREN prove fan-out and continuation',
      })) as { id: string };
      let run: {
        status: string;
        dispatches: {
          role: string;
          workspaceId: string | null;
          sessionId: string | null;
        }[];
      };
      const deadline = Date.now() + 15_000;
      do {
        run = (await api.invoke('metaRun:get', {
          projectId: currentProject,
          runId: started.id,
        })) as typeof run;
        if (run.status !== 'starting' && run.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      const implementer = run.dispatches.find(
        (dispatch) => dispatch.role === 'implementer',
      );
      const history = implementer?.workspaceId
        ? ((await api.invoke('chat:history', {
            workspaceId: implementer.workspaceId,
          })) as { turns: { status: string }[] })
        : { turns: [] };
      return { run, implementerTurns: history.turns };
    },
    { currentProject: projectId, currentWorkspace: workspaceId },
  );

  expect(result.run.status).toBe('completed');
  expect(result.run.dispatches).toHaveLength(2);
  expect(
    new Set(result.run.dispatches.map((dispatch) => dispatch.workspaceId)).size,
  ).toBe(2);
  expect(result.run.dispatches.every((dispatch) => dispatch.sessionId)).toBe(
    true,
  );
  expect(result.implementerTurns).toHaveLength(2);
  expect(
    result.implementerTurns.every((turn) => turn.status === 'completed'),
  ).toBe(true);

  await page
    .getByRole('button', {
      name: /Polly: E2E_META_TWO_CHILDREN prove fan-out and continuation completed/,
    })
    .click();
  await expect(
    page.getByTestId('agent-dispatch-list').locator('article'),
  ).toHaveCount(2);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
});

test('runs Debby partners and critiques and renders the comparison before synthesis', async () => {
  const run = await page.evaluate(
    async ({ currentProject, currentWorkspace }) => {
      const api = (
        window as unknown as {
          api: { invoke(channel: string, request?: unknown): Promise<unknown> };
        }
      ).api;
      const started = (await api.invoke('metaAgent:startRun', {
        projectId: currentProject,
        agentId: 'builtin:debby',
        sourceWorkspaceId: currentWorkspace,
        goal: 'E2E Debby comparison',
      })) as { id: string };
      let detail: {
        status: string;
        finalSummary: string | null;
        dispatches: { debateStage?: string; debateRound?: number }[];
      };
      const deadline = Date.now() + 15_000;
      do {
        detail = (await api.invoke('metaRun:get', {
          projectId: currentProject,
          runId: started.id,
        })) as typeof detail;
        if (detail.status !== 'starting' && detail.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      return detail;
    },
    { currentProject: projectId, currentWorkspace: workspaceId },
  );

  expect(run.status).toBe('completed');
  expect(
    run.dispatches.filter((item) => item.debateStage === 'partner'),
  ).toHaveLength(2);
  expect(
    run.dispatches.filter(
      (item) => item.debateStage === 'critique' && item.debateRound === 1,
    ),
  ).toHaveLength(2);
  expect(run.finalSummary).toMatch(/preserves both partner answers/);

  await page
    .getByRole('button', { name: /Debby: E2E Debby comparison completed/ })
    .click();
  await expect(page.getByTestId('debby-comparison')).toContainText(
    'Independent partner responses',
  );
  await expect(page.getByTestId('debby-comparison')).toContainText(
    'Critique round 1',
  );
  await expect(page.getByRole('heading', { name: 'Synthesis' })).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
});

test('cancels and takes over held coordinator runs through the run inspector', async () => {
  const startHeld = async (suffix: string): Promise<void> => {
    const result = await page.evaluate(
      async ({ currentProject, currentWorkspace, goal }) => {
        const api = (
          window as unknown as {
            api: {
              invoke(channel: string, request?: unknown): Promise<unknown>;
            };
          }
        ).api;
        try {
          await api.invoke('metaAgent:startRun', {
            projectId: currentProject,
            agentId: 'builtin:polly',
            sourceWorkspaceId: currentWorkspace,
            goal,
          });
          return { ok: true as const };
        } catch (reason) {
          const error = reason as {
            code?: unknown;
            message?: unknown;
            details?: unknown;
          };
          return {
            ok: false as const,
            code: error.code,
            message: error.message,
            details: error.details,
          };
        }
      },
      {
        currentProject: projectId,
        currentWorkspace: workspaceId,
        goal: `E2E_META_HOLD ${suffix}`,
      },
    );
    expect(result).toEqual({ ok: true });
  };

  await openAgentsPanel();
  await startHeld('cancel');
  await page
    .getByRole('button', { name: /Polly: E2E_META_HOLD cancel running/ })
    .click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('cancelled · revision');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();

  await startHeld('takeover');
  await page
    .getByRole('button', { name: /Polly: E2E_META_HOLD takeover running/ })
    .click();
  await page.getByRole('button', { name: 'Take over', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('taken_over · revision');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
});

test('fires a scheduled agent using its stored revision after the source bundle changes', async () => {
  const result = await page.evaluate(
    async ({ currentProject, currentWorkspace, currentAgent }) => {
      const api = (
        window as unknown as {
          api: { invoke(channel: string, request?: unknown): Promise<unknown> };
        }
      ).api;
      const task = (await api.invoke('task:create', {
        workspaceId: currentWorkspace,
        prompt: 'Fire the stored agent snapshot',
        scheduledAt: Date.now() + 60_000,
        agentId: currentAgent,
      })) as { id: string; agentRevision: string };
      const file = (await api.invoke('metaAgent:readFile', {
        projectId: currentProject,
        agentId: currentAgent,
        path: 'config.yaml',
      })) as { content: string };
      await api.invoke('metaAgent:saveBundleFiles', {
        projectId: currentProject,
        agentId: currentAgent,
        files: [
          {
            path: 'config.yaml',
            content: file.content.replace(
              /^name:.*$/m,
              'name: Post-snapshot E2E agent',
            ),
          },
        ],
      });
      await api.invoke('task:runNow', { id: task.id });
      let fired: {
        state: string;
        metaRunId: string | null;
        agentRevision: string;
      };
      const deadline = Date.now() + 15_000;
      do {
        const tasks = (await api.invoke('task:list', {
          workspaceId: currentWorkspace,
        })) as (typeof fired & { id: string })[];
        fired = tasks.find((item) => item.id === task.id)!;
        if (fired.state === 'done' || fired.state === 'error') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      const run = (await api.invoke('metaRun:get', {
        projectId: currentProject,
        runId: fired.metaRunId,
      })) as { status: string; agentRevision: string };
      const agents = (await api.invoke('metaAgent:list', {
        projectId: currentProject,
      })) as { id: string; revision: string }[];
      return {
        taskRevision: task.agentRevision,
        fired,
        run,
        currentRevision: agents.find((item) => item.id === currentAgent)
          ?.revision,
      };
    },
    {
      currentProject: projectId,
      currentWorkspace: workspaceId,
      currentAgent: agentId,
    },
  );

  expect(result.fired.state).toBe('done');
  expect(result.fired.metaRunId).not.toBeNull();
  expect(result.run.status).toBe('completed');
  expect(result.run.agentRevision).toBe(result.taskRevision);
  expect(result.currentRevision).not.toBe(result.taskRevision);
});
