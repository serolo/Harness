#!/usr/bin/env bash
# PostToolUse (Edit|Write): fast, NON-BLOCKING auto-tidy of the single file just touched.
# prettier --write -> eslint --fix. Always exits 0 (the Stop hook is the blocking gate).
# tsc and tests are intentionally skipped here: `tsc -b` is repo-wide and the Vitest
# runner boots Electron — both too slow for a per-edit hook. They run at /verify + the gate.
set -u

file="$(python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
ti=d.get("tool_input") or {}
print(ti.get("file_path") or "")' 2>/dev/null)"

[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0
case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs) ;;
  *) exit 0 ;;
esac

# Run from repo root (this script lives at .claude/hooks/).
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

npx prettier --write "$file" >/dev/null 2>&1 || true
npx eslint --fix "$file" >/dev/null 2>&1 || true
exit 0
