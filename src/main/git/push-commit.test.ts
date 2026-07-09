// Integration tests for GitService.commit / GitService.push — real git in temp
// directories (mirrors index.test.ts / checkpoint-plumbing.test.ts). Written
// independently of the implementation, against the spec:
//   - commit(worktreePath, message): `git add -A` + `git commit -m <message>`
//     with a fixed committer identity; no-op-safe (typed error on a clean tree,
//     never an empty commit); returns the new HEAD sha.
//   - push(worktreePath, remote, branch, opts?): `git push [-u] <remote>
//     <branch>` — branch-only, never --all/--tags/--mirror.
//
// The heightened-scrutiny concern here is push: it must be impossible for a
// caller of `push()` to push more than the one named branch (in particular,
// the checkpoint refs under `refs/checkpoints/*` must never leak to a remote).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { AppError } from '@shared/errors';
import { GitService } from './index';

const git = new GitService();

/** Run a git command with a test identity so commits succeed (repo convention). */
async function g(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=test', ...args],
    { cwd },
  );
  return result.stdout.trim();
}

/** rev-parse a ref in an arbitrary (possibly bare) git dir, without throwing helpers. */
async function revParse(gitDir: string, ref: string): Promise<string> {
  const result = await execa('git', ['--git-dir', gitDir, 'rev-parse', ref]);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

describe('GitService.commit', () => {
  let tmpRoot: string;
  let wt: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'git-commit-test-'));
    wt = join(tmpRoot, 'repo');
    await execa('git', ['init', '-b', 'main', wt]);
    writeFileSync(join(wt, 'fileA.txt'), 'a\n');
    await g(wt, 'add', '.');
    await g(wt, 'commit', '-m', 'base commit');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('stages and commits a new file, returning the new HEAD sha', async () => {
    const headBefore = await g(wt, 'rev-parse', 'HEAD');
    writeFileSync(join(wt, 'new-file.txt'), 'brand new content\n');

    const { sha } = await git.commit(wt, 'add new-file.txt');

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).not.toBe(headBefore);

    const headAfter = await g(wt, 'rev-parse', 'HEAD');
    expect(sha).toBe(headAfter);

    // The new file must actually be staged+committed (not just present on disk).
    const show = await g(wt, 'show', '--stat', '--format=', 'HEAD');
    expect(show).toContain('new-file.txt');

    // git log confirms the commit message landed.
    const logMsg = await g(wt, 'log', '-1', '--format=%s');
    expect(logMsg).toBe('add new-file.txt');
  });

  it('stages and commits a modification to an existing tracked file', async () => {
    writeFileSync(join(wt, 'fileA.txt'), 'a modified\n');

    const { sha } = await git.commit(wt, 'modify fileA');

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const diffFromParent = await g(
      wt,
      'show',
      'HEAD',
      '--format=',
      '--',
      'fileA.txt',
    );
    expect(diffFromParent).toContain('a modified');
  });

  it("commits with a fixed, stable committer identity (not the caller's git config)", async () => {
    writeFileSync(join(wt, 'identity-check.txt'), 'x\n');
    await git.commit(wt, 'identity check');

    const committerName = await g(wt, 'log', '-1', '--format=%cn');
    const committerEmail = await g(wt, 'log', '-1', '--format=%ce');

    // The repo's own git config identity is "test <t@t.t>" (set via `-c` in the
    // `g()` helper above); GitService.commit must NOT depend on / fall through
    // to that config, but use its own fixed identity instead.
    expect(committerEmail).not.toBe('t@t.t');
    expect(committerName).toBeTruthy();
    expect(committerEmail).toBeTruthy();

    // Calling commit twice (from two different "callers") must produce the
    // same identity both times — proving it's fixed, not derived from ambient
    // per-call state.
    writeFileSync(join(wt, 'identity-check-2.txt'), 'y\n');
    await git.commit(wt, 'identity check 2');
    const committerEmail2 = await g(wt, 'log', '-1', '--format=%ce');
    expect(committerEmail2).toBe(committerEmail);
  });

  it('also commits a staged deletion', async () => {
    // fileA.txt exists from the base commit; delete it on disk (unstaged delete)
    // and rely on `commit`'s `git add -A` to stage the deletion.
    rmSync(join(wt, 'fileA.txt'));

    const { sha } = await git.commit(wt, 'delete fileA');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const lsTree = await g(wt, 'ls-tree', '-r', '--name-only', 'HEAD');
    expect(lsTree).not.toContain('fileA.txt');
  });

  it('rejects with a typed AppError on a clean worktree (no-op-safe)', async () => {
    // No changes since the base commit — worktree is clean.
    const headBefore = await g(wt, 'rev-parse', 'HEAD');

    await expect(git.commit(wt, 'nothing to see here')).rejects.toThrow();

    let caught: unknown;
    try {
      await git.commit(wt, 'nothing to see here');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('git');
    expect((caught as AppError).message).toMatch(/nothing to commit/i);

    // Crucially: no empty commit was created — HEAD must not have moved.
    const headAfter = await g(wt, 'rev-parse', 'HEAD');
    expect(headAfter).toBe(headBefore);

    const logCountBefore = (await g(wt, 'log', '--oneline')).split('\n').length;
    expect(logCountBefore).toBe(1); // still just the base commit
  });

  it('currentBranch reflects the checked-out branch', async () => {
    const branch = await git.currentBranch(wt);
    expect(branch).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

describe('GitService.push', () => {
  let tmpRoot: string;
  let wt: string; // the worktree/repo we push FROM
  let bareOrigin: string; // the bare repo acting as `origin`

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'git-push-test-'));
    wt = join(tmpRoot, 'repo');
    bareOrigin = join(tmpRoot, 'origin.git');

    await execa('git', ['init', '-b', 'main', wt]);
    writeFileSync(join(wt, 'fileA.txt'), 'a\n');
    await g(wt, 'add', '.');
    await g(wt, 'commit', '-m', 'base commit');

    // Give the worktree its own feature branch to push, distinct from `main`,
    // so we can be sure `push()` pushes exactly the named branch.
    await g(wt, 'checkout', '-b', 'feature/x');
    writeFileSync(join(wt, 'feature.txt'), 'feature work\n');
    await g(wt, 'add', '.');
    await g(wt, 'commit', '-m', 'feature commit');

    await execa('git', ['init', '--bare', '-b', 'main', bareOrigin]);
    await g(wt, 'remote', 'add', 'origin', bareOrigin);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('pushes the named branch to origin and the bare repo receives exactly that ref', async () => {
    const headSha = await g(wt, 'rev-parse', 'HEAD');

    await git.push(wt, 'origin', 'feature/x', { setUpstream: true });

    const remoteSha = await revParse(bareOrigin, 'refs/heads/feature/x');
    expect(remoteSha).toBe(headSha);
  });

  it('sets the upstream tracking branch when setUpstream is true', async () => {
    await git.push(wt, 'origin', 'feature/x', { setUpstream: true });

    const upstream = await g(
      wt,
      'rev-parse',
      '--abbrev-ref',
      'feature/x@{upstream}',
    );
    expect(upstream).toBe('origin/feature/x');
  });

  it('is branch-only: a local refs/checkpoints/* ref never propagates to origin', async () => {
    const headSha = await g(wt, 'rev-parse', 'HEAD');
    // Simulate a checkpoint ref living alongside the branch (spec §5.4 plumbing).
    await g(wt, 'update-ref', 'refs/checkpoints/x/0', 'HEAD');

    await git.push(wt, 'origin', 'feature/x', { setUpstream: true });

    // The branch itself must have made it across...
    const remoteBranchSha = await revParse(bareOrigin, 'refs/heads/feature/x');
    expect(remoteBranchSha).toBe(headSha);

    // ...but the checkpoint ref must NOT — proving push is scoped to the one
    // branch and never uses --all / --mirror / --tags-style "push everything".
    await expect(
      revParse(bareOrigin, 'refs/checkpoints/x/0'),
    ).rejects.toThrow();
  });

  it('is branch-only: other local branches never propagate to origin', async () => {
    // `main` exists locally (it's the initial branch) but was never pushed.
    await git.push(wt, 'origin', 'feature/x', { setUpstream: true });

    await expect(revParse(bareOrigin, 'refs/heads/main')).rejects.toThrow();
  });

  it('pushing again after a new commit fast-forwards the remote branch', async () => {
    await git.push(wt, 'origin', 'feature/x', { setUpstream: true });

    writeFileSync(join(wt, 'feature2.txt'), 'more feature work\n');
    await g(wt, 'add', '.');
    await g(wt, 'commit', '-m', 'second feature commit');
    const headSha = await g(wt, 'rev-parse', 'HEAD');

    await git.push(wt, 'origin', 'feature/x');

    const remoteSha = await revParse(bareOrigin, 'refs/heads/feature/x');
    expect(remoteSha).toBe(headSha);
  });

  it('rejects with a typed AppError when the remote is unreachable', async () => {
    await g(wt, 'remote', 'remove', 'origin');
    await g(
      wt,
      'remote',
      'add',
      'origin',
      '/absolutely/nonexistent/bare/repo.git',
    );

    let caught: unknown;
    try {
      await git.push(wt, 'origin', 'feature/x', { setUpstream: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('git');
  });

  it('hasUpstream is false before the first push and true after', async () => {
    expect(await git.hasUpstream(wt)).toBe(false);
    await git.push(wt, 'origin', 'feature/x', { setUpstream: true });
    expect(await git.hasUpstream(wt)).toBe(true);
  });
});
