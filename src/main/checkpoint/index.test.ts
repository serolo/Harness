// Integration tests for CheckpointService — real git in a temp repo + a real
// temp SQLite DB (Phase 4, destructive-worktree heightened-scrutiny path).
//
// Written by an independent test author against the two load-bearing invariants
// documented in src/main/checkpoint/index.ts:
//   1. snapshot() NEVER moves HEAD/branch — only commit-tree + update-ref.
//   2. revert() auto-backs-up the CURRENT worktree FIRST, then resets — and is
//      idempotent to call twice.
//
// These are exercised against the real `git` binary and a real GitService, not
// mocks, because the whole point of the invariants is what actually lands in
// .git/refs and on disk.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { openDb, type AppDatabase } from '../db';
import { ProjectsRepo } from '../db/repos/projects';
import { WorkspacesRepo } from '../db/repos/workspaces';
import { TurnsRepo } from '../db/repos/turns';
import { CheckpointsRepo } from '../db/repos/checkpoints';
import { GitService } from '../git';
import { CheckpointService } from './index';
import { type AppError } from '@shared/errors';
import type { Workspace } from '@shared/models';

/** Run a git command with a fixed test identity so commits succeed. */
async function g(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=test', ...args],
    { cwd },
  );
  return result.stdout.trim();
}

let tmpDir: string;
let repoDir: string;
let dbFile: string;
let db: AppDatabase;
let git: GitService;
let checkpoints: CheckpointsRepo;
let turns: TurnsRepo;
let service: CheckpointService;
let workspace: Workspace;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'checkpoint-svc-test-'));
  repoDir = join(tmpDir, 'repo');

  // Real git repo, one base commit on main.
  await execa('git', ['init', '-b', 'main', repoDir]);
  writeFileSync(join(repoDir, 'README.md'), '# base\n');
  await g(repoDir, 'add', '.');
  await g(repoDir, 'commit', '-m', 'base commit');

  // Real temp SQLite DB with FK parents seeded (projects -> workspaces -> turns).
  dbFile = join(tmpDir, 'test.db');
  db = openDb(dbFile);

  const project = await new ProjectsRepo(db).create({
    name: 'demo',
    originUrl: 'git@github.com:acme/demo.git',
    defaultBranch: 'main',
    repoPath: repoDir,
  });
  workspace = await new WorkspacesRepo(db).create({
    projectId: project.id,
    name: 'paris',
    branch: 'agent/paris',
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'working',
    worktreePath: repoDir,
  });

  git = new GitService();
  checkpoints = new CheckpointsRepo(db);
  turns = new TurnsRepo(db);

  service = new CheckpointService({
    git,
    getWorkspace: async (id: string) =>
      id === workspace.id ? workspace : null,
    checkpoints,
    turns,
  });
});

afterEach(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CheckpointService.snapshot', () => {
  it('creates a real commit + ref and leaves HEAD/branch unchanged', async () => {
    const turn0 = await turns.create({
      workspaceId: workspace.id,
      idx: 0,
      status: 'completed',
    });

    const headBefore = await g(repoDir, 'rev-parse', 'HEAD');
    const branchBefore = await g(repoDir, 'symbolic-ref', 'HEAD');

    const checkpoint = await service.snapshot(workspace.id, turn0.id);

    expect(checkpoint.refName).toBe(`refs/checkpoints/${workspace.id}/0`);
    // The sha is a real, reachable commit object...
    const objType = await g(repoDir, 'cat-file', '-t', checkpoint.sha);
    expect(objType).toBe('commit');
    // ...and the ref actually points at it.
    const refSha = await g(
      repoDir,
      'rev-parse',
      `refs/checkpoints/${workspace.id}/0`,
    );
    expect(refSha).toBe(checkpoint.sha);

    // HEAD and the branch must not have moved.
    expect(await g(repoDir, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await g(repoDir, 'symbolic-ref', 'HEAD')).toBe(branchBefore);
  });

  it('the checkpoint commit is not reachable from the branch (ref-only)', async () => {
    const turn0 = await turns.create({
      workspaceId: workspace.id,
      idx: 0,
      status: 'completed',
    });
    const headBefore = await g(repoDir, 'rev-parse', 'HEAD');

    const checkpoint = await service.snapshot(workspace.id, turn0.id);

    // HEAD itself never moved (strongest form of the invariant)...
    expect(await g(repoDir, 'rev-parse', 'HEAD')).toBe(headBefore);
    // ...and merge-base --is-ancestor confirms the checkpoint commit is not an
    // ancestor of HEAD (it hangs off refs/checkpoints/*, not the branch).
    await expect(
      execa('git', [
        '-C',
        repoDir,
        'merge-base',
        '--is-ancestor',
        checkpoint.sha,
        'HEAD',
      ]),
    ).rejects.toThrow();
  });

  it('chains: a later checkpoint has the previous checkpoint as its first parent', async () => {
    const turn0 = await turns.create({
      workspaceId: workspace.id,
      idx: 0,
      status: 'completed',
    });
    const checkpoint0 = await service.snapshot(workspace.id, turn0.id);

    // Advance the worktree (a real commit on the branch, as an agent turn would).
    writeFileSync(join(repoDir, 'b.txt'), 'state B\n');
    await g(repoDir, 'add', '.');
    await g(repoDir, 'commit', '-m', 'add b');

    const turn1 = await turns.create({
      workspaceId: workspace.id,
      idx: 1,
      status: 'completed',
    });
    const checkpoint1 = await service.snapshot(workspace.id, turn1.id);

    const parentsLine = await g(
      repoDir,
      'rev-list',
      '--parents',
      '-n1',
      checkpoint1.sha,
    );
    const parents = parentsLine.split(' ').slice(1);
    expect(parents).toContain(checkpoint0.sha);
  });
});

describe('CheckpointService.list', () => {
  it('returns checkpoints ordered and excludes backup refs', async () => {
    const turn0 = await turns.create({
      workspaceId: workspace.id,
      idx: 0,
      status: 'completed',
    });
    await service.snapshot(workspace.id, turn0.id);

    writeFileSync(join(repoDir, 'b.txt'), 'state B\n');
    await g(repoDir, 'add', '.');
    await g(repoDir, 'commit', '-m', 'add b');

    const turn1 = await turns.create({
      workspaceId: workspace.id,
      idx: 1,
      status: 'completed',
    });
    await service.snapshot(workspace.id, turn1.id);

    // Trigger a revert, which creates a backup ref/row behind the scenes.
    await service.revert(workspace.id, 0);

    const list = await service.list(workspace.id);
    expect(list.map((c) => c.refName)).toEqual([
      `refs/checkpoints/${workspace.id}/0`,
      `refs/checkpoints/${workspace.id}/1`,
    ]);
    expect(list.some((c) => c.refName.includes('/backup/'))).toBe(false);
  });
});

describe('CheckpointService.revert', () => {
  it('restores the worktree, auto-backs-up first, leaves HEAD unmoved, and marks later turns reverted', async () => {
    const turn0 = await turns.create({
      workspaceId: workspace.id,
      idx: 0,
      status: 'completed',
    });
    await service.snapshot(workspace.id, turn0.id); // state A checkpoint

    writeFileSync(join(repoDir, 'b.txt'), 'state B\n');
    await g(repoDir, 'add', '.');
    await g(repoDir, 'commit', '-m', 'add b'); // state B on the branch

    const turn1 = await turns.create({
      workspaceId: workspace.id,
      idx: 1,
      status: 'completed',
    });
    await service.snapshot(workspace.id, turn1.id); // state B checkpoint

    const headBefore = await g(repoDir, 'rev-parse', 'HEAD');
    const branchBefore = await g(repoDir, 'symbolic-ref', 'HEAD');

    await service.revert(workspace.id, 0);

    // (a) worktree matches state A: b.txt is gone.
    expect(existsSync(join(repoDir, 'b.txt'))).toBe(false);
    expect(existsSync(join(repoDir, 'README.md'))).toBe(true);

    // (b) an auto-backup ref now exists.
    const backupRefs = await g(
      repoDir,
      'for-each-ref',
      `refs/checkpoints/${workspace.id}/backup`,
    );
    expect(backupRefs.length).toBeGreaterThan(0);

    // (c) HEAD/branch did not move.
    expect(await g(repoDir, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await g(repoDir, 'symbolic-ref', 'HEAD')).toBe(branchBefore);

    // (d) turn 1 is dropped from history, turn 0 remains.
    const remaining = await turns.listByWorkspace(workspace.id);
    const remainingIdx = remaining.map((t) => t.idx);
    expect(remainingIdx).toContain(0);
    expect(remainingIdx).not.toContain(1);
  });

  it('reverting twice is safe and leaves the worktree at the same restored state', async () => {
    const turn0 = await turns.create({
      workspaceId: workspace.id,
      idx: 0,
      status: 'completed',
    });
    await service.snapshot(workspace.id, turn0.id);

    writeFileSync(join(repoDir, 'b.txt'), 'state B\n');
    await g(repoDir, 'add', '.');
    await g(repoDir, 'commit', '-m', 'add b');

    const turn1 = await turns.create({
      workspaceId: workspace.id,
      idx: 1,
      status: 'completed',
    });
    await service.snapshot(workspace.id, turn1.id);

    await service.revert(workspace.id, 0);
    expect(existsSync(join(repoDir, 'b.txt'))).toBe(false);

    await expect(service.revert(workspace.id, 0)).resolves.not.toThrow();
    expect(existsSync(join(repoDir, 'b.txt'))).toBe(false);
    expect(existsSync(join(repoDir, 'README.md'))).toBe(true);
  });

  it('throws AppError("not_found") when reverting to a non-existent checkpoint', async () => {
    await expect(service.revert(workspace.id, 99)).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<AppError>);
  });

  it('a failed revert (missing target) is a true no-op: no stray backup ref, no DB row', async () => {
    // revert() validates the target checkpoint FIRST, so a revert to a turnIdx with
    // no checkpoint throws `not_found` WITHOUT taking a backup — nothing on disk or in
    // the DB changes. This guards against orphan `refs/checkpoints/<ws>/backup/*` refs
    // accumulating on bad turnIdx values (e.g. a UI retry loop).
    const refsBefore = await g(
      repoDir,
      'for-each-ref',
      `refs/checkpoints/${workspace.id}/backup`,
    );
    expect(refsBefore).toBe('');

    await expect(service.revert(workspace.id, 99)).rejects.toMatchObject({
      code: 'not_found',
    });

    const refsAfter = await g(
      repoDir,
      'for-each-ref',
      `refs/checkpoints/${workspace.id}/backup`,
    );
    // No backup ref was created — the failed revert touched nothing.
    expect(refsAfter).toBe('');

    // And no backup DB row exists either.
    const allRows = await checkpoints.list(workspace.id);
    expect(allRows.some((c) => c.refName.includes('/backup/'))).toBe(false);
  });
});
