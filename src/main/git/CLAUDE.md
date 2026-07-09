# src/main/git — git worktree lifecycle + diff/refs

**Purpose:** `GitService` wraps the system `git` binary for worktree lifecycle (clone, worktree
add/remove), status, refs, and diffs/checkpoints. The backbone of projects + workspaces.

## How it works
All operations shell out to `git -C <cwd> …` via **execa v9** (ESM-only) — chosen for fine-grained
control over `--progress` stderr streaming (e.g. clone progress frames pushed to a `StreamSink`).
Phase-0 interfaces (`GitStatus`, `DiffFile`, …) carry real, thought-through signatures that later
phases build against.

## Gotchas
- **The Phase-0 interfaces are frozen — `DO NOT modify`.** A wrong signature here is a contract
  break for every downstream phase. Extend by adding, not by rewriting.
- **execa is v9 / ESM-only** — `import { execa }`; do not `require()` it or pin a CommonJS version.
- **git + filesystem on user workspaces is a heightened-scrutiny path** (`.claude/rules/security.md`):
  confine paths to the intended repo/worktree root, reject `..` traversal, and treat destructive ops
  (worktree remove, `git clean`, reset --hard) with care — they act on the user's real repositories.
  Note the `security-guard` hook hard-blocks `git clean -d/-f/-x` and `rm -rf`.
- Parse porcelain output defensively; normalize into the typed `GitStatusEntry`/`DiffFile` shapes
  rather than leaking raw git strings upward.
- This app's own checkout may be a **detached worktree** — don't assume `git` commands succeed from
  the app's cwd; operate against explicit workspace paths.
