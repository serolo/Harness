// Integration tests for GitService Phase-4 diff/status + the unified-hunk parser.
// Real git in a temp directory (mirrors index.test.ts). Runs in the default node
// environment (Electron ABI, no Electron runtime); git is on PATH.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { GitService, parseUnifiedHunks } from './index';

const git = new GitService();

// Run a git command with a test identity so commits succeed (mirrors index.test.ts).
async function g(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=test', ...args],
    { cwd },
  );
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// diff + status against a base commit
// ---------------------------------------------------------------------------

describe('GitService.diff / status', () => {
  let tmpRoot: string;
  let wt: string; // the worktree/repo under test
  let baseSha: string; // HEAD after the base commit

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'git-diff-test-'));
    wt = join(tmpRoot, 'repo');

    await execa('git', ['init', '-b', 'main', wt]);
    // Base tree: a file to modify, a file to delete, a file to rename.
    writeFileSync(join(wt, 'keep.txt'), 'line1\nline2\nline3\n');
    writeFileSync(join(wt, 'del.txt'), 'to be deleted\n');
    writeFileSync(join(wt, 'old-name.txt'), 'rename me unchanged\n');
    await g(wt, 'add', '.');
    await g(wt, 'commit', '-m', 'base commit');
    baseSha = await g(wt, 'rev-parse', 'HEAD');

    // Working-tree changes (some staged, some not) — diff(baseSha) must include
    // all of them because a bare `git diff <ref>` compares ref → working tree.
    writeFileSync(join(wt, 'keep.txt'), 'line1\nCHANGED\nline3\nline4\n'); // modify (unstaged)
    writeFileSync(join(wt, 'new.txt'), 'brand new\nsecond line\n'); // add
    await g(wt, 'add', 'new.txt'); // stage the add so it appears in `git diff <ref>`
    rmSync(join(wt, 'del.txt')); // delete (unstaged)
    await g(wt, 'mv', 'old-name.txt', 'new-name.txt'); // staged rename (identical content → R100)
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns baseRef/headRef and a non-empty patch', async () => {
    const d = await git.diff(wt, baseSha);
    expect(d.baseRef).toBe(baseSha);
    expect(d.headRef).toBe('HEAD');
    expect(d.patch.length).toBeGreaterThan(0);
    expect(d.patch).toContain('CHANGED');
  });

  it('detects a modified file with additions and deletions', async () => {
    const d = await git.diff(wt, baseSha);
    const entry = d.files.find((f) => f.path === 'keep.txt');
    expect(entry).toBeDefined();
    expect(entry?.change).toBe('modified');
    expect(entry?.oldPath).toBeNull();
    expect(entry?.additions).toBeGreaterThanOrEqual(1);
    expect(entry?.deletions).toBeGreaterThanOrEqual(1);
  });

  it('detects an added file (additions only)', async () => {
    const d = await git.diff(wt, baseSha);
    const entry = d.files.find((f) => f.path === 'new.txt');
    expect(entry).toBeDefined();
    expect(entry?.change).toBe('added');
    expect(entry?.additions).toBe(2);
    expect(entry?.deletions).toBe(0);
  });

  it('detects a deleted file (deletions only)', async () => {
    const d = await git.diff(wt, baseSha);
    const entry = d.files.find((f) => f.path === 'del.txt');
    expect(entry).toBeDefined();
    expect(entry?.change).toBe('deleted');
    expect(entry?.additions).toBe(0);
    expect(entry?.deletions).toBe(1);
  });

  it('detects a rename with old + new path', async () => {
    const d = await git.diff(wt, baseSha);
    const entry = d.files.find((f) => f.path === 'new-name.txt');
    expect(entry).toBeDefined();
    expect(entry?.change).toBe('renamed');
    expect(entry?.oldPath).toBe('old-name.txt');
  });

  it('status reports the branch, dirtiness, and per-file entries', async () => {
    const s = await git.status(wt);
    expect(s.branch).toBe('main');
    expect(s.clean).toBe(false);
    // No upstream configured → ahead/behind are 0.
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);

    const modified = s.files.find((f) => f.path === 'keep.txt');
    expect(modified?.status).toBe('modified');
    expect(modified?.staged).toBe(false);

    const added = s.files.find((f) => f.path === 'new.txt');
    expect(added?.status).toBe('added');
    expect(added?.staged).toBe(true);

    const deleted = s.files.find((f) => f.path === 'del.txt');
    expect(deleted?.status).toBe('deleted');

    const renamed = s.files.find((f) => f.path === 'new-name.txt');
    expect(renamed?.status).toBe('renamed');
    expect(renamed?.staged).toBe(true);
  });

  it('status on a clean repo reports clean with no files', async () => {
    const cleanRepo = join(tmpRoot, 'clean');
    await execa('git', ['init', '-b', 'main', cleanRepo]);
    writeFileSync(join(cleanRepo, 'f.txt'), 'hi\n');
    await g(cleanRepo, 'add', '.');
    await g(cleanRepo, 'commit', '-m', 'only commit');

    const s = await git.status(cleanRepo);
    expect(s.branch).toBe('main');
    expect(s.clean).toBe(true);
    expect(s.files).toHaveLength(0);
  });

  it('status reports null branch in detached-HEAD state', async () => {
    const detached = join(tmpRoot, 'detached');
    await execa('git', ['init', '-b', 'main', detached]);
    writeFileSync(join(detached, 'f.txt'), 'a\n');
    await g(detached, 'add', '.');
    await g(detached, 'commit', '-m', 'c1');
    const sha = await g(detached, 'rev-parse', 'HEAD');
    await g(detached, 'checkout', sha); // detach

    const s = await git.status(detached);
    expect(s.branch).toBeNull();
  });

  it('the restored files match on disk after the test changes', () => {
    // Sanity: the rename target exists and the delete target is gone.
    expect(existsSync(join(wt, 'new-name.txt'))).toBe(true);
    expect(existsSync(join(wt, 'del.txt'))).toBe(false);
    expect(readFileSync(join(wt, 'new.txt'), 'utf8')).toContain('brand new');
  });
});

// ---------------------------------------------------------------------------
// parseUnifiedHunks — pure parser (reused by DiffService)
// ---------------------------------------------------------------------------

describe('parseUnifiedHunks', () => {
  it('parses hunk headers with explicit line counts', () => {
    const patch = [
      'diff --git a/f.txt b/f.txt',
      'index 111..222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+CHANGED',
      ' line3',
      '+line4',
    ].join('\n');

    const hunks = parseUnifiedHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
    });
    expect(hunks[0].lines).toEqual([
      ' line1',
      '-line2',
      '+CHANGED',
      ' line3',
      '+line4',
    ]);
  });

  it('defaults an omitted line count to 1', () => {
    const patch = ['@@ -5 +5 @@', '-old', '+new'].join('\n');
    const hunks = parseUnifiedHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      oldStart: 5,
      oldLines: 1,
      newStart: 5,
      newLines: 1,
    });
  });

  it('splits multiple hunks and separate file sections', () => {
    const patch = [
      'diff --git a/one.txt b/one.txt',
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '@@ -10,2 +10,2 @@',
      ' ctx',
      '-x',
      '+y',
      'diff --git a/two.txt b/two.txt',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+added',
    ].join('\n');

    const hunks = parseUnifiedHunks(patch);
    expect(hunks).toHaveLength(3);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[1].oldStart).toBe(10);
    expect(hunks[2].lines).toEqual([' keep', '+added']);
  });

  it('returns an empty array for a patch with no hunks', () => {
    expect(parseUnifiedHunks('')).toEqual([]);
    expect(parseUnifiedHunks('diff --git a/x b/x\nindex 1..2\n')).toEqual([]);
  });
});
