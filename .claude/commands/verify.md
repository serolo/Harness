---
description: PIV step 3 (Validate). Prove a change is done with evidence — run the gate, name the test that exercises the new behaviour, show it working, walk the Definition of Done, self-critique. Enforced by the Stop hook.
argument-hint: "[optional: what you changed / feature slug]"
---

# /verify — Evidence before "done"

Prove the change described by `$ARGUMENTS` (or the current working-tree diff) actually works.
**Assert nothing without evidence.** This is the Validate step of the PIV loop; the **Stop hook**
(`.claude/hooks/stop-validate.sh`) is the deterministic backstop behind it. For deeper completion-
truth, delegate to the **`verifier`** agent (it exists to refute "done").

Work through all six steps and report each:

### 1. Restate the goal
One or two sentences: what was this change supposed to do? What are its acceptance criteria (from
the plan/report in `plans/` / `reports/`, if any)?

### 2. Run the gate
```
bash ci/harness-gates.sh                        # full: npm run check (tsc -b, eslint, vitest, electron-vite build)
bash ci/harness-gates.sh format lint typecheck  # fast subset while iterating
```
Paste the real result. If anything fails, fix and re-run — do not proceed to step 3 on red.

### 3. Name the test that exercises the NEW behaviour
Point at the specific `*.test.ts(x)` and case that would fail without this change, and run just it:
```
node scripts/vitest-electron.mjs run <path/to/the.test.ts>
```
"The suite passes" is not enough — name the test that pins *this* behaviour. For a bug fix, confirm
it was the failing-regression-test-first (red → green).

### 4. Show the behaviour
Demonstrate it, don't claim it. Pick what fits the change:
- **Main-process logic** (git/pty/db/workspace/ipc): a Vitest case or a small script + its output.
- **Renderer/UI**: run the app (`npm run dev`) or a Playwright check (`npm run test:e2e`), and
  describe/screenshot what changed.
- **IPC channel**: show the round-trip (handler → preload → renderer) succeeding, or the typed
  `AppError` surfacing correctly across the boundary.

### 5. Walk the Definition of Done
- Gate green (§2); a test exercises the new behaviour (§3); behaviour shown (§4).
- Touched `src/shared/**`? Confirm it was **append-only** (the IPC contract is frozen — see
  `src/shared/ipc.ts`), never a reorder/rewrite of existing entries.
- New IPC capability wired end-to-end (handler + preload bridge + renderer client + shared types)?
- Renderer hardening intact (no `ipcRenderer`/`require`/Node globals leaked past preload)?
- DB schema change → migration in `scripts/migrate.ts` + rollback note?
- Non-obvious new behaviour documented in the nearest `CLAUDE.md`?

### 6. Self-critique
State the weakest part of the change, any duplication introduced, and which
**heightened-scrutiny paths** (`.claude/rules/security.md`: IPC/preload boundary, process/PTY exec,
git/fs on user workspaces, db/migrations, secrets, packaging) it touches — and whether each got the
scrutiny it needs.

End with an explicit **VERIFIED / NOT VERIFIED** and, if not, the exact remaining work.
