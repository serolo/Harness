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
#   dispatch_isolation BLOCKING security       pr:merge unreachable from src/main/dispatch/ (Phase 11)
#   deps_verify  BLOCKING   supply-chain      npm install --dry-run (catches hallucinated/missing deps)
#   deps_audit   ADVISORY   supply-chain      npm audit --audit-level=high (never fails the run)
#   check|all    -          -                 alias for the full ordered gate set
#
# Exits non-zero on the first failing BLOCKING gate. ADVISORY gates warn but never fail.
set -euo pipefail

# Run from the repo root regardless of caller CWD.
cd "$(dirname "$0")/.."

# The full ordered gate set used for a no-arg (or `check`/`all`) run.
FULL_GATES="format lint typecheck tests build dispatch_isolation deps_verify deps_audit"

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
    dispatch_isolation)
      # Phase 11 invariant: a human ALWAYS merges — `pr:merge` must be provably unreachable
      # from cross-workspace dispatch CODE. Fail if the merge channel id (or the PrWorkflow
      # implementation it lives in) is referenced from any TypeScript source under
      # src/main/dispatch/. Scoped to *.ts(x) on purpose: the subsystem's CLAUDE.md documents
      # this very invariant by name, and documentation naming the forbidden thing is not a
      # reachability violation.
      # A missing src/main/dispatch/ (before the subsystem lands) is a no-match => OK: grep
      # exits non-zero on both no-match and missing-path, and an `if` condition swallows that
      # under `set -euo pipefail` (2>/dev/null hides the "No such file or directory" noise).
      echo "==> dispatch_isolation (pr:merge unreachable from src/main/dispatch/ *.ts)"
      if grep -rqn --include='*.ts' --include='*.tsx' "pr:merge" src/main/dispatch/ 2>/dev/null; then
        echo "FAIL: pr:merge reachable from src/main/dispatch/ — a human always merges" >&2
        exit 1
      fi
      if grep -rqn --include='*.ts' --include='*.tsx' "integrations/github/pr" src/main/dispatch/ 2>/dev/null; then
        echo "FAIL: PrWorkflow (integrations/github/pr) imported into src/main/dispatch/" >&2
        exit 1
      fi
      echo "dispatch_isolation: OK"
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
      echo "valid gates: format | lint | typecheck | tests | build | dispatch_isolation | deps_verify | deps_audit | check" >&2
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
