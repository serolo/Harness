# Implementation Report: Phase 1 — Workspace Engine

## Plan
`plans/phase-1-workspace-engine-plan.md`

## Orchestration
**Mechanism:** parallel-subagents (leaf group) → sequential subagent chain (spine) → evaluator-optimizer (review + verify).

The plan's Execution Strategy named the **team** path (the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` flag was `1` and `TeamCreate` was available at runtime). I deliberately used the **parallel-subagent fallback** the plan blesses instead: the work is one small 2-agent parallel leaf group followed by a strictly-sequential spine (WorkspaceManager → IPC/wiring → UI → tests), so a full team's task-list/message/shutdown ceremony bought no parallelism the spine could use. This realizes the plan's stated pattern (`parallelization → prompt-chaining → evaluator-optimizer`) with tighter per-task validation control in the main session. Spine order was reconciled so shared types land before their consumers: **Task 4 (shared) → Task 3 (WorkspaceManager) → Task 6 (IPC+wiring) → Task 7 (UI) → Task 8 (tests)**.

| Agent / role | Task(s) | Outcome |
|---|---|---|
| coder (git) — leaf ∥ | Task 1 — GitService bodies | DONE |
| coder (allocators) — leaf ∥ | Tasks 2, 5 — naming/ports/setup | DONE |
| (main session) | Task 4 — append-only shared contract (`@shared/ipc`, `@shared/models`) | DONE |
| coder (workspace-manager) | Task 3 — WorkspaceManager create/archive/restore/setStatus | DONE |
| coder (ipc-wiring) | Task 6 — IPC handlers + stream producers + `createAppContext` | DONE |
| frontend-designer (ui) | Task 7 — sidebar/dashboard, store, hooks | DONE |
| test-author (tests) | Task 8 — git/allocator/manager/renderer tests + AppLayout test fix | DONE |
| code-review + verifier | evaluator-optimizer pass | DONE — no blockers; COMPLETE verdict |

The append-only `src/shared/**` files were touched by a single owner (the main session) to avoid concatenation conflicts, per the plan's file-ownership rule.

## Tasks Completed
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | GitService (clone/open/defaultBranch/fetch/addWorktree/removeWorktree/worktreeList/branchExists/headInfo/mergeBase) over execa | DONE | Phase-4 methods (`status`/`diff`/`commitTree`/`updateRef`/`resetHard`) left throwing |
| 2 | naming + ports allocators (pure/injectable) | DONE | 50 cities, `-2/-3…` exhaustion; port probe with TOCTOU caveat |
| 3 | WorkspaceManager — sole status writer; create/archive/restore | DONE | Port allocated pre-setup; events emitted post-commit |
| 4 | Append-only shared contract + IPC payload types | DONE | `CloneProgress`, `WorkspaceCreateEvent`, `CreateWorkspaceReq`, Commands + StreamChannels entries |
| 5 | setup-runner (`runSetup`, execa, streamed) | DONE | `// INTEGRATION(phase-3)` seam-marked |
| 6 | IPC handlers + stream producers + main wiring | DONE | `streamProducers` exhaustiveness satisfied; deps injected into WorkspaceManager |
| 7 | Sidebar/dashboard UI with live status badges | DONE | Project switcher, add/clone, New-Workspace dialog (PR/Issue tabs disabled), setup-log panel, archive/restore |
| 8 | Tests (independent test-author) | DONE | 103 tests, 9 files, all green |

## Files Changed
- **Created (production):** `src/main/workspace/naming.ts`, `src/main/workspace/ports.ts`, `src/main/workspace/setup.ts`, `src/renderer/features/sidebar/{hooks.ts,StatusBadge.tsx,WorkspaceItem.tsx,SetupLogPanel.tsx,NewWorkspaceDialog.tsx,AddProjectMenu.tsx,ProjectSwitcher.tsx}`
- **Created (tests):** `src/main/git/index.test.ts`, `src/main/workspace/naming.test.ts`, `src/main/workspace/ports.test.ts`, `src/main/workspace/index.test.ts`, `src/renderer/features/sidebar/Sidebar.test.tsx`
- **Modified:** `src/main/git/index.ts`, `src/main/workspace/index.ts`, `src/shared/ipc.ts` (append-only), `src/shared/models.ts` (append-only), `src/main/ipc/register.ts`, `src/main/index.ts`, `src/renderer/stores/workspaces.ts`, `src/renderer/features/sidebar/Sidebar.tsx`, `src/renderer/app/AppLayout.test.tsx` (Providers wrapper for the now-Query-backed sidebar)

## Validation Gate Results
`bash ci/harness-gates.sh` (== `npm run check`) → **exit 0**.

| Gate | Result |
|------|--------|
| format (prettier -c .) | PASS |
| lint (eslint .) | PASS |
| typecheck (tsc -b, all refs) | PASS |
| tests (vitest, Electron ABI) | PASS — 103 passed / 9 files. New-behavior tests: `WorkspaceManager.create` → worktree on disk + `status=idle` + streamed setup log; create→archive→restore disk/DB/event cycle; `GitService` worktree lifecycle vs real git in tmpdir; `Sidebar` badge flips on a live `workspace:status` event |
| build (electron-vite build) | PASS |

## Acceptance Criteria
- [x] Add a local repo and clone a remote; both register as projects with the correct default branch. (`project:add`/`project:clone` → `GitService.open`/`defaultBranch`; git tests)
- [x] Create a workspace → real worktree at `worktrees/<city>/`, new branch off base, allocated free port, `status=idle`, setup script ran and streamed. (`WorkspaceManager.create` + `workspace/index.test.ts`)
- [x] Create N workspaces → unique city names, distinct ports, no file conflicts. (allocators + "two workspaces distinct" test)
- [x] Archive → process-stop hook invoked, worktree gone from disk, DB rows retained, status `archived`. (archive tests incl. new stop-hook-invoked assertion)
- [x] Restore → worktree re-created; status back to `idle`; graceful `AppError` when a deleted branch needs the absent Phase-4 checkpoint path. (restore tests incl. new deleted-branch degradation test)
- [x] Sidebar lists projects/workspaces with live status badges; archived rows greyed with restore; New-Workspace dialog validates + streams setup log; PR/Issue tabs present but disabled. (sidebar components + `Sidebar.test.tsx`)
- [x] All blocking gates pass.

## Post-review fixes applied (from code-review + verifier)
- **H1** — `AddProjectMenu` now aborts the `project:clone` stream on unmount (`AbortController` + effect cleanup), preventing a leaked main-side producer / `git clone` child.
- **M4** — `GitService.defaultBranch`'s network fallback (`git remote show origin`) now has a 5s timeout so a slow/unreachable remote can't hang the IPC handler (falls through to local HEAD).
- **Test coverage** — added an assertion that `archive` invokes the process-stop hook with the workspace id, and a test that `restore` on a deleted branch rejects with a `git` `AppError` and leaves the row `archived` (both were acceptance-criteria paths the verifier flagged as unverified).

## Issues / Deviations
- **Orchestration deviation** (documented above): parallel-subagents instead of the flagged team path.
- **Deferred review findings (non-blocking, no acceptance-criteria impact):**
  - **H2** — `project:clone` clones into `repoDir(uuidv7())`, which `ensureDir`-creates the (empty) destination first; `git clone` into an empty dir succeeds today, but the dir id differs from the persisted `Project.id`. Functional (git worktrees are created under the row's own `projects/<id>/worktrees/`), but worth co-locating in a later pass. Left as-is to avoid touching the frozen `paths` module / repos this phase.
  - **M1** — `WorkspaceCreateEvent` includes `{kind:'phase'}` frames that the producer never emits (the manager only streams setup-log chunks + a terminal `created`). The dialog's phase line is harmless forward-compat; emitting real phase frames (or trimming the branch) is a small follow-up.

## Heightened-scrutiny paths touched
None. No auth/SSO, secrets, payment/FOP, PII, GDS, i18n, or DB migrations (Phase 1 is intentionally migration-free — PR/issue `sourceKind`/`sourceRef` persist in the existing `0001` columns). `setup.ts` runs a shell command, but strictly from read-only `settings.scripts.setup` in the workspace cwd with no untrusted interpolation (reviewer confirmed appropriately scoped).

## Ready for Review
All 8 tasks done; every blocking gate green (`bash ci/harness-gates.sh` → exit 0); independent code-review + verifier returned **COMPLETE** with no blockers. Suggested handoff: `/verify` (evidence write-up) then `/harness-review`.
