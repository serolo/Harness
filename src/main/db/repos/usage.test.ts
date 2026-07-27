import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type AppDatabase } from '../index';
import { ProjectsRepo } from './projects';
import { WorkspacesRepo } from './workspaces';
import { TurnsRepo } from './turns';
import { UsageRepo } from './usage';

let tmpDir: string;
let db: AppDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-usage-'));
  db = openDb(join(tmpDir, 'test.db'));
});

afterEach(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const project = await new ProjectsRepo(db).create({
    name: 'demo',
    originUrl: '',
    defaultBranch: 'main',
    repoPath: '/tmp/demo',
  });
  return (
    await new WorkspacesRepo(db).create({
      projectId: project.id,
      name: 'usage',
      branch: 'agent/usage',
      baseBranch: 'main',
      harness: 'claude_code',
      status: 'idle',
    })
  ).id;
}

describe('UsageRepo.monthly', () => {
  it('groups priced turns and counts unknown and reverted turns correctly', async () => {
    const workspaceId = await workspace();
    const turns = new TurnsRepo(db);
    const startAt = new Date(2026, 6, 1).getTime();
    const priced = await turns.create({
      workspaceId,
      idx: 0,
      status: 'streaming',
      harness: 'claude_code',
      model: 'claude-sonnet-5-1m',
      startedAt: startAt + 1_000,
    });
    await turns.setStatus(priced.id, 'completed', {
      endedAt: startAt + 2_000,
      inputTokens: 1_000,
      cachedInputTokens: 200,
      outputTokens: 100,
      costMicros: 2_640,
      pricingKey: '2026-07-27:claude-sonnet-5-intro',
    });
    await turns.create({
      workspaceId,
      idx: 1,
      status: 'completed',
      startedAt: startAt + 3_000,
    });
    const reverted = await turns.create({
      workspaceId,
      idx: 2,
      status: 'completed',
      harness: 'claude_code',
      model: 'claude-sonnet-5-1m',
      startedAt: startAt + 4_000,
    });
    await turns.markRevertedAfter(workspaceId, 1);
    expect(reverted.idx).toBe(2);

    await expect(
      new UsageRepo(db).monthly(
        '2026-07',
        startAt,
        new Date(2026, 7, 1).getTime(),
      ),
    ).resolves.toMatchObject({
      month: '2026-07',
      totalCostMicros: 2_640,
      turns: 2,
      unpricedTurns: 1,
      models: [
        {
          model: 'claude-sonnet-5-1m',
          costMicros: 2_640,
          turns: 1,
        },
      ],
    });
  });
});
