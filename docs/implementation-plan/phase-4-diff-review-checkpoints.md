# Phase 4 — Diff Viewer, Review Loop & Checkpoints (Electron)

> **Read [`README.md`](./README.md) and [`phase-2-harness-chat.md`](./phase-2-harness-chat.md) (Attachment contract) first.**

**Spec refs:** §3 (checkpoints/diff_comments/todos), §5.3 (diff viewer), §5.4 (checkpoints), §8 (M4).
**Estimated size:** ~2 weeks. **Depends on:** Phase 0, Phase 1 (+ Phase 2 for "send to agent" and checkpoint-on-turn_end). **Parallelizable with:** Phase 3.

---

## 1. Goal

Make the review loop first-class: a live diff of the worktree vs the merge-base, a full diff viewer
(file tree, unified/side-by-side, syntax highlight, per-commit filter), inline comments that become
structured agent attachments ("send to agent"), a one-click agent review action, and per-turn
**checkpoints** with revert. Core differentiated value of the product (MVP-completing).

---

## 2. Scope

**In scope**
- `DiffService`: compute diff = worktree vs `merge-base(HEAD, origin/<base>)` using the `git` CLI;
  chokidar-driven recompute (debounced) + recompute after each `turn_end`; per-commit filtering via
  `git log base..HEAD`.
- Diff viewer UI: file tree with add/modify/delete badges + per-file stats; unified & side-by-side;
  syntax highlighting (Monaco diff editor); commit selector.
- Inline comments: select line range → comment → persist `diff_comments(open)`; "Send to agent"
  serializes open comments into `diff_comment` **attachments** (Phase 2 contract) on the next turn,
  marks them `sent`; auto-`resolved` when the referenced lines change.
- Agent **review action**: one-click turn with a canned review prompt over the current diff; render
  output as review annotations.
- `CheckpointService`: snapshot on each `turn_end` via `git commit-tree` into
  `refs/checkpoints/<ws>/<idx>` (never touches branch history); revert-to-turn-N with confirm +
  auto-backup + chat truncation + fresh session seeded with a summary.
- `todos` table (schema + basic CRUD); todo events from agent (`todo_update`) persisted.

**Out of scope**
- Checks panel aggregation / PR (Phase 5) — but todos feed it.

---

## 3. Task breakdown

### 3.1 DiffService (`src/main/diff/`)
```ts
class DiffService {
  compute(workspaceId: string, commitFilter?: CommitRange): Promise<DiffSet>;
  fileDiff(workspaceId: string, path: string): Promise<FileDiff>;   // hunks, both sides
  commits(workspaceId: string): Promise<CommitInfo[]>;              // base..HEAD
  watch(workspaceId: string): void;                                 // chokidar → debounce → diff:changed
}
```
- Base = `mergeBase(HEAD, origin/<baseBranch>)` (GitService). Diff includes **uncommitted** working-tree
  changes + committed changes since base. Implement via `git` CLI:
  `git diff --name-status <base>` + `git diff --numstat <base>` for the `DiffSet`; per-file hunks via
  `git diff <base> -- <path>` parsed into old/new line numbers for inline anchoring. Cache keyed on
  `(HEAD sha, worktree change signature)` to keep it fast (spec §9 monorepo note).
- `DiffSet` = per-file `{ path, changeKind, additions, deletions }` + tree structure. `FileDiff` =
  parsed hunks.
- **Watcher:** chokidar on the worktree (ignore `.git`, `node_modules` etc.), debounced ~300ms, plus a
  recompute trigger on Phase 2's `turn_end`. Emit `diff:changed { workspaceId }`; renderer refetches.
  Replaces Phase 2's poll-based badge.

### 3.2 Inline comments (`src/main/diff/comments.ts` + `diff_comments` table)
- CRUD over `diff_comments` (spec §3): `create(workspace, file, lineStart, lineEnd, side, body)` → state
  `open`; `listOpen`, `resolve`, `remove`.
- **Send to agent:** collect `open` comments → build `Attachment{ type:'diff_comment', file, lineStart,
  lineEnd, side, excerpt, body }` per comment (excerpt from `FileDiff`) → hand to `turn:start` (Phase 2)
  as attachments → mark comments `sent`.
- **Auto-resolve:** after a turn, if the referenced lines changed (compare new `FileDiff`), flip
  `sent`→`resolved`. Heuristic; document it.

### 3.3 Agent review action
- Canned prompt (from settings, overridable) + current `DiffSet` summary → `turn:start`. Tag the turn as
  a "review" turn so the transcript renders its output as review annotations (grouped by file).

### 3.4 CheckpointService (`src/main/checkpoint/`)
```ts
class CheckpointService {
  snapshot(workspaceId: string, turnIdx: number): Promise<Checkpoint>;  // on turn_end
  revert(workspaceId: string, turnIdx: number): Promise<void>;
  list(workspaceId: string): Promise<Checkpoint[]>;
}
```
- **snapshot** (spec §5.4): via the `git` CLI on the worktree — write a tree from a temp index
  (`GIT_INDEX_FILE` + `git add -A` + `git write-tree`) → `git commit-tree <tree> -p <prevCheckpoint>` →
  `git update-ref refs/checkpoints/<ws>/<turnIdx> <commit>` + `checkpoints` row. **Never** moves the
  user's branch. Called by Phase 2 on `turn_end` (wire the hook).
- **revert** (spec §5.4): confirm + **auto-backup** current state as a checkpoint → `git read-tree`/
  `git checkout-index -af` (or `git restore --worktree --source=<ref> -- .`) to reset worktree files to
  the target ref → truncate visible chat after turn N (mark later `turns` reverted/hidden; keep rows) →
  **start a fresh agent session seeded with a summary** of retained turns (CLI sessions can't be
  truncated mid-stream). Coordinate the summary format with Phase 2.

### 3.5 Todos (`todos` table)
- Migration + CRUD; persist agent `todo_update` events into `todos(source='agent')`; allow user todos
  (`source='user'`). Expose `todo:list(workspaceId)`; Phase 5 Checks panel consumes open count.

### 3.6 Diff viewer UI (`src/renderer/features/diff/`)
- File tree (badges A/M/D, +/- stats), file selector. Main view: Monaco `DiffEditor` (side-by-side) +
  unified toggle; syntax highlight; large-file guard (virtualize / lazy hunks).
- **Inline commenting:** gutter action on a selected line range → comment popover → persists; open
  comments in a review rail with "Send to agent" (bulk) + per-comment resolve.
- Commit filter selector (`base..HEAD`) to scope the diff.
- Checkpoint timeline: per-turn checkpoints with "revert to here" (confirm dialog explaining backup +
  session reset).
- Live-updates on `diff:changed`.

---

## 4. Data model owned by this phase
- Migration `0005_diff_review`: `checkpoints`, `diff_comments`, `todos` (spec §3) + indexes on
  `workspace_id`.

## 5. IPC surface added
- Commands: `diff:get(workspaceId, commitFilter?)`, `diff:file(workspaceId, path)`,
  `diff:commits(workspaceId)`, `comment:create|list|resolve|remove`, `comment:sendToAgent(workspaceId)`,
  `review:run(workspaceId)`, `checkpoint:list`, `checkpoint:revert(workspaceId, turnIdx)`,
  `todo:list|create|toggle`.
- Events: `diff:changed`.

## 6. Definition of Done
- [ ] Diff shows worktree-vs-merge-base with correct A/M/D + stats; updates live as files change and
      after each turn.
- [ ] Side-by-side and unified render with syntax highlighting; commit filter scopes the diff.
- [ ] Add inline comments → "Send to agent" → next turn receives them as `diff_comment` attachments
      (verify against Phase 2 rendered format); comments auto-resolve when lines change.
- [ ] "Agent review" runs a review turn and annotates the diff.
- [ ] Each `turn_end` writes a checkpoint ref (visible in the timeline) without altering branch history.
- [ ] Revert to turn N restores files, backs up current state, truncates chat, starts a fresh seeded
      session; subsequent turns work.
- [ ] Agent `todo_update`s persist and list. `npm run check` green.

## 7. Tests
- DiffService (temp repos, real `git`): committed + uncommitted changes vs merge-base; rename/delete;
  commit filter; watcher debounce fires `diff:changed`.
- Comments: create→send→attachment shape matches Phase 2 contract; auto-resolve on line change.
- CheckpointService: snapshot creates a ref not on branch history; revert restores worktree + backup
  exists; reverting twice is safe.
- Renderer (MockHarness): diff render, inline comment flow, checkpoint revert dialog.

## 8. Risks / notes
- **Checkpoint revert vs CLI session state mismatch** — fresh session + summary seeding (spec §9);
  document the chat-truncation behavior in-UI.
- **Large diffs / monorepo** — cache `git status`/diff results, lazy per-file hunks, virtualized tree
  (spec §9); sparse-checkout is Phase 7.
- **Auto-resolve heuristic** can mis-resolve — keep it conservative and let users re-open.
- **Exclude `refs/checkpoints/*`** from normal branch/PR operations (Phase 5 must ignore them; don't
  push them).
- **Temp-index git plumbing** (`GIT_INDEX_FILE`) must not disturb the user's real index — always use a
  scratch index path.
