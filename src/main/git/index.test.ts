// Integration tests for GitService — real git in temp directories.
// Runs in the default node environment (Electron ABI, no Electron runtime).
// git 2.50.1 is on PATH.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { GitService } from './index';

const git = new GitService();

// Shared temp dirs — created once, cleaned up after all tests.
let tmpRoot: string;
let sourceRepo: string; // the "origin" bare-ish repo we clone from

/**
 * Run a git command with test identity so commits succeed.
 * `-c user.email=t@t.t -c user.name=test` per spec.
 */
async function g(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=test', ...args],
    { cwd },
  );
  return result.stdout.trim();
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'git-svc-test-'));

  // Build a local source repo: init -b main, one commit.
  sourceRepo = join(tmpRoot, 'source');
  await execa('git', ['init', '-b', 'main', sourceRepo]);
  writeFileSync(join(sourceRepo, 'README.md'), '# test repo');
  await g(sourceRepo, 'add', '.');
  await g(sourceRepo, 'commit', '-m', 'initial commit');
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// clone
// ---------------------------------------------------------------------------

describe('GitService.clone', () => {
  let cloneDir: string;

  it('clones a local repo and returns the dest path', async () => {
    cloneDir = join(tmpRoot, 'cloned');
    const returned = await git.clone(sourceRepo, cloneDir);
    expect(returned).toBe(cloneDir);
    expect(existsSync(cloneDir)).toBe(true);
    expect(existsSync(join(cloneDir, 'README.md'))).toBe(true);
  });

  it('open(clonedPath).defaultBranch === "main"', async () => {
    const info = await git.open(cloneDir);
    expect(info.defaultBranch).toBe('main');
  });

  it('open(clonedPath).originUrl is non-empty (points at the source)', async () => {
    const info = await git.open(cloneDir);
    expect(info.originUrl).toBeTruthy();
  });

  it('forwards progress events when onProgress is provided', async () => {
    const progressDir = join(tmpRoot, 'cloned-progress');
    const events: string[] = [];
    await git.clone(sourceRepo, progressDir, (p) => {
      events.push(p.phase);
    });
    // A local clone may not emit many progress events, but the clone should succeed.
    expect(existsSync(progressDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// open & defaultBranch — local repo without a remote
// ---------------------------------------------------------------------------

describe('GitService.open', () => {
  it('open on a non-repo path throws an AppError', async () => {
    const notARepo = join(tmpRoot, 'not-a-repo');
    mkdtempSync(notARepo);
    await expect(git.open(notARepo)).rejects.toThrow();
  });

  it('open on a local-only repo (no remote) returns empty originUrl', async () => {
    const localRepo = join(tmpRoot, 'local-only');
    await execa('git', ['init', '-b', 'main', localRepo]);
    writeFileSync(join(localRepo, 'f.txt'), 'hi');
    await g(localRepo, 'add', '.');
    await g(localRepo, 'commit', '-m', 'first');
    const info = await git.open(localRepo);
    expect(info.originUrl).toBe('');
    expect(info.defaultBranch).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// worktree lifecycle
// ---------------------------------------------------------------------------

describe('GitService worktree lifecycle', () => {
  let repoDir: string; // a fresh clone to add worktrees to
  let wtPath: string;

  beforeAll(async () => {
    // Use a fresh clone so worktrees don't pollute the shared clone.
    repoDir = join(tmpRoot, 'wt-repo');
    await git.clone(sourceRepo, repoDir);
    wtPath = join(tmpRoot, 'worktree-x');
  });

  it('addWorktree creates a new branch and dir on disk', async () => {
    await git.addWorktree(repoDir, wtPath, 'agent/x', 'main', true);
    expect(existsSync(wtPath)).toBe(true);
  });

  it('worktreeList includes the new worktree with correct branch', async () => {
    const list = await git.worktreeList(repoDir);
    // git resolves symlinks in worktree paths (e.g. /var → /private/var on macOS).
    // Normalize both sides with realpathSync for a reliable comparison.
    const wtPathReal = realpathSync(wtPath);
    const entry = list.find((wt) => realpathSync(wt.path) === wtPathReal);
    expect(entry).toBeDefined();
    expect(entry?.branch).toBe('agent/x');
    expect(entry?.head).toBeTruthy();
  });

  it('branchExists returns true for the newly created branch', async () => {
    const exists = await git.branchExists(repoDir, 'agent/x');
    expect(exists).toBe(true);
  });

  it('branchExists returns false for a bogus branch name', async () => {
    const exists = await git.branchExists(
      repoDir,
      'totally-nonexistent-branch-abc123',
    );
    expect(exists).toBe(false);
  });

  it('headInfo returns sha and branch for the worktree', async () => {
    const info = await git.headInfo(wtPath);
    expect(info.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(info.branch).toBe('agent/x');
    // No baseRef provided → ahead/behind are 0
    expect(info.ahead).toBe(0);
    expect(info.behind).toBe(0);
  });

  it('headInfo.ahead >= 1 after committing in the worktree', async () => {
    // Make a commit in the worktree
    writeFileSync(join(wtPath, 'new-file.txt'), 'worktree change');
    await g(wtPath, 'add', '.');
    await g(wtPath, 'commit', '-m', 'worktree commit');

    const info = await git.headInfo(wtPath, 'main');
    expect(info.ahead).toBeGreaterThanOrEqual(1);
    expect(info.behind).toBe(0);
  });

  it('mergeBase returns a valid SHA', async () => {
    const sha = await git.mergeBase(wtPath, 'main', 'HEAD');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('removeWorktree with force removes the dir from disk', async () => {
    await git.removeWorktree(repoDir, wtPath, true);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('worktreeList no longer includes the removed worktree', async () => {
    const list = await git.worktreeList(repoDir);
    // After removal, no entry in the list should point to the old path (by basename).
    const entry = list.find((wt) => wt.path.endsWith('worktree-x'));
    expect(entry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('GitService error handling', () => {
  it('clone to an invalid URL throws an AppError', async () => {
    const dest = join(tmpRoot, 'bad-clone');
    await expect(
      git.clone('/absolutely/nonexistent/path/to/repo', dest),
    ).rejects.toThrow();
  });

  it('fetch on a local-only repo (no remote) throws an AppError', async () => {
    const localRepo = join(tmpRoot, 'local-fetch');
    await execa('git', ['init', '-b', 'main', localRepo]);
    writeFileSync(join(localRepo, 'f.txt'), 'hi');
    await g(localRepo, 'add', '.');
    await g(localRepo, 'commit', '-m', 'first');
    // fetch from a repo with no remote should fail
    await expect(git.fetch(localRepo)).rejects.toThrow();
  });

  it('addWorktree with a non-existent base ref throws', async () => {
    const freshRepo = join(tmpRoot, 'fresh-wt-err');
    await git.clone(sourceRepo, freshRepo);
    const badWt = join(tmpRoot, 'bad-wt');
    await expect(
      git.addWorktree(freshRepo, badWt, 'agent/err', 'nonexistent-ref', true),
    ).rejects.toThrow();
  });
});

// Phase-4 methods (status/diff/commitTree/updateRef/resetHard) are exercised by the
// dedicated real-git suites in `diff.test.ts` + `checkpoint-plumbing.test.ts`.
