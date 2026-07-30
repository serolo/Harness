#!/usr/bin/env bash
# PreToolUse (Edit|Write|NotebookEdit): refuse to edit while on the default branch.
# Branch first. Fails OPEN when git can't resolve a branch (e.g. a detached worktree
# link) so it never wedges a session — it only ever blocks on a *known* main/master.
set -u

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0
case "$branch" in
  main | master)
    echo "Refusing to edit on '$branch'. Create a feature branch first: git checkout -b <feature>." >&2
    exit 2
    ;;
  *)
    exit 0
    ;;
esac
