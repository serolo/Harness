// WorkspaceManager — workspace lifecycle (create/archive/restore), city-name +
// port allocation, and the SINGLE owner of workspace status transitions
// (README §6.4: any subsystem transitions status ONLY via `setStatus()`, which
// also emits the `workspace:status` event). `archive`/`restore` are the two
// documented exceptions that emit their OWN events (`workspace:archived`, and
// `restore` ends by routing through `setStatus`).
//
// Collaborators are INJECTED via the constructor `deps` (wired in
// `src/main/index.ts`, Task 6) so this module stays testable and keeps native
// modules (better-sqlite3 via the repos, node-pty via processes) out of its type
// graph — the concrete classes are imported type-only.
//
// Correctness invariants (phase doc §3.3/§3.4, README §6.4):
//   - better-sqlite3 is SYNCHRONOUS; never `await`-race a DB read against the git
//     work. Do the async git step first, then the DB write, deterministically.
//   - Broadcast events are emitted ONLY AFTER the corresponding DB write commits.
//   - Exactly one code path (`setStatus`) emits `workspace:status`.

import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { AppError } from '@shared/errors';
import type { CreateWorkspaceReq, Workspace } from '@shared/models';
import type {
  EventChannel,
  EventPayload,
  WorkspaceArchivePreview,
} from '@shared/ipc';

import { worktreesDir } from '../paths';
import { buildEnv } from '../process/env';
import type { GitService } from '../git';
import type { ProjectsRepo } from '../db/repos/projects';
import type { WorkspacesRepo } from '../db/repos/workspaces';
import type { SettingsService } from '../settings';

/**
 * Public request shape for creating a workspace. Aliased to the shared
 * {@link CreateWorkspaceReq} DTO so the renderer (which builds it from the
 * New-Workspace dialog) and main (`WorkspaceManager.create`) share one type.
 */
export type CreateWorkspaceOptions = CreateWorkspaceReq;

function sameFilesystemPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    // A stale Git registration can point at a missing path. Preserve a useful
    // lexical comparison without requiring either side to exist.
    return resolve(left) === resolve(right);
  }
}

/**
 * Collaborators injected into {@link WorkspaceManager}. Wired once in
 * `src/main/index.ts` (Task 6) with the db-backed repos, the stateless
 * {@link GitService}, the pure name/port allocators, the read-only
 * {@link SettingsService}, the setup-command runner, a process-stop hook
 * (Phase 3), and a broadcast `emit` closure.
 */
export interface WorkspaceManagerDeps {
  /** Db-backed repositories for the two tables this manager touches. */
  repos: { projects: ProjectsRepo; workspaces: WorkspacesRepo };
  /** Stateless wrapper over the system `git` binary. */
  git: GitService;
  /** Pure city-name allocator (`naming.allocate`). */
  naming: { allocate(existingNames: string[]): string };
  /** Pure free-TCP-port allocator (`ports.allocate`). */
  ports: {
    allocate(opts?: {
      range?: [number, number];
      taken?: number[];
    }): Promise<number>;
  };
  /** Read-only merged settings accessor. */
  settings: SettingsService;
  /** Runs the setup command in the worktree, streaming combined output. */
  runSetup: (
    command: string,
    opts: { cwd: string; env?: Record<string, string> },
    onLog?: (chunk: string) => void,
  ) => Promise<{ exitCode: number }>;
  /**
   * Stops any long-running processes attached to a workspace before its
   * worktree is force-removed. A no-op hook in Phase 1.
   * INTEGRATION(phase-3): fold into the ProcessRegistry teardown.
   */
  stopWorkspaceProcesses: (id: string) => Promise<void> | void;
  /** Broadcast an IPC event to every live renderer (post-commit only). */
  emit: <K extends EventChannel>(event: K, payload: EventPayload<K>) => void;
}

/**
 * Owns workspace lifecycle + the status machine (spec §5.1, README §6.4).
 * Constructed in `src/main/index.ts` (Task 6) with all collaborators injected
 * via {@link WorkspaceManagerDeps}.
 */
export class WorkspaceManager {
  constructor(private readonly deps: WorkspaceManagerDeps) {}

  /**
   * Create a workspace (spec §5.1, reconciled): resolve the project → best-effort
   * fetch → allocate a unique city name → derive branch + base ref → add the git
   * worktree → allocate a free port → persist the row (`status: idle`) → emit
   * `workspace:created` → run the setup script (a non-zero exit downgrades the
   * status to `needs_attention`).
   *
   * Ordering guarantees: the git worktree exists before the DB row is written,
   * and `workspace:created` is emitted AFTER the row commits but BEFORE setup
   * runs (so the renderer can render the new row while its setup log streams).
   *
   * @param req         - Creation request; omitted fields are allocated.
   * @param onSetupLog  - Optional sink for combined setup stdout/stderr chunks.
   * @param onCreated   - Optional sink called after persistence and before setup.
   * @returns the created (and possibly status-updated) workspace DTO.
   */
  async create(
    req: CreateWorkspaceReq,
    onSetupLog?: (chunk: string) => void,
    onCreated?: (workspace: Workspace) => void,
  ): Promise<Workspace> {
    const project = await this.deps.repos.projects.getById(req.projectId);
    if (project === null) {
      throw new AppError('not_found', `project not found: ${req.projectId}`);
    }

    // Best-effort fetch: only meaningful for repos with a remote, and a failure
    // (offline / local-only repo) must not block workspace creation.
    if (project.originUrl !== '') {
      try {
        await this.deps.git.fetch(project.repoPath);
      } catch {
        /* local/offline repo — continue */
      }
    }

    const all = await this.deps.repos.workspaces.listByProject(req.projectId);
    // Port allocation and project-checkout exclusivity only consider live siblings.
    // Names consider archived rows too because the DB uniqueness constraint does.
    const live = all.filter((w) => w.status !== 'archived');
    const location = req.location ?? 'worktree';
    if (location !== 'worktree' && location !== 'project') {
      throw new AppError(
        'invalid_input',
        `unknown workspace location: ${location}`,
      );
    }
    if (
      location === 'project' &&
      live.some((workspace) => workspace.location === 'project')
    ) {
      throw new AppError(
        'conflict',
        'the project checkout is already used by another workspace',
      );
    }
    if (location === 'project' && req.sourceKind === 'pr') {
      throw new AppError(
        'invalid_input',
        'pull requests require an isolated worktree',
      );
    }

    const requestedName = req.name?.trim();
    if (
      requestedName !== undefined &&
      !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(requestedName)
    ) {
      throw new AppError(
        'invalid_input',
        'workspace name must be 1-63 lowercase letters, numbers, or hyphens',
      );
    }
    if (
      requestedName !== undefined &&
      all.some((w) => w.name === requestedName)
    ) {
      throw new AppError(
        'conflict',
        `workspace name is already in use: ${requestedName}`,
      );
    }

    const existingNames = all.map((w) => w.name);
    const name =
      requestedName ??
      (location === 'project' && !existingNames.includes('current')
        ? 'current'
        : this.deps.naming.allocate(existingNames));
    const settings = this.deps.settings.get();
    const baseRef = req.baseBranch ?? project.defaultBranch;
    let branch = req.branch ?? `${settings.git.branchPrefix}/${name}`;
    let worktreePath = join(worktreesDir(project.id), name);

    // A `pr` source seeds the worktree from the PR head instead of the base ref.
    // `req.sourceRef` is the PR number as a string; a non-numeric / non-positive
    // value is invalid input (never a NaN persisted to `prNumber`).
    const isPr = req.sourceKind === 'pr';
    let prNumber: number | null = null;
    let reuseManagedWorktree = false;
    let createdManagedWorktree = false;

    if (location === 'worktree') {
      const registered = await this.deps.git.worktreeList(project.repoPath);
      const atTargetPath = registered.find((entry) =>
        sameFilesystemPath(entry.path, worktreePath),
      );
      if (atTargetPath) {
        if (atTargetPath.branch !== branch) {
          throw new AppError(
            'conflict',
            `worktree path is already registered for branch "${atTargetPath.branch ?? 'detached HEAD'}"`,
            { worktreePath, branch: atTargetPath.branch },
          );
        }
        // A prior create can finish `git worktree add` and then fail while inserting
        // the DB row (for example during a schema mismatch). Reuse that exact orphan
        // instead of asking Git to add its already-checked-out branch a second time.
        reuseManagedWorktree = true;
      } else {
        const branchWorktree = registered.find(
          (entry) => entry.branch === branch,
        );
        if (branchWorktree) {
          throw new AppError(
            'conflict',
            `branch "${branch}" is already checked out in another worktree`,
            { branch, worktreePath: branchWorktree.path },
          );
        }
      }
    }

    if (location === 'project') {
      branch = await this.deps.git.currentBranch(project.repoPath);
      if (branch === 'HEAD') {
        throw new AppError(
          'conflict',
          'the project checkout is detached; check out a branch before using it',
        );
      }
      worktreePath = project.repoPath;
    } else if (isPr) {
      const parsed = Number.parseInt(req.sourceRef ?? '', 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new AppError(
          'invalid_input',
          `create-from-PR requires a positive PR number in sourceRef, got: ${req.sourceRef ?? '(none)'}`,
        );
      }
      prNumber = parsed;

      // SAME-REPO-FIRST (v1): fetch the origin `pull/<n>/head` ref into the
      // app-derived local `branch` (already `<prefix>/<name>` — confined, never raw
      // user input), then create the worktree by checking THAT branch out (no `-b`,
      // no base ref). A PR opened from a fork lives in the fork's repo and is out of
      // scope for v1 — we assume origin exposes `pull/<n>/head`.
      if (!reuseManagedWorktree) {
        await this.deps.git.fetchPullRequestHead(
          project.repoPath,
          prNumber,
          branch,
        );
        await this.deps.git.addWorktree(
          project.repoPath,
          worktreePath,
          branch,
          baseRef,
          false,
        );
        createdManagedWorktree = true;
      }
    } else if (!reuseManagedWorktree) {
      // Pick `-b` (create) vs plain checkout so we never clobber an existing branch.
      const createBranch = !(await this.deps.git.branchExists(
        project.repoPath,
        branch,
      ));
      await this.deps.git.addWorktree(
        project.repoPath,
        worktreePath,
        branch,
        baseRef,
        createBranch,
      );
      createdManagedWorktree = true;
    }

    // RECONCILED: port allocated pre-setup so PORT is in the setup env (phase doc §3.3 vs §3.4)
    const taken = live.map((w) => w.port).filter((p): p is number => p != null);
    const port = await this.deps.ports.allocate({ taken });

    let workspace: Workspace;
    try {
      workspace = await this.deps.repos.workspaces.create({
        projectId: req.projectId,
        name,
        branch,
        baseBranch: baseRef,
        harness: req.harness ?? settings.agent.defaultHarness,
        status: 'idle',
        worktreePath,
        // INTEGRATION(phase-5): pendingPrompt composer prefill
        sourceKind: req.sourceKind ?? 'none',
        sourceRef: req.sourceRef ?? null,
        // Persist the PR number for a `pr` source (null for every other kind) so the
        // workspace links back to its pull request (migration 0007 `pr_number`).
        prNumber,
        port,
        location,
      });
    } catch (error) {
      if (createdManagedWorktree) {
        try {
          await this.deps.git.removeWorktree(
            project.repoPath,
            worktreePath,
            true,
          );
        } catch {
          // Preserve the persistence error. A surviving exact-path worktree is safe
          // to adopt on the next create attempt via the recovery path above.
        }
      }
      throw error;
    }

    // Emit AFTER the row commits, BEFORE setup runs (renderer renders the row now).
    this.deps.emit('workspace:created', { workspace });
    // The scoped create stream also needs the persisted row at this point so its
    // dialog can select the workspace and close without waiting for setup.
    onCreated?.(workspace);

    // Run the optional setup script with the allocated port in the env. A
    // non-zero exit flags the workspace for attention but does not throw.
    const setupCmd = settings.scripts.setup;
    if (setupCmd !== undefined) {
      // Route setup env through the single `buildEnv` helper (shared with PTY + run
      // scripts) so PORT/APP_PORT/WORKSPACE_* are derived in exactly one place (§3.4).
      const env = buildEnv({
        port,
        worktreePath,
        name: workspace.name,
        settingsEnv: settings.env,
      });
      const { exitCode } = await this.deps.runSetup(
        setupCmd,
        { cwd: worktreePath, env },
        onSetupLog,
      );
      if (exitCode !== 0) {
        await this.setStatus(workspace.id, 'needs_attention');
      }
    }

    // Re-fetch so the returned DTO reflects any status downgrade above.
    return (
      (await this.deps.repos.workspaces.getById(workspace.id)) ?? workspace
    );
  }

  /** Fetch a single workspace DTO by id, or `null` if it does not exist. */
  async get(id: string): Promise<Workspace | null> {
    return this.deps.repos.workspaces.getById(id);
  }

  /** Update user-controlled metadata exposed by the workspace context menu. */
  async update(
    id: string,
    patch: {
      name?: string;
      status?: Workspace['status'];
      isUnread?: boolean;
      isPinned?: boolean;
    },
  ): Promise<Workspace> {
    const current = await this.deps.repos.workspaces.getById(id);
    if (current === null) {
      throw new AppError('not_found', `workspace not found: ${id}`);
    }

    let name: string | undefined;
    if (patch.name !== undefined) {
      name = patch.name.trim();
      if (
        !/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,79}$/u.test(name) ||
        name.endsWith('.')
      ) {
        throw new AppError(
          'invalid_input',
          'workspace name must be 1-80 letters, numbers, spaces, dots, hyphens, or underscores',
        );
      }
      const siblings = await this.deps.repos.workspaces.listByProject(
        current.projectId,
      );
      if (
        siblings.some(
          (workspace) => workspace.id !== id && workspace.name === name,
        )
      ) {
        throw new AppError(
          'conflict',
          `workspace name is already in use: ${name}`,
        );
      }
    }

    if (
      patch.status !== undefined &&
      !['idle', 'working', 'needs_attention', 'running'].includes(patch.status)
    ) {
      throw new AppError(
        'invalid_input',
        'archived is not a user-settable workspace status',
      );
    }
    if (patch.isUnread !== undefined && typeof patch.isUnread !== 'boolean') {
      throw new AppError('invalid_input', 'isUnread must be a boolean');
    }
    if (patch.isPinned !== undefined && typeof patch.isPinned !== 'boolean') {
      throw new AppError('invalid_input', 'isPinned must be a boolean');
    }

    await this.deps.repos.workspaces.update(id, {
      ...(name !== undefined ? { name } : {}),
      ...(patch.isUnread !== undefined ? { isUnread: patch.isUnread } : {}),
      ...(patch.isPinned !== undefined ? { isPinned: patch.isPinned } : {}),
    });
    if (patch.status !== undefined && patch.status !== current.status) {
      await this.setStatus(id, patch.status);
    }

    const updated = await this.deps.repos.workspaces.getById(id);
    if (updated === null) {
      throw new AppError('not_found', `workspace not found: ${id}`);
    }
    return updated;
  }

  /** Inspect dirty state and configured deletion behavior before archive confirmation. */
  async archivePreview(id: string): Promise<WorkspaceArchivePreview> {
    const ws = await this.deps.repos.workspaces.getById(id);
    if (ws === null) {
      throw new AppError('not_found', `workspace not found: ${id}`);
    }

    const willDeleteWorktree =
      this.deps.settings.get().git.deleteWorktreeOnArchive &&
      (ws.location ?? 'worktree') === 'worktree' &&
      ws.worktreePath !== null;
    if (ws.worktreePath === null) {
      return {
        hasUncommittedChanges: false,
        changedFileCount: 0,
        willDeleteWorktree,
      };
    }

    const status = await this.deps.git.status(ws.worktreePath);
    return {
      hasUncommittedChanges: !status.clean,
      changedFileCount: status.files.length,
      willDeleteWorktree,
    };
  }

  /** List workspaces for a project (archived filtered out unless requested). */
  async list(
    projectId: string,
    includeArchived?: boolean,
  ): Promise<Workspace[]> {
    const all = await this.deps.repos.workspaces.listByProject(projectId);
    return includeArchived ? all : all.filter((w) => w.status !== 'archived');
  }

  /**
   * Archive a workspace (spec §5.1): run the optional archive script
   * (best-effort) → stop its process tree → optionally remove the managed git
   * worktree according to settings → set status `archived` (KEEPING the DB row) →
   * emit `workspace:archived` with the retained/null checkout path.
   *
   * Emits its OWN terminal event rather than routing through `setStatus`
   * (documented exception to README §6.4) so the renderer treats archival as a
   * distinct lifecycle transition. The force-remove happens ONLY after the stop
   * hook so no process is holding the worktree open (phase doc §8).
   */
  async archive(id: string): Promise<void> {
    const ws = await this.deps.repos.workspaces.getById(id);
    if (ws === null) {
      throw new AppError('not_found', `workspace not found: ${id}`);
    }

    const settings = this.deps.settings.get();
    if (settings.scripts.archive !== undefined && ws.worktreePath !== null) {
      try {
        await this.deps.runSetup(settings.scripts.archive, {
          cwd: ws.worktreePath,
          env: settings.env,
        });
      } catch {
        /* teardown best-effort */
      }
    }

    // INTEGRATION(phase-3): stop long-running processes BEFORE the force-remove.
    await this.deps.stopWorkspaceProcesses(id);

    const deleteWorktree =
      settings.git.deleteWorktreeOnArchive &&
      ws.worktreePath !== null &&
      (ws.location ?? 'worktree') === 'worktree';

    if (deleteWorktree && ws.worktreePath !== null) {
      const project = await this.deps.repos.projects.getById(ws.projectId);
      if (project !== null) {
        await this.deps.git.removeWorktree(
          project.repoPath,
          ws.worktreePath,
          true,
        );
      }
    }

    const archivedWorktreePath = deleteWorktree ? null : ws.worktreePath;
    // Keep the row and optionally retain its checkout for a fast, non-destructive restore.
    await this.deps.repos.workspaces.update(id, {
      worktreePath: archivedWorktreePath,
      status: 'archived',
      archivedAt: Date.now(),
    });

    // Emit AFTER the DB write commits.
    this.deps.emit('workspace:archived', {
      workspaceId: id,
      worktreePath: archivedWorktreePath,
    });
  }

  /**
   * Restore an archived workspace (spec §5.1): reuse a preserved checkout or
   * re-add a deleted worktree from its existing branch, then set status to `idle`.
   *
   * If the branch no longer exists, degrade gracefully with a typed `AppError`
   * — checkpoint-based branch recreation is a Phase-4 capability.
   *
   * @returns the restored workspace DTO.
   */
  async restore(id: string): Promise<Workspace> {
    const ws = await this.deps.repos.workspaces.getById(id);
    if (ws === null) {
      throw new AppError('not_found', `workspace not found: ${id}`);
    }

    const project = await this.deps.repos.projects.getById(ws.projectId);
    if (project === null) {
      throw new AppError('not_found', `project not found: ${ws.projectId}`);
    }

    // When archive deletion is disabled, the checkout remains registered with Git.
    // Restoring only needs to reactivate the persisted workspace row.
    if (ws.worktreePath !== null) {
      await this.deps.repos.workspaces.update(id, { archivedAt: null });
      await this.setStatus(id, 'idle');
      return (await this.deps.repos.workspaces.getById(id)) ?? ws;
    }

    if ((ws.location ?? 'worktree') === 'project') {
      const live = (
        await this.deps.repos.workspaces.listByProject(ws.projectId)
      ).filter(
        (workspace) => workspace.status !== 'archived' && workspace.id !== id,
      );
      if (live.some((workspace) => workspace.location === 'project')) {
        throw new AppError(
          'conflict',
          'the project checkout is already used by another workspace',
        );
      }
      const branch = await this.deps.git.currentBranch(project.repoPath);
      if (branch === 'HEAD') {
        throw new AppError(
          'conflict',
          'the project checkout is detached; check out a branch before restoring it',
        );
      }
      await this.deps.repos.workspaces.update(id, {
        branch,
        worktreePath: project.repoPath,
        archivedAt: null,
      });
      await this.setStatus(id, 'idle');
      return (await this.deps.repos.workspaces.getById(id)) ?? ws;
    }

    const worktreePath = join(worktreesDir(project.id), ws.name);
    const exists = await this.deps.git.branchExists(
      project.repoPath,
      ws.branch,
    );
    if (exists) {
      // Checkout the existing branch — no `-b`, no clobber.
      await this.deps.git.addWorktree(
        project.repoPath,
        worktreePath,
        ws.branch,
        ws.baseBranch,
        false,
      );
    } else {
      // INTEGRATION(phase-4): recreate the branch from the last checkpoint ref
      throw new AppError(
        'git',
        `cannot restore workspace: branch "${ws.branch}" no longer exists and checkpoint-based recreation is unavailable until Phase 4`,
        { workspaceId: id },
      );
    }

    // Re-attach the worktree path + clear the archive stamp before flipping status.
    await this.deps.repos.workspaces.update(id, {
      worktreePath,
      archivedAt: null,
    });

    // Route the terminal state change through the sole status emitter.
    await this.setStatus(id, 'idle');

    return (await this.deps.repos.workspaces.getById(id)) ?? ws;
  }

  /**
   * The ONLY path that transitions a workspace's base status and emits
   * `workspace:status` (README §6.4). Persists the new status, THEN emits the
   * broadcast event (post-commit). Driven by Phase 2 (turn lifecycle), Phase 3
   * (run overlay), and Phase 5 (failing checks), plus `restore` here.
   */
  async setStatus(id: string, status: Workspace['status']): Promise<void> {
    await this.deps.repos.workspaces.setStatus(id, status);
    // Emit AFTER the write commits.
    this.deps.emit('workspace:status', { workspaceId: id, status });
  }
}
