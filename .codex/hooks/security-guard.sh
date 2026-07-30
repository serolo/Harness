#!/usr/bin/env bash
# PreToolUse blast-radius guard (NOT a secret-scanner/SAST — see .claude/rules/security.md).
# Hard-denies, even under --dangerously-skip-permissions:
#   - reading/writing a REAL .env (allows .env.example/.sample/.template)
#   - recursive/forced deletes: rm -rf, rm -fr, find ... -delete, git clean -d/-f/-x
# Reads the hook JSON on stdin. python3 is used for parsing (present on macOS/Linux);
# `python3 -c '<script>'` leaves stdin free for the JSON payload.
exec python3 -c '
import json, re, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # unparseable payload -> do not block

tool = data.get("tool_name", "")
ti = data.get("tool_input") or {}

def deny(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)

# --- real .env protection (Read/Write/Edit) ---
if tool in ("Read", "Write", "Edit", "NotebookEdit"):
    path = ti.get("file_path") or ti.get("path") or ""
    base = path.rsplit("/", 1)[-1]
    if base == ".env" or (
        base.startswith(".env.")
        and not base.endswith((".example", ".sample", ".template"))
    ):
        deny(f"Blocked: \"{path}\" is a real .env (may hold secrets). Use .env.example instead.")

# --- destructive recursive deletes (Bash) ---
if tool == "Bash":
    cmd = ti.get("command", "") or ""
    patterns = [
        r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f",   # rm -rf / -Rf / -rvf ...
        r"\brm\s+-[a-zA-Z]*f[a-zA-Z]*r",   # rm -fr ...
        r"\bfind\b[^\n]*\s-delete\b",        # find ... -delete
        r"\bgit\s+clean\b[^|;&\n]*-[a-zA-Z]*[dfx]",  # git clean -d/-f/-x
    ]
    for pat in patterns:
        if re.search(pat, cmd):
            deny(f"Blocked destructive command (recursive/forced delete): {cmd}")

sys.exit(0)
'
