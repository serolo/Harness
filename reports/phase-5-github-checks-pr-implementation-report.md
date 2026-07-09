# Implementation Report: Phase 5 — GitHub Integration, Checks Panel & PR Workflow

## Plan
`plans/phase-5-github-checks-pr-plan.md`

## Orchestration
**Mechanism:** parallel-subagents (fallback). The plan named a **team** strategy *if*
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled; the env flag was `1` but the `TeamCreate`
tool was **not available** in this runtime, so per the skill's capability check I used the
**parallel-subagent path** — the plan's stated fallback. Foundation + convergence ran
sequentially; independent sections (auth·client, then checks·PR, then the two UI tasks) ran as
concurrent `coder`/`test-author` waves with disjoint file ownership. The lead session (me)
integrated between waves, made the small cross-cutting DTO addendum, fixed the one defect the
checks test-author surfaced, ran the gate, and applied the security-review findings.

> Note: a session-limit reset interrupted the first convergence wave (Task 8 + the Task 6/7
> test-authors) mid-flight; all three were re-launched fresh and completed.

| Agent / role | Task(s) | Outcome |
|---|---|---|
| coder (db) | 1 — migrations 0006/0007 + schema + IntegrationsRepo | DONE |
| coder (git) | 2 — GitService `commit`/`push`/`hasUpstream`/`currentBranch` | DONE |
| test-author (git) | 2 — `push-commit.test.ts` (13 tests, branch-only mutation-tested) | DONE |
| coder (shared) | 3 — `@shared/github`, `@shared/checks`, IPC append | DONE |
| coder (auth) | 4 — SecretStore + device/PAT auth + IntegrationService | DONE |
| test-author (auth) | 4 — `secrets.test.ts` + `auth.test.ts` (21 tests) | DONE |
| coder (client) | 5 — GithubClient (REST/GraphQL + ETag + backoff) | DONE |
| test-author (client) | 5 — `client.test.ts` (32 tests, 304/ETag) | DONE |
| coder (checks) | 6 — ChecksService aggregator | DONE (1 defect found+fixed) |
| test-author (checks) | 6 — `checks/index.test.ts` (31 tests) | DONE |
| coder (pr) | 7 — PR workflow (open/fix/merge) | DONE |
| test-author (pr) | 7 — `pr.test.ts` (18 tests, merge-gate mutation-tested) | DONE |
| coder (ipc/wiring) | 8 — IPC handlers + `github:connect` producer + main wiring | DONE |
| coder (workspace/renderer) | 9 — create-from-PR / create-from-issue | DONE |
| coder (renderer/ui) | 10 — Checks panel + settings + docs | DONE |
| code-review (security) | named review of Tasks 2,4,5,7,8 surface | DONE (2 medium → fixed) |

## Tasks Completed
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Migrations 0006/0007 + schema types + IntegrationsRepo | DONE | additive; token is only `token_ref` |
| 2 | GitService `commit` + `push` (branch-only) | DONE | arg-arrays; no `--all/--tags/--mirror` |
| 3 | Shared DTOs (`github`, `checks`) + IPC append | DONE | append-only; StreamChannel `github:connect` |
| 4 | SecretStore + auth (device flow + PAT) | DONE | safeStorage 0600; DB holds only ref |
| 5 | GithubClient (ETag cache + backoff) | DONE | 304-as-cache-hit; no secrets in errors |
| 6 | ChecksService (6 signals + blockers + actions) | DONE | atomic GitHub-group degrade (see below) |
| 7 | PR workflow (openPr/fixReviews/fixChecks/merge) | DONE | merge server-gated on green |
| 8 | IPC handlers + device-flow stream + main wiring | DONE | inputs validated/narrowed |
| 9 | Create-from-PR / create-from-issue | DONE | PR-head fetch + `pendingPrompt` seam |
| 10 | Checks panel UI + `agent.prPrompt` + docs | DONE | listener cleanup on unmount |

## Files Changed
### Created
- `src/main/db/migrations/0006_integrations.ts`, `0007_workspace_pr.ts`, `0006_integrations.test.ts`
- `src/main/db/repos/integrations.ts`
- `src/main/integrations/secrets.ts` (+ `secrets.test.ts`)
- `src/main/integrations/github/auth.ts` (+ `auth.test.ts`)
- `src/main/integrations/github/client.ts` (+ `client.test.ts`)
- `src/main/integrations/github/pr.ts` (+ `pr.test.ts`)
- `src/main/checks/index.test.ts`
- `src/shared/github.ts`, `src/shared/checks.ts`
- `src/renderer/stores/composer.ts`, `src/renderer/stores/checks.ts`
- `src/renderer/features/checks/{ChecksPanel,SignalRow,BlockerList,PrCard,MergeButton}.tsx`, `useChecks.ts`, `ChecksPanel.test.tsx`
- `src/renderer/features/sidebar/NewWorkspaceDialog.test.tsx`
- `src/main/checks/CLAUDE.md`, `src/main/integrations/CLAUDE.md`

### Modified
- `src/main/git/index.ts` — `commit`, `push` (fully-qualified refspec), `hasUpstream`, `currentBranch`, `fetchPullRequestHead`
- `src/main/db/schema.ts` — `IntegrationsTable`, `WorkspacesTable.pr_number`, `Database.integrations`
- `src/main/db/migrations/index.ts` — register 0006/0007
- `src/main/db/repos/workspaces.ts` — `prNumber` in create/update/rowToWorkspace
- `src/shared/ipc.ts` — Phase-5 `Commands` + `StreamChannels` (append-only)
- `src/shared/models.ts` — `Workspace.prNumber` (append)
- `src/main/integrations/index.ts` — `IntegrationService` implementation
- `src/main/checks/index.ts` — `ChecksService` implementation
- `src/main/ipc/register.ts` — Phase-5 handlers + `github:connect` producer
- `src/main/index.ts` — service construction + focus-refresh + turn-end recompute + teardown
- `src/main/context.ts` — `prWorkflow` on `AppContext`
- `src/main/settings/schema.ts` — `agent.prPrompt`
- `src/main/workspace/index.ts` — create-from-PR
- `src/renderer/features/sidebar/NewWorkspaceDialog.tsx` — From-PR / From-issue tabs
- `src/renderer/features/chat/Composer.tsx` — one-time `pendingPrompt` prefill
- `src/renderer/app/AppLayout.tsx` — mount `ChecksPanel` in the right pane
- Test fixture updates: `src/main/workspace/index.test.ts` (`prPrompt`), `src/renderer/features/sidebar/Sidebar.test.tsx` (`prNumber`), `src/main/db/migrations/0005_diff_review.test.ts` + `src/main/db/index.test.ts` (latest `user_version` 5→7 after appending migrations)

## Validation Gate Results
`bash ci/harness-gates.sh` → **exit 0** (full `npm run check`).

| Gate | Result |
|------|--------|
| format (prettier) | PASS |
| lint (eslint) | PASS |
| typecheck (tsc -b) | PASS |
| tests (vitest) | PASS — **352 passed / 36 files** |
| build (electron-vite) | PASS |

Tests that exercise the new behaviour (all green): `push-commit.test.ts` (branch-only push
mutation-tested), `secrets.test.ts`/`auth.test.ts` (ciphertext-at-rest, token-never-leaks,
device flow), `client.test.ts` (ETag 200→304 cache-hit), `checks/index.test.ts` (graceful
degrade + blocker state machine), `pr.test.ts` (merge server-gate mutation-tested),
`ChecksPanel.test.tsx` (merge-button gating + listener cleanup), `NewWorkspaceDialog.test.tsx`
(from-PR/from-issue + no-account empty state), `0006_integrations.test.ts` (migration + repo).

## Acceptance Criteria
- [x] Connect GitHub via device flow (and PAT); token `safeStorage`-encrypted on disk; DB stores only `token_ref`.
- [x] Checks panel shows git/PR/CI/deploy/review/todo signals for a workspace.
- [x] Red blockers gate the Merge button; each blocker's one-click action wired (commit&push / create PR / fix checks / fix reviews).
- [x] PR button commits+pushes+opens a PR (draft toggle honored; title/body seam for an agent draft, deterministic fallback otherwise).
- [x] "Fix review comments" / "Fix failing checks" feed real GitHub data into agent turns as attachments (truncated logs).
- [x] Merge (squash/merge/rebase per settings) works ONLY when green — **server-gated via a forced `checks.refresh`** (not the renderer button); post-merge archive suggestion returned.
- [x] Create workspace from a PR checks out the PR head; from an issue prefills the composer via `pendingPrompt`.
- [x] ETag/conditional caching + focus refresh (304 path tested; focus refreshes only viewed workspaces to avoid rate-limit thrash).
- [x] Migrations 0006/0007 apply cleanly on a fresh DB and are no-ops on re-run; `src/shared/**` changes append-only.
- [x] No plaintext token in SQLite, logs, error messages, or the renderer (asserted by tests).
- [x] All blocking gates pass; heightened-scrutiny paths got a named security review + independent test-authors.

## Issues / Deviations
- **Defect found & fixed during implementation (Task 6):** the independent checks test-author
  found the GitHub-signal group did not degrade *atomically* — if PR lookup succeeded but a
  later call (check-runs) threw, the `pr` row persisted while ci/deployment/review vanished
  silently. Fixed by accumulating the GitHub items in a local array and committing them to the
  result only if the whole group succeeds; the regression test stays green.
- **Security-review findings (2 medium, both fixed):**
  1. `merge()` read a possibly-stale cached `checks.get()`; changed to `checks.refresh()` so the
     gate always recomputes against the current head (the enforcement point, not the UI button).
  2. `git push` passed the branch as a bare positional arg (argument-injection surface for a
     `-`-leading ref); hardened to a fully-qualified `refs/heads/<b>:refs/heads/<b>` refspec —
     the positional token can never be parsed as an option, reinforcing the branch-only invariant.
- **Cross-cutting DTO addendum (done by the lead, not a task agent):** surfaced `pr_number` to the
  DTO layer (`Workspace.prNumber`, `rowToWorkspace`, repo create/update) so checks/PR/create-from-PR/UI
  share one type — done centrally to avoid multiple agents contending on `models.ts`/`workspaces.ts`.
- **Migration-test convention:** appending migrations bumped the "latest `user_version`" from 5→7 in
  two pre-existing runner tests (not owned by any task) — a mechanical, necessary update.
- **PR-draft via agent turn:** `pr:open` accepts an optional title/body (the seam for a
  renderer-run agent draft) and falls back to a deterministic title/body from the diff summary +
  `agent.prPrompt`; it does not itself start a turn (Phase-4 "prepare-the-turn" rule).
- **Create-from-PR** assumes a same-repo `pull/<n>/head` (fork PR heads are out of scope for v1;
  documented at the call site).

## Heightened-scrutiny paths touched
All five named in the plan: **secrets/tokens** (`integrations/secrets.ts`, `auth.ts`, `index.ts`) —
safeStorage at rest, DB holds only `token_ref`, no plaintext in logs/errors, path-traversal-guarded;
**IPC/preload boundary** (`ipc/register.ts` handlers + `github:connect` producer) — every payload
validated/narrowed, `tokenRef` never crosses to the renderer; **git/fs on user workspaces**
(`git/index.ts` commit/push/fetch, `workspace/index.ts` create-from-PR) — arg-arrays, branch-only
push, confined refs; **DB migrations** (`0006`/`0007`) — additive, token never a column;
**network egress** (`github/client.ts`) — ETag/backoff, no secrets in errors. A named `code-review`
security pass covered Tasks 2/4/5/7/8; independent test-authors (separate from coders) hardened each.

## Ready for Review
All 10 tasks done; all blocking gates green (`bash ci/harness-gates.sh` → exit 0, 352 tests);
security-review findings applied. Suggested next: `/verify` (evidence) then `/harness-review`.
