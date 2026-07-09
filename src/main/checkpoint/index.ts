// CheckpointService — per-turn worktree snapshots that never touch the user's
// branch history (spec §5.4). On each `turn_end`: stage everything into a temp
// index → `git commit-tree` → store the commit under
// `refs/checkpoints/<workspace>/<turn-idx>`. Revert hard-resets the worktree to a
// checkpoint (auto-backup FIRST, then restore). Implemented in Phase 4.
//
// Delegates all git plumbing to GitService (commitTree/updateRef/resetHard). Two
// load-bearing invariants (heightened-scrutiny, destructive-worktree path):
//   1. `snapshot` NEVER moves HEAD or the branch — it only `commit-tree`s a tree and
//      writes a `refs/checkpoints/*` ref. No checkout/commit/reset.
//   2. `revert` auto-backs-up the CURRENT worktree FIRST (so a mistaken revert is
//      always recoverable), then `resetHard`s to the target ref. It runs NO
//      `git clean` and never rewrites branch history — GitService.resetHard restores
//      files without moving HEAD.
//
// `refs/checkpoints/*` are ref-only objects: they are NOT reachable from the branch,
// so branch/PR operations (push, diff-vs-base) must exclude them. Excluding these
// refs from PR/branch ops is a Phase-5 concern — this service never pushes them.

import { AppError } from '@shared/errors';
import type { Checkpoint } from '@shared/review';
import type { Workspace } from '@shared/models';
import type { GitService } from '../git';
import type { CheckpointsRepo } from '../db/repos/checkpoints';
import type { TurnsRepo } from '../db/repos/turns';

// Re-export the shared DTO so downstream imports keep working against the frozen
// contract in `@shared/review` (no local duplicate declaration — Task 3).
export type { Checkpoint };

/**
 * Collaborators injected into {@link CheckpointService}. Construction happens in
 * `src/main/index.ts` (the orchestrator) — the service owns none of these directly.
 */
export interface CheckpointServiceDeps {
  git: GitService;
  /** Resolve a workspace by id (its `worktreePath` is where git operates). */
  getWorkspace: (id: string) => Promise<Workspace | null>;
  checkpoints: CheckpointsRepo;
  turns: TurnsRepo;
}

/**
 * Owns checkpoint creation + revert per workspace. Constructed in `src/main/index.ts`
 * with GitService + the repos injected via {@link CheckpointServiceDeps}.
 */
export class CheckpointService {
  constructor(private readonly deps: CheckpointServiceDeps) {}

  /**
   * Resolve the active worktree path for a workspace. Throws `not_found` when the
   * workspace does not exist, and `conflict` when it is archived (no worktree on
   * disk — `worktreePath` is null). Shared by snapshot + revert.
   */
  private async resolveWorktree(workspaceId: string): Promise<string> {
    const workspace = await this.deps.getWorkspace(workspaceId);
    if (workspace === null) {
      throw new AppError('not_found', `no workspace: ${workspaceId}`, {
        workspaceId,
      });
    }
    if (workspace.worktreePath === null) {
      // Archived workspaces have their worktree removed from disk.
      throw new AppError(
        'conflict',
        `workspace has no worktree (archived): ${workspaceId}`,
        { workspaceId },
      );
    }
    return workspace.worktreePath;
  }

  /**
   * Snapshot the workspace's worktree after a turn (spec §5.4): `commit-tree` the
   * current state and store it under `refs/checkpoints/<workspace>/<turn-idx>`.
   *
   * The new commit is threaded onto the previous per-turn checkpoint (via
   * `latestForWorkspace`) so checkpoints form a chain. MUST NOT move HEAD/branch —
   * only `commitTree` + `updateRef` run here.
   *
   * @param workspaceId workspace being snapshotted.
   * @param turnId the turn whose end triggered the snapshot.
   * @returns the created checkpoint record.
   */
  async snapshot(workspaceId: string, turnId: string): Promise<Checkpoint> {
    const worktreePath = await this.resolveWorktree(workspaceId);

    // The turn's ordinal keys the ref name; a missing turn is a programmer error
    // upstream, surfaced as not_found rather than a bad ref name.
    const turn = await this.deps.turns.getById(turnId);
    if (turn === null) {
      throw new AppError('not_found', `no turn: ${turnId}`, { turnId });
    }
    const idx = turn.idx;

    // Chain onto the previous per-turn checkpoint (backups are excluded by the repo).
    const parent = await this.deps.checkpoints.latestForWorkspace(workspaceId);
    const parents = parent ? [parent.sha] : undefined;

    const sha = await this.deps.git.commitTree(
      worktreePath,
      `checkpoint: turn ${idx}`,
      parents,
    );

    const refName = `refs/checkpoints/${workspaceId}/${idx}`;
    // commit-tree + update-ref only: HEAD and the user's branch are never touched.
    await this.deps.git.updateRef(worktreePath, refName, sha);

    return this.deps.checkpoints.create({ workspaceId, turnId, refName, sha });
  }

  /**
   * List a workspace's per-turn checkpoints, ordered by creation (monotonic with turn
   * order). Auto-backup refs (`.../backup/<ts>`) are filtered OUT so the timeline shows
   * only the per-turn snapshots the user can revert to.
   */
  async list(workspaceId: string): Promise<Checkpoint[]> {
    const all = await this.deps.checkpoints.list(workspaceId);
    return all.filter((c) => !c.refName.includes('/backup/'));
  }

  /**
   * Revert the workspace to the checkpoint at turn index `turnIdx` (spec §5.4). Order
   * is load-bearing:
   *   1. Resolve the target ref `refs/checkpoints/<ws>/<turnIdx>` FIRST; a missing
   *      checkpoint is `not_found` and the call is a true no-op (nothing on disk changes).
   *      Validating before the backup avoids leaving an orphan `.../backup/*` ref behind
   *      on a bad `turnIdx` — no destructive op runs between this check and the backup.
   *   2. Auto-backup the CURRENT worktree — a `commit-tree` stored under a
   *      `refs/checkpoints/<ws>/backup/<timestamp>` ref, recorded in the DB — so a
   *      mistaken revert is always recoverable BEFORE the reset runs.
   *   3. `resetHard` the worktree to the target ref — restores files (deleting ones added
   *      after the checkpoint). NO `git clean`; HEAD/branch are never moved.
   *   4. Mark later turns reverted so the next turn starts from the restored state.
   *
   * Reverting twice is safe: `markRevertedAfter` no-ops already-reverted turns and a
   * second `resetHard` to the same ref is idempotent (a fresh backup is still taken).
   */
  async revert(workspaceId: string, turnIdx: number): Promise<void> {
    const worktreePath = await this.resolveWorktree(workspaceId);
    const targetRef = `refs/checkpoints/${workspaceId}/${turnIdx}`;

    // 1. Resolve target ref FIRST — refuse (as a true no-op) if there is no checkpoint
    //    for that turn, so a bad turnIdx never creates a stray backup ref.
    const target = await this.deps.checkpoints.findByRef(
      workspaceId,
      targetRef,
    );
    if (target === null) {
      throw new AppError('not_found', 'no checkpoint for that turn', {
        workspaceId,
        turnIdx,
        targetRef,
      });
    }

    // 2. Auto-backup the current worktree — always recoverable before the reset. The
    //    backup row is associated with the target checkpoint's turn.
    const backupSha = await this.deps.git.commitTree(
      worktreePath,
      `backup before revert to turn ${turnIdx}`,
    );
    const backupRef = `refs/checkpoints/${workspaceId}/backup/${Date.now()}`;
    await this.deps.git.updateRef(worktreePath, backupRef, backupSha);
    await this.deps.checkpoints.create({
      workspaceId,
      turnId: target.turnId,
      refName: backupRef,
      sha: backupSha,
    });

    // 3. Restore worktree files to the checkpoint (no clean, no branch move).
    await this.deps.git.resetHard(worktreePath, targetRef);

    // 4. Drop later turns out of history so the next turn starts fresh.
    await this.deps.turns.markRevertedAfter(workspaceId, turnIdx);
  }
}
