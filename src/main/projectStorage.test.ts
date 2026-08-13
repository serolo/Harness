import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { openDb, type AppDatabase } from './db';
import { ProjectsRepo } from './db/repos/projects';
import { WorkspacesRepo } from './db/repos/workspaces';
import { GitService } from './git';
import { rootDirectory, setUserDataRoot } from './paths';
import { reconcileProjectStorage } from './projectStorage';

let db: AppDatabase | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await db?.destroy();
  db = undefined;
  setUserDataRoot(undefined);
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

async function createSourceRepository(path: string): Promise<void> {
  await execa('git', ['init', '-b', 'main', path]);
  await writeFile(join(path, 'README.md'), '# project\n', 'utf8');
  await execa('git', ['add', '.'], { cwd: path });
  await execa(
    'git',
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'initial',
    ],
    { cwd: path },
  );
}

describe('project storage reconciliation', () => {
  it('consolidates split UUID storage and repairs linked worktrees', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'project-storage-'));
    setUserDataRoot(join(temporaryRoot, 'data'));
    db = openDb(join(temporaryRoot, 'app.db'));

    const source = join(temporaryRoot, 'source');
    await createSourceRepository(source);
    const git = new GitService();
    const splitCloneRoot = join(
      rootDirectory(),
      'projects',
      'clone-storage-uuid',
    );
    const legacyRepoPath = join(splitCloneRoot, 'repo');
    await git.clone(source, legacyRepoPath);

    const projects = new ProjectsRepo(db);
    const project = await projects.create({
      name: 'W2 Platform',
      originUrl: source,
      defaultBranch: 'main',
      repoPath: legacyRepoPath,
    });
    await db
      .updateTable('projects')
      .set({ directory_name: null })
      .where('id', '=', project.id)
      .execute();

    const legacyStateRoot = join(rootDirectory(), 'projects', project.id);
    const legacyWorktreePath = join(legacyStateRoot, 'worktrees', 'feature');
    await mkdir(join(legacyStateRoot, 'knowledge'), { recursive: true });
    await writeFile(
      join(legacyStateRoot, 'knowledge', 'index.md'),
      '# Knowledge\n',
      'utf8',
    );
    await git.addWorktree(
      legacyRepoPath,
      legacyWorktreePath,
      'feature',
      'main',
      true,
    );

    const workspaces = new WorkspacesRepo(db);
    const linked = await workspaces.create({
      projectId: project.id,
      name: 'feature',
      branch: 'feature',
      baseBranch: 'main',
      harness: 'codex',
      status: 'idle',
      location: 'worktree',
      worktreePath: legacyWorktreePath,
    });
    const projectCheckout = await workspaces.create({
      projectId: project.id,
      name: 'main',
      branch: 'main',
      baseBranch: 'main',
      harness: 'codex',
      status: 'idle',
      location: 'project',
      worktreePath: legacyRepoPath,
    });

    await reconcileProjectStorage(db, git);

    const targetRoot = join(rootDirectory(), 'projects', 'w2-platform');
    const targetRepoPath = join(targetRoot, 'repo');
    const targetWorktreePath = join(targetRoot, 'worktrees', 'feature');
    expect(await projects.getById(project.id)).toMatchObject({
      directoryName: 'w2-platform',
      repoPath: targetRepoPath,
    });
    expect(await workspaces.getById(linked.id)).toMatchObject({
      worktreePath: targetWorktreePath,
    });
    expect(await workspaces.getById(projectCheckout.id)).toMatchObject({
      worktreePath: targetRepoPath,
    });
    expect(existsSync(join(targetRoot, 'knowledge', 'index.md'))).toBe(true);
    expect(existsSync(legacyStateRoot)).toBe(false);
    expect(existsSync(splitCloneRoot)).toBe(false);
    await expect(git.open(targetRepoPath)).resolves.toMatchObject({
      defaultBranch: 'main',
    });
    await expect(
      execa('git', ['status', '--short'], { cwd: targetWorktreePath }),
    ).resolves.toMatchObject({ exitCode: 0 });

    // A successful reconciliation is durable and safe to run on every startup.
    await expect(reconcileProjectStorage(db, git)).resolves.toBeUndefined();
  });

  it('moves app-owned state but leaves an external repository in place', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'project-storage-external-'));
    setUserDataRoot(join(temporaryRoot, 'data'));
    db = openDb(join(temporaryRoot, 'app.db'));

    const externalRepoPath = join(temporaryRoot, 'external-repository');
    await createSourceRepository(externalRepoPath);
    const projects = new ProjectsRepo(db);
    const project = await projects.create({
      name: 'External Project',
      originUrl: '',
      defaultBranch: 'main',
      repoPath: externalRepoPath,
    });
    await db
      .updateTable('projects')
      .set({ directory_name: null })
      .where('id', '=', project.id)
      .execute();
    const legacyStateRoot = join(rootDirectory(), 'projects', project.id);
    await mkdir(join(legacyStateRoot, 'knowledge'), { recursive: true });
    await writeFile(
      join(legacyStateRoot, 'knowledge', 'index.md'),
      '# External knowledge\n',
      'utf8',
    );

    await reconcileProjectStorage(db, new GitService());

    const targetRoot = join(rootDirectory(), 'projects', 'external-project');
    expect(await projects.getById(project.id)).toMatchObject({
      directoryName: 'external-project',
      repoPath: externalRepoPath,
    });
    expect(existsSync(join(externalRepoPath, '.git'))).toBe(true);
    expect(existsSync(join(targetRoot, 'knowledge', 'index.md'))).toBe(true);
    expect(existsSync(legacyStateRoot)).toBe(false);
  });
});
