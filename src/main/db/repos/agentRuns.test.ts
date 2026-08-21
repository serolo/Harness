import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NormalizedAgentSnapshot } from '@shared/agents';
import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from './projects';
import { WorkspacesRepo } from './workspaces';
import { AgentRunsRepo, snapshotDigest } from './agentRuns';

let tmpDir: string;
let db: AppDatabase;
let repo: AgentRunsRepo;
let projectId: string;
let workspaceId: string;

const snapshot: NormalizedAgentSnapshot = {
  schemaVersion: 1,
  slug: 'coordinator',
  name: 'Coordinator',
  description: 'Test',
  revision: 'revision-1',
  prompt: 'Coordinate.',
  coordinator: { harness: 'claude_code', mode: 'plan' },
  roles: [],
  skills: [],
  capabilities: ['delegate'],
  requiredProviders: ['claude_code'],
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
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-agent-runs-'));
  db = openDb(join(tmpDir, 'test.db'));
  repo = new AgentRunsRepo(db);
  const project = await new ProjectsRepo(db).create({
    name: 'Demo',
    originUrl: '',
    defaultBranch: 'main',
    repoPath: '/tmp/demo',
  });
  projectId = project.id;
  workspaceId = (
    await new WorkspacesRepo(db).create({
      projectId,
      name: 'source',
      branch: 'main',
      baseBranch: 'main',
      harness: 'claude_code',
      status: 'idle',
    })
  ).id;
});

afterEach(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createRun(goal = 'Do the work') {
  return repo.create({
    projectId,
    sourceWorkspaceId: workspaceId,
    agentId: 'builtin:coordinator',
    snapshot,
    goal,
    allowPush: false,
    allowOpenPr: false,
  });
}

describe('AgentRunsRepo', () => {
  it('persists immutable identity, consent, and the exact validated snapshot', async () => {
    const run = await repo.create({
      projectId,
      sourceWorkspaceId: workspaceId,
      agentId: 'builtin:coordinator',
      snapshot: { ...snapshot, protocol: 'debby' },
      goal: 'Ship safely',
      allowPush: true,
      allowOpenPr: false,
    });

    expect(run).toMatchObject({
      projectId,
      sourceWorkspaceId: workspaceId,
      agentId: 'builtin:coordinator',
      agentName: 'Coordinator',
      agentRevision: 'revision-1',
      goal: 'Ship safely',
      status: 'starting',
      allowPush: true,
      allowOpenPr: false,
      agentProtocol: 'debby',
    });
    expect(await repo.snapshot(run.id)).toEqual({
      ...snapshot,
      protocol: 'debby',
    });
  });

  it('detects snapshot tampering and unsupported stored schema versions', async () => {
    const run = await createRun();
    await db
      .updateTable('agent_runs')
      .set({ snapshot_json: JSON.stringify({ ...snapshot, name: 'Tampered' }) })
      .where('id', '=', run.id)
      .execute();
    await expect(repo.snapshot(run.id)).rejects.toMatchObject({
      code: 'internal',
    });

    const second = await createRun('second');
    const unsupported = JSON.stringify({ ...snapshot, schemaVersion: 99 });
    await db
      .updateTable('agent_runs')
      .set({
        snapshot_json: unsupported,
        snapshot_digest: snapshotDigest(unsupported),
      })
      .where('id', '=', second.id)
      .execute();
    await expect(repo.snapshot(second.id)).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it.each([
    ['unknown coordinator key', { ...snapshot.coordinator, shell: true }],
    [
      'invalid nested read-only type',
      { ...snapshot.coordinator, readOnlyMode: 'yes' },
    ],
  ])('rejects a digest-valid snapshot with %s', async (_label, coordinator) => {
    const run = await createRun(String(_label));
    const malformed = JSON.stringify({ ...snapshot, coordinator });
    await db
      .updateTable('agent_runs')
      .set({
        snapshot_json: malformed,
        snapshot_digest: snapshotDigest(malformed),
      })
      .where('id', '=', run.id)
      .execute();

    await expect(repo.snapshot(run.id)).rejects.toMatchObject({
      code: 'internal',
      message: 'stored agent snapshot schema is invalid',
    });
  });

  it('rejects digest-valid snapshots with invalid roles, skills, capabilities, providers, or policy', async () => {
    const malformedSnapshots: unknown[] = [
      {
        ...snapshot,
        roles: [
          {
            slug: 'reviewer',
            name: 'Reviewer',
            prompt: 'Review',
            executor: { harness: 'codex', mode: 'default' },
            purposes: ['not-a-purpose'],
          },
        ],
      },
      { ...snapshot, skills: [{ slug: 'skill', content: '', path: '/tmp/x' }] },
      { ...snapshot, capabilities: ['delegate', 'shell'] },
      { ...snapshot, requiredProviders: ['arbitrary-provider'] },
      { ...snapshot, policy: { ...snapshot.policy, maxDepth: 2 } },
    ];

    for (const [index, malformedSnapshot] of malformedSnapshots.entries()) {
      const run = await createRun(`malformed-${index}`);
      const malformed = JSON.stringify(malformedSnapshot);
      await db
        .updateTable('agent_runs')
        .set({
          snapshot_json: malformed,
          snapshot_digest: snapshotDigest(malformed),
        })
        .where('id', '=', run.id)
        .execute();
      await expect(repo.snapshot(run.id)).rejects.toMatchObject({
        code: 'internal',
      });
    }
  });

  it('moves through running to a terminal state exactly once', async () => {
    const run = await createRun();
    await repo.setCoordinator(run.id, workspaceId);
    expect(await repo.get(run.id)).toMatchObject({
      coordinatorWorkspaceId: workspaceId,
      status: 'running',
    });

    const completed = await repo.transition(run.id, 'completed', {
      summary: 'done',
      skillUsage: {
        reported: true,
        skills: [{ slug: 'guide', digest: 'a'.repeat(64) }],
      },
    });
    const unchanged = await repo.transition(run.id, 'failed', {
      error: 'late failure',
    });
    expect(completed).toMatchObject({
      status: 'completed',
      finalSummary: 'done',
      coordinatorSkillUsage: {
        reported: true,
        skills: [{ slug: 'guide', digest: 'a'.repeat(64) }],
      },
    });
    expect(unchanged).toMatchObject({
      status: 'completed',
      finalSummary: 'done',
      error: null,
    });
    expect(unchanged.endedAt).toBe(completed.endedAt);
  });

  it('uses a durable CAS winner for concurrent terminal transitions', async () => {
    const run = await createRun();
    await repo.setCoordinator(run.id, workspaceId);

    const [completed, failed] = await Promise.all([
      repo.transition(run.id, 'completed', { summary: 'winner summary' }),
      repo.transition(run.id, 'failed', { error: 'racing failure' }),
    ]);

    expect(completed.status).toBe(failed.status);
    expect(await repo.get(run.id)).toEqual(completed);
    expect(['completed', 'failed']).toContain(completed.status);
  });

  it('interrupts only stale active runs and leaves terminal history unchanged', async () => {
    const starting = await createRun('starting');
    const running = await createRun('running');
    await repo.setCoordinator(running.id, workspaceId);
    const done = await createRun('done');
    await repo.transition(done.id, 'completed');

    expect((await repo.interruptStale()).map((run) => run.id).sort()).toEqual(
      [starting.id, running.id].sort(),
    );
    expect(await repo.get(done.id)).toMatchObject({
      status: 'completed',
      error: null,
    });
    expect(await repo.interruptStale()).toEqual([]);
  });
});
