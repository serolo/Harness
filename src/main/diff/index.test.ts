// Integration tests for DiffService — real git in temp directories + a real
// (temp-file) sqlite DB for the comment lifecycle. Runs in the default node
// environment under the Electron ABI (see scripts/vitest-electron.mjs), same
// pattern as src/main/git/index.test.ts and src/main/db/migrations/0005_diff_review.test.ts.
//
// We are the INDEPENDENT test author here — attacking the spec (getDiff/fileDiff/
// commits/comments/buildSendToAgent/watch) from the outside, not from the
// implementation's structure.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { AppError } from '@shared/errors';
import type { Workspace } from '@shared/models';
import type { Attachment } from '@shared/harness';

import { openDb, type AppDatabase } from '../db';
import { ProjectsRepo } from '../db/repos/projects';
import { WorkspacesRepo } from '../db/repos/workspaces';
import { DiffCommentsRepo } from '../db/repos/comments';
import { GitService } from '../git';
import { DiffService } from './index';

/** Run a git command with a fixed test identity so commits succeed. */
async function g(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=test', ...args],
    { cwd },
  );
  return result.stdout.trim();
}

let tmpRoot: string;
// repoA: base commit + a feature branch with committed changes (modify / add /
// delete / rename), PLUS an uncommitted tracked edit and an untracked file.
let repoA: string;
// repoB: a single commit, no branch beyond `main` — used for the empty
// commits() case (HEAD === merge-base).
let repoB: string;

let db: AppDatabase;
let git: GitService;
let diffService: DiffService;
let wsRepo: WorkspacesRepo;
let workspaceA: Workspace;
let workspaceB: Workspace;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'diff-svc-test-'));

  // --- repoA -----------------------------------------------------------
  repoA = join(tmpRoot, 'repoA');
  await execa('git', ['init', '-b', 'main', repoA]);
  writeFileSync(join(repoA, 'base.txt'), 'line1\nline2\nline3\n');
  writeFileSync(join(repoA, 'to-delete.txt'), 'bye\n');
  writeFileSync(join(repoA, 'to-rename.txt'), 'rename me\n');
  writeFileSync(join(repoA, 'dirty.txt'), 'original\n');
  writeFileSync(join(repoA, 'README.md'), '# repoA\n');
  await g(repoA, 'add', '.');
  await g(repoA, 'commit', '-m', 'base commit');

  await g(repoA, 'checkout', '-b', 'feature');

  // Committed: modify base.txt, add new-tracked.txt, delete to-delete.txt.
  writeFileSync(
    join(repoA, 'base.txt'),
    'line1\nline2 modified\nline3\nline4\n',
  );
  writeFileSync(join(repoA, 'new-tracked.txt'), 'brand new\nsecond line\n');
  await execa('git', ['rm', 'to-delete.txt'], { cwd: repoA });
  await g(repoA, 'add', '.');
  await g(repoA, 'commit', '-m', 'feature changes');

  // Committed: rename to-rename.txt -> renamed.txt (no content change).
  await execa('git', ['mv', 'to-rename.txt', 'renamed.txt'], { cwd: repoA });
  await g(repoA, 'commit', '-m', 'rename file');

  // Uncommitted: further edit to a tracked file (worktree dirty, not staged/committed).
  writeFileSync(join(repoA, 'dirty.txt'), 'original\nextra uncommitted line\n');

  // Untracked: never `git add`ed.
  writeFileSync(join(repoA, 'untracked.txt'), 'one\ntwo\nthree\n');

  // --- repoB: HEAD === base branch, for the empty commits() case -------
  repoB = join(tmpRoot, 'repoB');
  await execa('git', ['init', '-b', 'main', repoB]);
  writeFileSync(join(repoB, 'README.md'), '# repoB\n');
  await g(repoB, 'add', '.');
  await g(repoB, 'commit', '-m', 'only commit');

  // --- collaborators -----------------------------------------------------
  const dbFile = join(tmpRoot, 'test.db');
  db = openDb(dbFile);
  git = new GitService();

  const project = await new ProjectsRepo(db).create({
    name: 'demo',
    originUrl: '',
    defaultBranch: 'main',
    repoPath: repoA,
  });

  wsRepo = new WorkspacesRepo(db);
  workspaceA = await wsRepo.create({
    projectId: project.id,
    name: 'paris',
    branch: 'feature',
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'idle',
    worktreePath: repoA,
  });
  workspaceB = await wsRepo.create({
    projectId: project.id,
    name: 'london',
    branch: 'main',
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'idle',
    worktreePath: repoB,
  });

  diffService = new DiffService({
    git,
    getWorkspace: async (id) => wsRepo.getById(id),
    emit: () => {
      /* spy target not asserted on — debounced emit timing is deliberately
       * excluded from this suite (see watch/stopAll below). */
    },
    comments: new DiffCommentsRepo(db),
  });
});

afterAll(async () => {
  diffService.stopAll();
  await db.destroy();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getDiff
// ---------------------------------------------------------------------------

describe('DiffService.getDiff', () => {
  it('reports modified/added/deleted/renamed change kinds with plausible stats', async () => {
    const diff = await diffService.getDiff(workspaceA.id);
    const byPath = new Map(diff.files.map((f) => [f.path, f]));

    const base = byPath.get('base.txt');
    expect(base?.change).toBe('modified');
    expect(base!.additions).toBeGreaterThan(0);
    expect(base!.deletions).toBeGreaterThan(0);

    const added = byPath.get('new-tracked.txt');
    expect(added?.change).toBe('added');
    expect(added!.additions).toBeGreaterThan(0);
    expect(added!.deletions).toBe(0);

    const deleted = byPath.get('to-delete.txt');
    expect(deleted?.change).toBe('deleted');
    expect(deleted!.deletions).toBeGreaterThan(0);
    expect(deleted!.additions).toBe(0);

    const renamed = byPath.get('renamed.txt');
    expect(renamed?.change).toBe('renamed');
    expect(renamed?.oldPath).toBe('to-rename.txt');

    // Uncommitted tracked edit must also show up (worktree vs merge-base, not base..HEAD).
    const dirty = byPath.get('dirty.txt');
    expect(dirty?.change).toBe('modified');
    expect(dirty!.additions).toBeGreaterThan(0);
  });

  it('surfaces an untracked file as change:"added" with additions = its line count', async () => {
    const diff = await diffService.getDiff(workspaceA.id);
    const untracked = diff.files.find((f) => f.path === 'untracked.txt');
    expect(untracked).toBeDefined();
    expect(untracked?.change).toBe('added');
    expect(untracked?.additions).toBe(3); // 'one\ntwo\nthree\n' => 3 lines
    expect(untracked?.deletions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fileDiff
// ---------------------------------------------------------------------------

describe('DiffService.fileDiff', () => {
  it('returns oldContent/newContent/hunks for a modified file', async () => {
    const fd = await diffService.fileDiff(workspaceA.id, 'base.txt');
    // REGRESSION: `oldContent` (git show) and `newContent` (fs.readFile) must both
    // preserve the file's trailing newline verbatim so the two sides are byte-comparable
    // for an unchanged tail. fileDiff passes `stripFinalNewline: false` to execa; without
    // it, execa would strip the trailing "\n" from oldContent and render a phantom
    // "no newline at EOF" diff.
    expect(fd.oldContent).toBe('line1\nline2\nline3\n');
    expect(fd.newContent).toBe('line1\nline2 modified\nline3\nline4\n');
    expect(fd.hunks.length).toBeGreaterThan(0);
  });

  it('returns empty oldContent for a new (added) file', async () => {
    const fd = await diffService.fileDiff(workspaceA.id, 'new-tracked.txt');
    expect(fd.oldContent).toBe('');
    expect(fd.newContent).toBe('brand new\nsecond line\n');
  });

  it('rejects a `..`-traversal path with AppError code invalid_input', async () => {
    await expect(
      diffService.fileDiff(workspaceA.id, '../etc/passwd'),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects an absolute path with AppError code invalid_input', async () => {
    try {
      await diffService.fileDiff(workspaceA.id, '/etc/passwd');
      expect.fail('expected fileDiff to reject an absolute path');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('invalid_input');
    }
  });
});

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

describe('DiffService.commits', () => {
  it('returns the feature commits in main..HEAD with sha/shortSha/subject populated', async () => {
    const commits = await diffService.commits(workspaceA.id);
    expect(commits.length).toBe(2);

    const subjects = commits.map((c) => c.subject);
    expect(subjects).toContain('feature changes');
    expect(subjects).toContain('rename file');

    for (const c of commits) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(c.shortSha.length).toBeGreaterThan(0);
      expect(c.subject.length).toBeGreaterThan(0);
    }
  });

  it('returns an empty array when HEAD is the base branch (no commits ahead)', async () => {
    const commits = await diffService.commits(workspaceB.id);
    expect(commits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Comments lifecycle
// ---------------------------------------------------------------------------

describe('DiffService comments lifecycle', () => {
  it('creates, lists by state, transitions, and deletes an inline comment', async () => {
    const created = await diffService.addComment({
      workspaceId: workspaceA.id,
      filePath: 'base.txt',
      lineStart: 2,
      lineEnd: 2,
      side: 'new',
      body: 'lifecycle test comment',
    });
    expect(created.state).toBe('open');

    const open = await diffService.listComments(workspaceA.id, 'open');
    expect(open.map((c) => c.id)).toContain(created.id);

    await diffService.setCommentState(created.id, 'resolved');
    const resolved = await diffService.listComments(workspaceA.id, 'resolved');
    expect(resolved.map((c) => c.id)).toContain(created.id);
    const noLongerOpen = await diffService.listComments(workspaceA.id, 'open');
    expect(noLongerOpen.map((c) => c.id)).not.toContain(created.id);

    await diffService.removeComment(created.id);
    const all = await diffService.listComments(workspaceA.id);
    expect(all.map((c) => c.id)).not.toContain(created.id);
  });
});

// ---------------------------------------------------------------------------
// buildSendToAgent
// ---------------------------------------------------------------------------

describe('DiffService.buildSendToAgent', () => {
  it('attaches a line-anchored open comment (frozen diff_comment shape) and skips a file-level one', async () => {
    const lineComment = await diffService.addComment({
      workspaceId: workspaceA.id,
      filePath: 'base.txt',
      lineStart: 2,
      lineEnd: 2,
      side: 'new',
      body: 'please reconsider this line',
    });
    const fileComment = await diffService.addComment({
      workspaceId: workspaceA.id,
      filePath: 'new-tracked.txt',
      lineStart: null,
      lineEnd: null,
      side: null,
      body: 'general note about the whole file',
    });

    const result = await diffService.buildSendToAgent(workspaceA.id);
    expect(result.attachments.length).toBe(1);

    const attachment: Attachment = result.attachments[0];
    expect(attachment.type).toBe('diff_comment');
    if (attachment.type !== 'diff_comment') {
      throw new Error('expected a diff_comment attachment');
    }
    expect(attachment.file).toBe('base.txt');
    expect(attachment.lineStart).toBe(2);
    expect(attachment.lineEnd).toBe(2);
    expect(attachment.side).toBe('new');
    expect(typeof attachment.excerpt).toBe('string');
    expect(attachment.excerpt.length).toBeGreaterThan(0);
    expect(attachment.body).toBe('please reconsider this line');

    // The attached comment flips to `sent`...
    const sent = await diffService.listComments(workspaceA.id, 'sent');
    expect(sent.map((c) => c.id)).toContain(lineComment.id);

    // ...while the file-level (null range) comment was skipped and stays `open`.
    const stillOpen = await diffService.listComments(workspaceA.id, 'open');
    expect(stillOpen.map((c) => c.id)).toContain(fileComment.id);

    // Cleanup so later assertions in this suite aren't affected.
    await diffService.removeComment(lineComment.id);
    await diffService.removeComment(fileComment.id);
  });
});

// ---------------------------------------------------------------------------
// watch / stopAll
// ---------------------------------------------------------------------------

describe('DiffService.watch / stopAll', () => {
  it('returns a stoppable handle and is idempotent for a repeat call', () => {
    const handle1 = diffService.watch(workspaceA.id);
    const handle2 = diffService.watch(workspaceA.id);
    expect(handle1).toBe(handle2);
    expect(() => handle1.stop()).not.toThrow();
  });

  it('stopAll() tears down every workspace watcher and is safe to call repeatedly', () => {
    diffService.watch(workspaceA.id);
    diffService.watch(workspaceB.id);
    expect(() => diffService.stopAll()).not.toThrow();
    expect(() => diffService.stopAll()).not.toThrow();
  });
});
