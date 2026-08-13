import { mkdir, readdir, rename, rmdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { AppDatabase } from './db';
import type { GitService } from './git';
import { allocateProjectDirectoryName, rootDirectory } from './paths';
import { AppError } from '@shared/errors';

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function replacePrefix(path: string, from: string, to: string): string {
  return within(from, path) ? join(to, relative(from, path)) : path;
}

function migratedWorkspacePath(
  path: string,
  legacyStateRoot: string,
  targetRoot: string,
  legacyRepoPath: string,
  targetRepoPath: string,
): string {
  return replacePrefix(
    replacePrefix(path, legacyStateRoot, targetRoot),
    legacyRepoPath,
    targetRepoPath,
  );
}

/**
 * Move legacy UUID-owned project state into stable name-based folders. DB paths are
 * committed only after filesystem moves and Git linked-worktree repair succeed.
 */
export async function reconcileProjectStorage(
  db: AppDatabase,
  git: GitService,
): Promise<void> {
  const projectsRoot = join(rootDirectory(), 'projects');
  await mkdir(projectsRoot, { recursive: true });
  const filesystemNames = await readdir(projectsRoot);
  const projects = await db
    .selectFrom('projects')
    .selectAll()
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const reserved = new Set(
    projects.flatMap((project) =>
      project.directory_name ? [project.directory_name] : [],
    ),
  );
  const legacyIds = new Set(projects.map((project) => project.id));
  for (const entry of filesystemNames) {
    if (!legacyIds.has(entry)) reserved.add(entry);
  }

  for (const project of projects) {
    if (project.directory_name) continue;
    const directoryName = allocateProjectDirectoryName(project.name, reserved);
    reserved.add(directoryName);
    const targetRoot = join(projectsRoot, directoryName);
    const legacyStateRoot = join(projectsRoot, project.id);
    const managedRepo = within(projectsRoot, project.repo_path);
    const legacyRepoPath = project.repo_path;
    const targetRepoPath = managedRepo
      ? join(targetRoot, 'repo')
      : legacyRepoPath;
    const workspaces = await db
      .selectFrom('workspaces')
      .select(['id', 'worktree_path', 'location'])
      .where('project_id', '=', project.id)
      .execute();
    const movedWorktrees = workspaces.flatMap((workspace) => {
      if (!workspace.worktree_path || workspace.location !== 'worktree') {
        return [];
      }
      const next = migratedWorkspacePath(
        workspace.worktree_path,
        legacyStateRoot,
        targetRoot,
        legacyRepoPath,
        targetRepoPath,
      );
      return next === workspace.worktree_path ? [] : [next];
    });
    const rollback: Array<() => Promise<void>> = [];

    try {
      const stateExists = await exists(legacyStateRoot);
      const targetExists = await exists(targetRoot);
      if (targetExists) {
        throw new AppError(
          'conflict',
          `project storage destination already exists: ${targetRoot}`,
        );
      }
      if (stateExists) {
        await rename(legacyStateRoot, targetRoot);
        rollback.push(() => rename(targetRoot, legacyStateRoot));
      } else {
        await mkdir(targetRoot, { recursive: false });
        rollback.push(() => rmdir(targetRoot));
      }

      const repoPathAfterStateMove = replacePrefix(
        legacyRepoPath,
        legacyStateRoot,
        targetRoot,
      );
      if (
        managedRepo &&
        resolve(repoPathAfterStateMove) !== resolve(targetRepoPath)
      ) {
        if (!within(projectsRoot, legacyRepoPath)) {
          throw new AppError(
            'conflict',
            'managed repository escaped project root',
          );
        }
        if (await exists(targetRepoPath)) {
          throw new AppError(
            'conflict',
            `project repository destination already exists: ${targetRepoPath}`,
          );
        }
        await rename(repoPathAfterStateMove, targetRepoPath);
        rollback.push(async () => {
          await mkdir(dirname(repoPathAfterStateMove), { recursive: true });
          await rename(targetRepoPath, repoPathAfterStateMove);
        });
        const oldRepoParent = dirname(legacyRepoPath);
        if (
          oldRepoParent !== legacyStateRoot &&
          within(projectsRoot, oldRepoParent) &&
          (await readdir(oldRepoParent)).length === 0
        ) {
          await rmdir(oldRepoParent);
        }
      }

      if (movedWorktrees.length > 0) {
        await git.repairWorktrees(targetRepoPath, movedWorktrees);
      }
      await git.open(targetRepoPath);

      await db.transaction().execute(async (tx) => {
        await tx
          .updateTable('projects')
          .set({
            directory_name: directoryName,
            repo_path: targetRepoPath,
          })
          .where('id', '=', project.id)
          .execute();
        for (const workspace of workspaces) {
          if (!workspace.worktree_path) continue;
          const nextPath = migratedWorkspacePath(
            workspace.worktree_path,
            legacyStateRoot,
            targetRoot,
            legacyRepoPath,
            targetRepoPath,
          );
          if (nextPath === workspace.worktree_path) continue;
          await tx
            .updateTable('workspaces')
            .set({ worktree_path: nextPath })
            .where('id', '=', workspace.id)
            .execute();
        }
      });
    } catch (error) {
      for (const undo of rollback.reverse()) {
        await undo().catch(() => {});
      }
      if (movedWorktrees.length > 0) {
        await git
          .repairWorktrees(
            legacyRepoPath,
            workspaces.flatMap((workspace) =>
              workspace.worktree_path ? [workspace.worktree_path] : [],
            ),
          )
          .catch(() => {});
      }
      throw error;
    }
  }
}
