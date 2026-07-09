# src/main/checkpoint — per-turn worktree checkpoints + revert (Phase 4)

**Purpose:** `CheckpointService` snapshots a workspace's worktree after every turn WITHOUT touching the
user's branch history, and can revert the worktree to any past checkpoint. Heightened-scrutiny path
(destructive worktree ops) — the invariants below are load-bearing.

## How it works
- Constructed in `src/main/index.ts` with `{ git, getWorkspace, checkpoints: CheckpointsRepo, turns: TurnsRepo }`.
- Fired from the supervisor's `onTurnEnd` hook (best-effort, off the finalize path — a snapshot failure
  never wedges a turn).

## Non-obvious behaviour (document-worthy)
- **Scratch-index snapshot — never moves HEAD/branch.** `snapshot` delegates to `git.commitTree`, which
  stages the worktree into a *temporary* index (`GIT_INDEX_FILE` set per-call, never globally) → `write-tree`
  → `commit-tree`, then `git.updateRef` points `refs/checkpoints/<ws>/<turn-idx>` at the commit. The real
  `.git/index`, HEAD, and the branch are never touched. Checkpoints chain: each commit's parent is the
  previous per-turn checkpoint.
- **`refs/checkpoints/*` are ref-only.** The checkpoint commits are reachable ONLY via their refs, not from
  the branch — so branch/PR operations (push, diff-vs-base) must EXCLUDE them. That exclusion is a Phase-5
  concern; this service never pushes them.
- **Revert order is: validate → backup → resetHard → mark reverted.** `revert` resolves the target ref FIRST
  (a missing checkpoint is `not_found` and a true no-op — no stray backup ref), THEN auto-backs-up the current
  worktree to `refs/checkpoints/<ws>/backup/<ts>` (recoverable before anything destructive), THEN
  `git.resetHard` restores files (deleting ones added after the checkpoint) with **NO `git clean` and NO branch
  move**, THEN marks later turns reverted. Reverting twice is safe (idempotent-ish).
- **`turns.reverted_at` truncates chat.** `TurnsRepo.markRevertedAfter(ws, idx)` stamps every turn with a
  higher `idx` as reverted. Reverted turns keep their rows but are filtered out of `listByWorkspace` (chat
  history) and `latestSessionId` — so the NEXT turn after a revert starts a FRESH session (a running CLI
  session can't be truncated mid-stream). `nextIdx` deliberately does NOT filter, so ordinals keep climbing
  and ref names never collide after a revert.
- **`list` excludes `/backup/` refs** so the timeline shows only the per-turn checkpoints a user can revert to.
