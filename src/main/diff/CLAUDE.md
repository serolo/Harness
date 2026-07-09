# src/main/diff — diff computation + inline review comments (Phase 4)

**Purpose:** `DiffService` computes a workspace's diff (worktree vs `merge-base(HEAD, origin/<base>)`),
recomputes it on debounced FS events + after each turn, and owns the inline diff-comment lifecycle
(`open → sent → resolved`). It emits `diff:changed` so the renderer refetches.

## How it works
- Constructed in `src/main/index.ts` with `{ git, getWorkspace, emit, comments: DiffCommentsRepo }`.
- `getDiff` returns the main-only `GitDiff` (files + raw patch); the IPC handler maps it to the shared
  lightweight `DiffSet` (files + refs, **no patch**). Monaco fetches per-file `old`/`new` content lazily
  via `diff:file` (spec §9) so the list payload stays small for monorepos.

## Non-obvious behaviour (document-worthy)
- **Cache key = `(base, HEAD sha, status signature)`.** A single-slot per-workspace cache; `invalidate()`
  drops it on a watcher fire and on `turn_end` (wired in `main/index.ts`). The watcher and the turn-end
  hook are both idempotent, so a double-fire only recomputes — never corrupts.
- **Untracked files are surfaced manually.** `git diff <base>` only reports *tracked* changes, so `getDiff`
  folds each `status`-reported untracked path in as an `added` `DiffFile` (additions = its line count; a NUL
  byte ⇒ treated as binary ⇒ 0). This is why `getDiff` also runs `git status`.
- **`fileDiff` paths are UNTRUSTED.** They are confined to the worktree root (`..`/absolute escapes rejected)
  BEFORE any `git show`/fs read (heightened-scrutiny: git/fs on user workspaces). `oldContent` is read with
  `stripFinalNewline: false` so it stays byte-comparable with `newContent` (fs.readFile keeps the trailing
  newline) — otherwise every unchanged file tail renders a phantom "no newline at EOF" diff.
- **Auto-resolve is a CONSERVATIVE heuristic.** `reconcileComments` flips a `sent` comment to `resolved`
  only when its anchored line range on its side is no longer covered by ANY hunk in the fresh diff (the
  region now matches base). It deliberately prefers false negatives (a still-changing region stays `sent`);
  users can re-open. We do not store the send-time content, so an in-place edit cannot be detected precisely.
- **`buildSendToAgent` respects the frozen `Attachment` shape.** The `diff_comment` attachment requires a
  non-null line range + side + a non-empty `excerpt`; a comment without a resolvable range/excerpt is SKIPPED
  (left `open`) rather than emitting a shape-violating attachment.
- **Review turns are NOT persisted as such.** `review:run` only *composes* the prompt (settings
  `agent.reviewPrompt` + the diff summary) and returns it; the renderer feeds it into the normal `turn:start`
  and tags the launched turn as a "review turn" in local state for styling. That tag is lost on reload — a
  `turns.kind` column is a future migration (plan decision 2).
