// Integration tests for GitService Phase-4 checkpoint plumbing:
// commitTree (scratch-index snapshot) + updateRef + resetHard (non-branch-moving
// revert). Real git in a temp directory (mirrors index.test.ts). The load-bearing
// invariants here are: the branch/HEAD is NEVER moved, the real index is NEVER
// touched, and revert deletes files added after the target without `git clean`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { AppError } from '@shared/errors';
import { GitService } from './index';

const git = new GitService();

async function g(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=test', ...args],
    { cwd },
  );
  return result.stdout.trim();
}

describe('GitService checkpoint plumbing', () => {
  let tmpRoot: string;
  let wt: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'git-cp-test-'));
    wt = join(tmpRoot, 'repo');
    await execa('git', ['init', '-b', 'main', wt]);
    writeFileSync(join(wt, 'fileA.txt'), 'a\n');
    await g(wt, 'add', '.');
    await g(wt, 'commit', '-m', 'base commit');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // commitTree
  // -------------------------------------------------------------------------

  it('commitTree returns a reachable commit SHA without moving HEAD', async () => {
    const headBefore = await g(wt, 'rev-parse', 'HEAD');
    // Uncommitted change captured by the snapshot.
    writeFileSync(join(wt, 'fileA.txt'), 'a modified\n');

    const sha = await git.commitTree(wt, 'checkpoint');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // The object exists and is a commit.
    const type = await g(wt, 'cat-file', '-t', sha);
    expect(type).toBe('commit');

    // HEAD/branch is unchanged — commit-tree does not update any ref.
    const headAfter = await g(wt, 'rev-parse', 'HEAD');
    expect(headAfter).toBe(headBefore);

    // The snapshot tree captured the uncommitted edit.
    const snapshot = await g(wt, 'show', `${sha}:fileA.txt`);
    expect(snapshot).toBe('a modified');
  });

  it('commitTree does not touch the real index', async () => {
    // Stage nothing; leave an unstaged change.
    writeFileSync(join(wt, 'fileA.txt'), 'a dirty\n');
    const statusBefore = await g(wt, 'status', '--porcelain=v1');

    await git.commitTree(wt, 'snapshot');

    const statusAfter = await g(wt, 'status', '--porcelain=v1');
    expect(statusAfter).toBe(statusBefore);
  });

  it('commitTree threads parents via -p', async () => {
    const parent = await g(wt, 'rev-parse', 'HEAD');
    const sha = await git.commitTree(wt, 'child', [parent]);

    // `rev-list --parents -n 1` prints "<sha> <parent...>".
    const line = await g(wt, 'rev-list', '--parents', '-n', '1', sha);
    const parents = line.split(/\s+/).slice(1);
    expect(parents).toContain(parent);
  });

  // -------------------------------------------------------------------------
  // updateRef
  // -------------------------------------------------------------------------

  it('updateRef points a refs/ name at a SHA', async () => {
    const sha = await git.commitTree(wt, 'cp');
    await git.updateRef(wt, 'refs/checkpoints/x/0', sha);
    const resolved = await g(wt, 'rev-parse', 'refs/checkpoints/x/0');
    expect(resolved).toBe(sha);
  });

  it('updateRef rejects a name outside refs/', async () => {
    const sha = await git.commitTree(wt, 'cp');
    await expect(git.updateRef(wt, 'main', sha)).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(git.updateRef(wt, 'HEAD', sha)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  // -------------------------------------------------------------------------
  // resetHard (revert)
  // -------------------------------------------------------------------------

  it('resetHard restores the worktree to a snapshot without moving the branch', async () => {
    // 1. Snapshot the current worktree (fileA = "a").
    const cpSha = await git.commitTree(wt, 'snapshot');

    // 2. Add + commit a new file (HEAD moves forward).
    writeFileSync(join(wt, 'fileB.txt'), 'b\n');
    await g(wt, 'add', 'fileB.txt');
    await g(wt, 'commit', '-m', 'add fileB');
    const headAfterCommit = await g(wt, 'rev-parse', 'HEAD');

    // 3. More uncommitted edits on top.
    writeFileSync(join(wt, 'fileA.txt'), 'a changed after snapshot\n');

    // Revert to the snapshot.
    await git.resetHard(wt, cpSha);

    // fileA reverted to the snapshot content.
    expect(readFileSync(join(wt, 'fileA.txt'), 'utf8')).toBe('a\n');
    // fileB was added after the snapshot → deleted from the worktree.
    expect(existsSync(join(wt, 'fileB.txt'))).toBe(false);
    // HEAD/branch is unchanged (no reset --hard, no branch move).
    expect(await g(wt, 'rev-parse', 'HEAD')).toBe(headAfterCommit);
    expect(await g(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('resetHard re-creates a file that was deleted after the snapshot', async () => {
    const cpSha = await git.commitTree(wt, 'snapshot');
    // Delete a tracked file after the snapshot.
    rmSync(join(wt, 'fileA.txt'));

    await git.resetHard(wt, cpSha);

    expect(existsSync(join(wt, 'fileA.txt'))).toBe(true);
    expect(readFileSync(join(wt, 'fileA.txt'), 'utf8')).toBe('a\n');
  });

  it('resetHard is safe to run twice (idempotent)', async () => {
    const cpSha = await git.commitTree(wt, 'snapshot');
    writeFileSync(join(wt, 'fileB.txt'), 'b\n');
    await g(wt, 'add', 'fileB.txt');
    await g(wt, 'commit', '-m', 'add fileB');

    await git.resetHard(wt, cpSha);
    await git.resetHard(wt, cpSha); // second revert must not throw

    expect(existsSync(join(wt, 'fileB.txt'))).toBe(false);
    expect(readFileSync(join(wt, 'fileA.txt'), 'utf8')).toBe('a\n');
  });
});
