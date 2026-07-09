#!/usr/bin/env bash
#
# harness-gates.sh — the one deterministic gate runner. Local == the checks /verify and the
# Stop hook lean on. Bridges the PIV toolchain to this repo's real tooling (npm, tsc -b,
# eslint, prettier, Vitest-under-Electron, electron-vite).
#
# Usage:
#   bash ci/harness-gates.sh                          # no args -> FULL gate (all blocking + advisory)
#   bash ci/harness-gates.sh format lint typecheck    # a subset, in order (the fast inner loop)
#   SKIP_GATES="deps_audit deps_verify" bash ci/harness-gates.sh   # run full set minus some gates
#
# Gates:
#   format       BLOCKING   maintainability   prettier -c .
#   lint         BLOCKING   maintainability   eslint .
#   typecheck    BLOCKING   maintainability   tsc -b (all project refs)
#   tests        BLOCKING   behaviour         node scripts/vitest-electron.mjs run
#   build        BLOCKING   integration       electron-vite build
#   deps_verify  BLOCKING   supply-chain      npm install --dry-run (catches hallucinated/missing deps)
#   deps_audit   ADVISORY   supply-chain      npm audit --audit-level=high (never fails the run)
#   check|all    -          -                 alias for the full ordered gate set
#
# Exits non-zero on the first failing BLOCKING gate. ADVISORY gates warn but never fail.
set -euo pipefail

# Run from the repo root regardless of caller CWD.
cd "$(dirname "$0")/.."

# The full ordered gate set used for a no-arg (or `check`/`all`) run.
FULL_GATES="format lint typecheck tests build deps_verify deps_audit"

run_gate() {
  local gate="$1"

  # Honor SKIP_GATES (space-separated list).
  case " ${SKIP_GATES:-} " in
    *" $gate "*)
      echo "==> $gate (SKIPPED via SKIP_GATES)"
      return 0
      ;;
  esac

  case "$gate" in
    format)
      echo "==> format (prettier -c .)"
      npx prettier -c .
      ;;
    lint)
      echo "==> lint (eslint .)"
      npx eslint .
      ;;
    typecheck)
      echo "==> typecheck (tsc -b)"
      npx tsc -b
      ;;
    tests)
      echo "==> tests (vitest-electron)"
      node scripts/vitest-electron.mjs run
      ;;
    build)
      echo "==> build (electron-vite build)"
      npx electron-vite build
      ;;
    deps_verify)
      echo "==> deps_verify (npm install --dry-run — catches hallucinated/missing packages)"
      npm install --dry-run --no-audit --no-fund
      ;;
    deps_audit)
      echo "==> deps_audit (npm audit --audit-level=high) [ADVISORY]"
      # ADVISORY: surface vulnerabilities but never fail the gate run.
      npm audit --audit-level=high || echo "ADVISORY: npm audit reported findings (non-blocking)."
      ;;
    check | all)
      echo "==> check (full gate set)"
      for g in $FULL_GATES; do
        run_gate "$g"
      done
      ;;
    *)
      echo "harness-gates: unknown gate '$gate'" >&2
      echo "valid gates: format | lint | typecheck | tests | build | deps_verify | deps_audit | check" >&2
      return 2
      ;;
  esac
}

if [ "$#" -eq 0 ]; then
  for gate in $FULL_GATES; do
    run_gate "$gate"
  done
  exit 0
fi

for gate in "$@"; do
  run_gate "$gate"
done
