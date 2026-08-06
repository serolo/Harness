import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NormalizedAgentSnapshot } from '@shared/agents';
import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from './projects';
import { WorkspacesRepo } from './workspaces';
import { AgentRunsRepo } from './agentRuns';
import { AgentDispatchesRepo } from './agentDispatches';
import { TurnsRepo } from './turns';

let tmpDir: string;
let db: AppDatabase;
let repo: AgentDispatchesRepo;
let runId: string;
let workspace: { id: string; branch: string };

const snapshot: NormalizedAgentSnapshot = {
  schemaVersion: 1,
  slug: 'agent',
  name: 'Agent',
  description: '',
  revision: 'r1',
  prompt: 'Coordinate',
  coordinator: { harness: 'claude_code', mode: 'plan' },
  roles: [],
  skills: [],
  capabilities: ['delegate'],
  requiredProviders: [],
  policy: {
    maxDispatches: 2,
    maxParallel: 1,
    maxDepth: 1,
    turnTimeoutMs: 10_000,
    runTimeoutMs: 60_000,
    maxRequestBytes: 1_024,
    maxResultBytes: 1_024,
    critiqueRounds: 0,
  },
};

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-agent-dispatches-'));
  db = openDb(join(tmpDir, 'test.db'));
  repo = new AgentDispatchesRepo(db);
  const project = await new ProjectsRepo(db).create({
    name: 'Demo',
    originUrl: '',
    defaultBranch: 'main',
    repoPath: '/tmp/demo',
  });
  const workspaceRepo = new WorkspacesRepo(db);
  workspace = await workspaceRepo.create({
    projectId: project.id,
    name: 'child',
    branch: 'agent/child',
    baseBranch: 'main',
    harness: 'codex',
    status: 'idle',
  });
  runId = (
    await new AgentRunsRepo(db).create({
      projectId: project.id,
      sourceWorkspaceId: workspace.id,
      agentId: 'builtin:agent',
      snapshot,
      goal: 'test',
      allowPush: false,
      allowOpenPr: false,
    })
  ).id;
});

afterEach(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('AgentDispatchesRepo', () => {
  it('creates, claims, resumes, and lists dispatches in creation order', async () => {
    const first = await repo.create({
      runId,
      role: 'coder',
      purpose: 'implement',
      childAgentSlug: 'coder',
      harness: 'codex',
    });
    const second = await repo.create({
      runId,
      role: 'reviewer',
      purpose: 'review',
      childAgentSlug: 'reviewer',
      harness: 'claude_code',
      model: 'sonnet',
      parentDispatchId: first.id,
    });
    expect(first).toMatchObject({ status: 'pending', workspaceId: null });
    expect((await repo.list(runId)).map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);

    const turn = await new TurnsRepo(db).create({
      workspaceId: workspace.id,
      idx: 0,
      status: 'streaming',
    });
    const claimed = await repo.claim(first.id, workspace, {
      id: turn.id,
      sessionId: 'session-1',
    });
    expect(claimed).toMatchObject({
      status: 'running',
      workspaceId: workspace.id,
      branch: workspace.branch,
      turnId: turn.id,
      sessionId: 'session-1',
    });
    await repo.finish(first.id, 'completed', { summary: 'first generation' });
    const resumed = await repo.resume(first.id, { sessionId: 'session-1' });
    expect(resumed).toMatchObject({ status: 'running', turnId: turn.id });
  });

  it('persists Debby partner and per-round critique grouping as first-class metadata', async () => {
    const partner = await repo.create({
      runId,
      role: 'claude-partner',
      purpose: 'research',
      childAgentSlug: 'claude-partner',
      harness: 'claude_code',
      debateStage: 'partner',
      debateRound: 0,
    });
    const critique = await repo.create({
      runId,
      role: 'codex-critic',
      purpose: 'critique',
      childAgentSlug: 'codex-critic',
      harness: 'codex',
      debateStage: 'critique',
      debateRound: 2,
    });

    expect(await repo.get(partner.id)).toMatchObject({
      debateStage: 'partner',
      debateRound: 0,
    });
    expect(await repo.get(critique.id)).toMatchObject({
      debateStage: 'critique',
      debateRound: 2,
    });
    expect(await repo.list(runId)).toEqual([
      expect.objectContaining({
        id: partner.id,
        debateStage: 'partner',
        debateRound: 0,
      }),
      expect.objectContaining({
        id: critique.id,
        debateStage: 'critique',
        debateRound: 2,
      }),
    ]);
  });

  it('bounds changed-file metadata and makes terminal transitions idempotent', async () => {
    const dispatch = await repo.create({
      runId,
      role: 'coder',
      purpose: 'implement',
      childAgentSlug: 'coder',
      harness: 'codex',
    });
    const changedFiles = Array.from(
      { length: 600 },
      (_, index) => `src/${index}.ts`,
    );
    const completed = await repo.finish(dispatch.id, 'completed', {
      summary: 'done',
      changedFiles,
      diffStat: '500 files changed',
    });
    expect(completed.changedFiles).toHaveLength(500);
    const unchanged = await repo.finish(dispatch.id, 'failed', {
      error: 'late',
    });
    expect(unchanged).toMatchObject({
      status: 'completed',
      summary: 'done',
      error: null,
    });
    expect(unchanged.endedAt).toBe(completed.endedAt);
  });

  it('uses a durable CAS winner for concurrent terminal transitions', async () => {
    const dispatch = await repo.create({
      runId,
      role: 'coder',
      purpose: 'implement',
      childAgentSlug: 'coder',
      harness: 'codex',
    });
    const [completed, cancelled] = await Promise.all([
      repo.finish(dispatch.id, 'completed', { summary: 'done' }),
      repo.finish(dispatch.id, 'cancelled', { error: 'cancelled' }),
    ]);

    expect(completed).toEqual(cancelled);
    expect(await repo.get(dispatch.id)).toEqual(completed);
    expect(['completed', 'cancelled']).toContain(completed.status);
  });

  it('degrades corrupt optional changed-file metadata to an empty list', async () => {
    const dispatch = await repo.create({
      runId,
      role: 'coder',
      purpose: 'implement',
      childAgentSlug: 'coder',
      harness: 'codex',
    });
    await db
      .updateTable('agent_dispatches')
      .set({ changed_files_json: '{bad json' })
      .where('id', '=', dispatch.id)
      .execute();
    expect((await repo.get(dispatch.id)).changedFiles).toEqual([]);
  });

  it('atomically cancels only active dispatches during crash recovery', async () => {
    const pending = await repo.create({
      runId,
      role: 'coder',
      purpose: 'implement',
      childAgentSlug: 'coder',
      harness: 'codex',
    });
    const completed = await repo.create({
      runId,
      role: 'reviewer',
      purpose: 'review',
      childAgentSlug: 'reviewer',
      harness: 'claude_code',
    });
    await repo.finish(completed.id, 'completed', { summary: 'retained' });

    const recovered = await repo.interruptStale([runId]);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      id: pending.id,
      status: 'cancelled',
      error: 'application exited while the dispatch was active',
    });
    expect(await repo.get(completed.id)).toMatchObject({
      status: 'completed',
      summary: 'retained',
    });
    await expect(repo.interruptStale([runId])).resolves.toEqual([]);
    await expect(repo.interruptStale([])).resolves.toEqual([]);
  });

  it('enforces the run foreign key and typed status/purpose constraints', async () => {
    await expect(
      repo.create({
        runId: 'other-run',
        role: 'coder',
        purpose: 'implement',
        childAgentSlug: 'coder',
        harness: 'codex',
      }),
    ).rejects.toThrow();
  });
});
