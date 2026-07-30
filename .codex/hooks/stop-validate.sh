#!/usr/bin/env bash
# Stop hook (BLOCKING): before the agent may finish, changed *.ts/tsx/js files must pass
# prettier --check + eslint (no auto-fix). Exit 2 blocks the stop and feeds the reason back.
# Escape: SKIP_STOP_VALIDATE=1. Fails OPEN when git can't list changes (detached worktree),
# so it never wedges the session — full enforcement returns once the git link is healthy.
set -u

[ "${SKIP_STOP_VALIDATE:-}" = "1" ] && exit 0

# Avoid an infinite stop<->continue loop: if we're already inside a stop-hook continuation, pass.
active="$(python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print("1" if d.get("stop_hook_active") else "0")' 2>/dev/null)" || active=0
[ "$active" = "1" ] && exit 0

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

# Changed + untracked files. If git errors (detached worktree link), fail open.
changed="$( { git diff --name-only --diff-filter=ACM && git ls-files --others --exclude-standard; } 2>/dev/null)" || exit 0
lintable="$(printf '%s\n' "$changed" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' || true)"
[ -n "$lintable" ] || exit 0

# shellcheck disable=SC2086
if ! fmt_out="$(npx prettier -c $lintable 2>&1)"; then
  {
    echo "Stop blocked: changed files are not Prettier-clean. Run: npx prettier --write <files>"
    echo "$fmt_out"
  } >&2
  exit 2
fi

# shellcheck disable=SC2086
if ! lint_out="$(npx eslint $lintable 2>&1)"; then
  {
    echo "Stop blocked: ESLint errors in changed files. Fix them, or set SKIP_STOP_VALIDATE=1 to bypass."
    echo "$lint_out"
  } >&2
  exit 2
fi

exit 0
