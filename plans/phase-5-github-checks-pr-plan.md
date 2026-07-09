# Plan: Phase 5 — GitHub Integration, Checks Panel & PR Workflow

## Ticket / Feature
Connect GitHub (OAuth device flow + PAT, `safeStorage`-encrypted token), aggregate merge-readiness
**Checks** per workspace, run the PR workflow (commit+push+open PR with agent-drafted title/body,
ingest review threads, fix-review/fix-checks agent actions, merge), and complete Phase 1's deferred
create-from-PR / create-from-GitHub-issue (`docs/implementation-plan/phase-5-github-checks-pr.md`).

## Complexity
**High.** ~2 weeks, cross-cutting across `integrations`, `checks`, `git`, `db`, `settings`, `ipc`,
`workspace`, `harness` (turn-driven PR actions), and a new renderer feature. Touches **five**
heightened-scrutiny paths: **secrets/tokens** (`safeStorage`, `src/main/integrations`), the IPC/preload
boundary, **git/fs on user workspaces** (new `commit`/`push`), **DB migrations**, and network egress to
GitHub. Octokit REST+GraphQL are already deps; the risk is in token-at-rest handling, push auth, and
rate-limit discipline.

---

## Design decisions (recorded — sensible defaults chosen, not blocking)
Internal choices the spec leaves open. Defaults picked; revisit only if a reviewer objects.

1. **Keep the frozen `ChecksService` stub shape (`ChecksResult { state; items: CheckItem[]; updatedAt }`),
   not the doc §3.3 `Checks { git, pr?, ci, … }` literal.** The Phase-0 stub signatures
   (`get`/`refresh → ChecksResult`) are the contract downstream builds against, and `checks:updated`
   already carries `checks: unknown`. The six signal sources become `CheckItem`s (one per source, or a few
   per source), each carrying a typed per-source payload in `CheckItem.details` (new `@shared/checks.ts`
   discriminated union) and a `suggestedAction`. `blockers` = `items.filter(i => i.severity === 'blocker')`;
   `state` is `blocked` if any blocker, else `pending` if any pending, else `green`. Preserves the frozen
   signature while carrying everything the UI needs.
2. **PR number is a new `workspaces.pr_number INTEGER` column (migration `0007`), not overloaded onto
   `source_ref`.** `source_ref` describes creation origin (a PR/issue seed); a workspace created normally
   can still open a PR later and needs somewhere to store it. Additive, nullable.
3. **Device flow is implemented via manual `fetch` to GitHub's two device endpoints — no new dep.**
   `@octokit/auth-oauth-device` is avoided; the flow is two POSTs (`/login/device/code`,
   `/login/oauth/access_token`) + polling. The OAuth **App client id** comes from
   `AGENTAPP_GITHUB_CLIENT_ID` (build/env); when absent, only the **PAT** path is offered. The PAT path is
   the primary *testable* auth path (device flow needs a real app + human interaction).
4. **Token at rest:** `safeStorage.encryptString` → ciphertext written to `<userData>/secrets/<uuid>`
   (0600); the `integrations` row stores only `token_ref` (the file id). Guard
   `safeStorage.isEncryptionAvailable()` and fail with a typed `AppError('integration', …)` when false.
   Decrypt on demand; **never** log or DB-store plaintext.
5. **Push uses the user's git credential helper (never inject the OAuth token into the remote URL).**
   `git push origin <branch>` pushes ONLY the branch ref, so `refs/checkpoints/*` are never pushed
   (Phase 4 coordination — no `--all`/`--mirror`/`--tags`).
6. **Multi-account: schema supports N `integrations` rows; v1 UI resolves ONE active GitHub account** (the
   most-recently-connected, or the only one). `IntegrationService.github()` picks it.
7. **The create-from-issue "prefill" seam does not exist yet — build it renderer-side:** a small
   per-workspace `pendingPrompt` store consumed once by the chat `Composer` on mount. No persistence.

---

## Affected Files

### Read before implementing
- `src/main/integrations/index.ts` (whole) — `IntegrationService` stub + `Integration`/`PullRequest`/
  `CheckRun`/`OpenPrOptions` shapes to preserve/extend; bodies to implement.
- `src/main/checks/index.ts` (whole) — `ChecksService` stub + `ChecksResult`/`CheckItem`/`ChecksState`/
  `CheckSource`/`CheckSeverity` shapes (frozen signatures — preserve).
- `src/main/git/index.ts` (L1–214 frozen interfaces; L492–1170 existing methods incl. `headInfo` L808,
  `status` L897, `commitTree` L1025) — the arg-array/`toGitError`/`execa` idiom to mirror for `commit`/`push`.
- `src/main/db/schema.ts` (L143–151 `Database`) + `src/main/db/migrations/index.ts` (L14–16 registrations,
  latest version 5) + `src/main/db/migrations/0005_diff_review.ts` (migration + rollback-note style) +
  `src/main/db/repos/turns.ts` (row↔DTO repo pattern).
- `src/shared/ipc.ts` (`Commands` append block; `Events['checks:updated']`/`['notify:needsAttention']`
  already reserved; `StreamChannels` for the device-flow stream) + `src/shared/models.ts` (`Workspace`,
  `CreateWorkspaceReq`, `WorkspaceSourceKind`) + `src/shared/harness.ts` (`Attachment` for fix-review turns).
- `src/main/ipc/register.ts` (`handle(...)` + validation pattern L74–90/551–881; `streamProducers` map +
  `project:clone` producer L150–203 for the device-flow stream shape) + `src/main/paths.ts` (L28–70
  `userDataRoot` + test seam; add `secretsDir()`).
- `src/main/index.ts` (L46–47 imports, L341–342 `new ChecksService()/new IntegrationService()`,
  `createAppContext` service wiring, before-quit teardown, `BrowserWindow` focus for refresh).
- `src/main/settings/schema.ts` (L92–128 `git`/`agent` sections — `mergeStrategy`, `branchPrefix`,
  `prompts`; add the PR-draft prompt like `reviewPrompt`).
- `src/main/workspace/index.ts` (L101–160 `create` — `sourceKind`/`sourceRef` handling; `setStatus` L322)
  for create-from-PR (checkout PR head) + `needs_attention` on failing checks.
- `src/renderer/features/sidebar/NewWorkspaceDialog.tsx`, `src/renderer/features/chat/Composer.tsx`,
  `src/renderer/app/AppLayout.tsx` (right context pane placeholder), `src/renderer/ipc/index.ts`,
  `src/renderer/features/diff/useDiff.ts` (hook + `onEvent` cleanup pattern to mirror for checks).

### Modify
- `src/main/git/index.ts` — add `commit(worktreePath, message)` and `push(worktreePath, remote, branch,
  opts?)` (+ small helpers `hasUpstream`/`currentBranch` if needed). **Do not touch frozen interfaces.**
- `src/main/integrations/index.ts` — implement `IntegrationService` with injected deps; add auth
  (device/PAT), `github()` (authed Octokit), `disconnect`, token encrypt/decrypt via the secret store.
- `src/main/checks/index.ts` — implement `ChecksService.get/refresh` (compute six signals + blockers +
  next actions + cache + emit); import per-source detail types from `@shared/checks`.
- `src/main/db/schema.ts` — append `IntegrationsTable`; add `pr_number: number | null` to `WorkspacesTable`;
  add `integrations` to `Database`.
- `src/main/db/migrations/index.ts` — register `migration0006Integrations` + `migration0007WorkspacePr`.
- `src/main/settings/schema.ts` — add `agent.prPrompt` default (agent PR title/body draft) — mirror `reviewPrompt`.
- `src/main/ipc/register.ts` — add the Phase-5 command handlers + the `github:connect` stream producer.
- `src/main/index.ts` — construct `IntegrationService`/`ChecksService` with deps (db, git, safeStorage,
  emit, settings, workspaces); wire focus-refresh (`win.on('focus')`) + recompute triggers (`turn_end`
  via the Phase-4 `onTurnEnd` hook, `diff:changed`); teardown timers/window listeners in before-quit.
- `src/main/workspace/index.ts` — create-from-PR (fetch PR head → checkout that branch); surface PR seed.
- `src/renderer/app/AppLayout.tsx` — mount the Checks panel in the right context pane.
- `src/renderer/features/sidebar/NewWorkspaceDialog.tsx` — From-PR / From-issue tabs.
- `src/renderer/features/chat/Composer.tsx` — consume the `pendingPrompt` store once on mount.
- `src/renderer/ipc/index.ts` — verify generic bridge covers new channels (expected: no change).

### Create
- `src/main/db/migrations/0006_integrations.ts`, `.../0007_workspace_pr.ts` (+ their `*.test.ts`).
- `src/main/db/repos/integrations.ts` — `IntegrationsRepo` (CRUD, row↔DTO).
- `src/main/integrations/secrets.ts` — `SecretStore` (safeStorage encrypt/decrypt ↔ `<userData>/secrets/<id>`).
- `src/main/integrations/github/auth.ts` — device-flow + PAT state machine (fetch-based).
- `src/main/integrations/github/client.ts` — `GithubClient` (Octokit REST/GraphQL + ETag cache + backoff +
  `owner/name` mapping): `getPr`, `createPr`, `mergePr`, `listCheckRuns`, `listStatuses`, `listDeployments`,
  `listDeploymentStatuses`, `reviewThreads`, `resolveThread`, `listPrs`, `listIssues`.
- `src/main/integrations/github/pr.ts` — PR workflow (`openPr`, `fixReviews`, `fixChecks`, `merge`).
- `src/shared/github.ts` — cross-boundary DTOs: `GithubAccount`, `PrSummary`, `PrListItem`, `IssueListItem`,
  `ReviewThread`, `MergeMethod`, `ConnectStatus` (device-flow stream frames).
- `src/shared/checks.ts` — `ChecksResult`/`CheckItem` re-exports + typed `CheckDetails` per-source union.
- `src/renderer/features/checks/`: `ChecksPanel.tsx`, `SignalRow.tsx`, `BlockerList.tsx`, `PrCard.tsx`,
  `MergeButton.tsx`, `useChecks.ts`, `ChecksPanel.test.tsx`; `src/renderer/stores/checks.ts` +
  `src/renderer/stores/composer.ts` (the `pendingPrompt` seam).
- Tests: `src/main/integrations/github/{auth,client,pr}.test.ts`, `src/main/integrations/secrets.test.ts`,
  `src/main/checks/index.test.ts`, `src/main/db/repos/integrations.test.ts`, `src/main/git/push-commit.test.ts`.

---

## Ordered Tasks

> Dependency order: **foundation (1→3)** gates everything. Auth (4) + client (5) are independent; checks
> (6) + PR (7) depend on the client; convergence (8) depends on all services; UI (9→10) depends on IPC.

### Task 1 — Migrations `0006_integrations` + `0007_workspace_pr` + schema types
- What: `0006` creates `integrations(id, kind, account_label, token_ref, created_at)` (spec §3) with a
  `kind` index. `0007` runs `ALTER TABLE workspaces ADD COLUMN pr_number INTEGER`. Append `IntegrationsTable`
  + `pr_number` to `schema.ts`; add `integrations` to `Database`. Register both (versions 6, 7).
- Pattern: `src/main/db/migrations/0005_diff_review.ts` (raw `db.exec`, header ROLLBACK note). Rollback:
  `DROP TABLE integrations;` (0006); `pr_number` additive/nullable — harmless on downgrade, note it (0007).
- Gotcha: **DB migration = heightened scrutiny.** Purely additive; 0001/0003/0005 untouched. Token is
  NEVER a column — only `token_ref`.
- Validate: `node scripts/vitest-electron.mjs run src/main/db/migrations/0006_integrations.test.ts`

### Task 2 — GitService `commit` + `push`
- What: `commit(worktreePath, message)` = `git -C <wt> add -A` then `git -C <wt> commit -m <message>` with
  committer identity env (reuse the `commitTree` identity approach); no-op-safe when nothing staged (surface
  a typed "nothing to commit"). `push(worktreePath, remote='origin', branch, opts?: { setUpstream?: boolean })`
  = `git -C <wt> push [-u] <remote> <branch>` — pushes ONLY that branch (never `--all`/`--tags`/`--mirror`,
  so `refs/checkpoints/*` stay local). Add `hasUpstream(worktreePath)` if needed for the checks "unpushed".
- Pattern: existing GitService methods — arg arrays via `execa`, `toGitError` wrapping, `-C <path>`.
- Gotcha: **git on user workspaces = heightened scrutiny.** Arg arrays only (no shell strings); message is
  passed as an arg, never interpolated. Push relies on the user's credential helper — do NOT embed a token.
- Validate: `node scripts/vitest-electron.mjs run src/main/git/push-commit.test.ts`

### Task 3 — Shared DTOs (`@shared/github`, `@shared/checks`) + IPC contract append
- What: Create `src/shared/github.ts` + `src/shared/checks.ts` (import-safe both sides — no Node/DOM/electron).
  **Append** to `Commands`: `github:accounts`, `github:disconnect`, `checks:get`, `pr:open`, `pr:merge`,
  `pr:fixReviews`, `pr:fixChecks`, `github:listPrs`, `github:listIssues`, `review:resolveThread`. **Append**
  to `StreamChannels`: `github:connect` (`arg: { mode: 'device'|'pat'; token? }`, `chunk: ConnectStatus`).
  `checks:updated` + `notify:needsAttention` **already exist** in `Events` — do NOT re-add.
- Pattern: `src/shared/ipc.ts` Phase-4 append block; `StreamChannels['project:clone']` for the streamed
  connect. Move nothing existing; append only.
- Gotcha: `src/shared/**` is **FROZEN, append-only**. Adding a `StreamChannel` forces a matching
  `streamProducers` entry (tsc exhaustiveness) — handled in Task 8.
- Validate: `bash ci/harness-gates.sh typecheck`

### Task 4 — SecretStore + IntegrationsRepo + auth (device flow + PAT)
- What: `secrets.ts` `SecretStore` — `put(plaintext) → tokenRef` (safeStorage.encryptString →
  `<userData>/secrets/<uuid>` mode 0600), `get(tokenRef) → plaintext`, `remove(tokenRef)`; guard
  `isEncryptionAvailable()`. `IntegrationsRepo` (CRUD row↔DTO). `github/auth.ts` — PAT path (validate via
  `GET /user`) + device-flow state machine (fetch `/login/device/code` → emit `code` frame →
  poll `/login/oauth/access_token` honoring `interval`/`slow_down` → token). `IntegrationService`:
  `connectGithub(mode)` encrypts + persists an `integrations` row (token_ref + account_label), `list`,
  `disconnect` (delete row + ciphertext), `github()` → authed Octokit for the active account.
- Pattern: `src/main/paths.ts` test seam (`setUserDataRoot`) for a temp secrets dir in tests; repo pattern
  from `turns.ts`.
- Gotcha: **secrets = heightened scrutiny + mandatory verifier.** Plaintext token NEVER hits SQLite, logs,
  or errors (redact). `safeStorage` unavailable → typed error, not a crash. Test the encrypt→store→decrypt
  round-trip and assert the DB row holds only a ref.
- Validate: `node scripts/vitest-electron.mjs run src/main/integrations/secrets.test.ts src/main/integrations/github/auth.test.ts`

### Task 5 — GithubClient (Octokit REST/GraphQL + ETag cache + backoff)
- What: `client.ts` `GithubClient` built from an authed Octokit: `getPr`, `createPr`, `mergePr(method)`,
  `listCheckRuns(sha)`, `listStatuses(sha)`, `listDeployments`, `listDeploymentStatuses`, GraphQL
  `reviewThreads(pr)` + `resolveThread(id)`, `listPrs`, `listIssues`. Map `origin_url → { owner, name }`.
  **ETag/conditional caching** per endpoint (store last ETag+body; treat 304 as a cache hit). Handle
  `x-ratelimit-remaining` with backoff; per-PR GraphQL batching for review threads.
- Pattern: Octokit REST `octokit.request(...)` with `headers['if-none-match']`; catch 304. Tests inject a
  fake `request`/`fetch` (Octokit supports a custom `request.fetch`) — **no `nock` dep**; recorded fixtures.
- Gotcha: **network egress + rate limits.** No secrets in logs. `mergeableState` is eventually-consistent —
  expose it raw; the merge gate (Task 7) polls/retries. `owner/name` parse must handle both
  `https://…/o/r.git` and `git@…:o/r.git`.
- Validate: `node scripts/vitest-electron.mjs run src/main/integrations/github/client.test.ts`

### Task 6 — ChecksService (aggregate + blockers + next actions)
- What: Implement `refresh(workspaceId)` — gather **git** (`headInfo` ahead/behind, `status` uncommitted/
  unpushed), **pr** (`getPr`), **ci** (`listCheckRuns`+`listStatuses` rollup on the pushed head sha),
  **deployments**, **review** (`reviewThreads` unresolved count), **todos** (Phase-4 `TodosRepo`), into
  `CheckItem[]` with per-source `details` + `suggestedAction`; compute `blockers` + `state`. `get` returns
  the cache (compute-on-first-access). Emit `checks:updated { workspaceId, checks }`; raise `needs_attention`
  on failing CI (via injected `setStatus`/emit). In-memory cache keyed on the pushed head sha + a signature.
- Pattern: `DiffService` construction/caching/emit closure; `ChecksService` frozen stub signatures.
- Gotcha: degrade gracefully when no GitHub account / no PR / no pushed branch (git-only signals still
  render). Next-action mapping (spec §5.5): uncommitted→"Commit & push"; no PR→"Create PR"; failing
  check→"Fix failing checks"; unresolved threads→"Fix review comments"; open todos→list.
- Validate: `node scripts/vitest-electron.mjs run src/main/checks/index.test.ts`

### Task 7 — PR workflow (`github/pr.ts`)
- What: `openPr(workspaceId, { draft })` — `git.commit` if dirty (message from settings) → `git.push -u` →
  compose an agent-draft title/body prompt (`settings.agent.prPrompt` + diff summary; the actual turn runs
  over `turn:start`, so this returns the prompt/attachments OR runs the client `createPr` with a provided
  title/body — see decision) → `client.createPr` → persist `workspaces.pr_number`. `fixReviews(workspaceId)`
  — unresolved threads → `diff_comment`-style `Attachment[]` (reuse Phase 2/4 shape) for a turn; on
  resolution call `resolveThread`. `fixChecks(workspaceId)` — failing check-run logs (truncated) →
  attachments/prompt for a turn. `merge(workspaceId, method)` — refuse unless `blockers` empty; poll
  `mergeableState` until clean/timeout; `client.mergePr(method)`; return a post-merge archive suggestion.
- Pattern: Phase-4 `review:run`/`comment:sendToAgent` "prepare-the-turn, renderer feeds `turn:start`"
  decision — PR-draft + fix actions follow the same "don't start turns from a command" rule.
- Gotcha: **git push + merge = heightened scrutiny.** Merge is gated on green (enforce server-side too, not
  just UI). Exclude `refs/checkpoints/*` (branch-only push). Truncate check logs before sending to the agent.
- Validate: `node scripts/vitest-electron.mjs run src/main/integrations/github/pr.test.ts`

### Task 8 — IPC handlers + device-flow stream + main wiring
- What: Add handlers in `register.ts` for every Task-3 command (validate/narrow every input; `pr:merge`
  method ∈ {merge,squash,rebase}; ids non-empty). Add the `github:connect` **stream producer** (device/PAT
  frames). Wire `main/index.ts`: construct `IntegrationService`/`ChecksService` with deps (db, git,
  `SecretStore`, settings, emit, workspaces, todos); `win.on('focus')` → `checks.refresh` for the active
  workspace; recompute on the Phase-4 `onTurnEnd` hook + `diff:changed`; tear down interval timers + the
  focus listener in before-quit.
- Pattern: `register.ts` `handle(...)` + `streamProducers['project:clone']`; `main/index.ts` Phase-4 hook
  wiring.
- Gotcha: **IPC boundary = heightened scrutiny.** Treat all payloads as untrusted; never interpolate into
  shell/git strings (git via arg arrays). The generic preload/renderer bridge needs no per-channel edits.
- Validate: `bash ci/harness-gates.sh typecheck lint`

### Task 9 — Create-from-PR / create-from-issue (completes Phase 1)
- What: `github:listPrs`/`github:listIssues` handlers (Task 8). WorkspaceManager: create-from-PR fetches the
  PR head (`git fetch origin pull/<n>/head:<branch>`) and checks it out instead of branching from base;
  store `sourceKind:'pr'`/`sourceRef`. Renderer: extend `NewWorkspaceDialog` with From-PR / From-issue tabs;
  create-from-issue sets a `pendingPrompt` (title+body) in the new `stores/composer.ts`, consumed once by
  `Composer` on mount.
- Pattern: existing `workspace:create` stream + `NewWorkspaceDialog`.
- Gotcha: fetching a PR head from a fork — use the PR head ref via the API's head repo; document the
  same-repo-first assumption. Confine branch names.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/sidebar/NewWorkspaceDialog.test.tsx`

### Task 10 — Checks panel UI + settings + docs
- What: `src/renderer/features/checks/` — `ChecksPanel` (per-signal rows, red `BlockerList` with one-click
  action buttons, `PrCard`, CI list with `shell.openExternal` log links, resolvable review threads,
  deployments, todos), `MergeButton` (method selector, gated on green), `useChecks` (`checks:get` +
  `onEvent('checks:updated')` refetch with cleanup). Mount in `AppLayout.tsx` right pane. Add
  `agent.prPrompt` to settings. Write `src/main/integrations/CLAUDE.md` + `src/main/checks/CLAUDE.md`
  (token-at-rest, ETag caching, blocker→action mapping, push-auth, refs/checkpoints exclusion).
- Pattern: `useDiff`/`stores/diff.ts`; `AppLayout` right-pane placeholder.
- Gotcha: `onEvent('checks:updated')` must unsubscribe on unmount/workspace change (no listener leak).
  Merge button disabled state must reflect blockers; the action is server-gated too.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/checks/ChecksPanel.test.tsx`

---

## Execution Strategy
*How `/harness-implement` should build this. `/harness-implement` reads this verbatim.*
- **Task shape:** Cross-cutting, multi-module, **high-stakes** — five heightened-scrutiny paths (secrets/
  tokens, IPC/preload boundary, git push on user workspaces, DB migrations, network egress). High
  complexity, ~2 weeks.
- **Pattern:** prompt-chaining for the **foundation** (Tasks 1–3 — migrations + git commit/push + shared
  contract gate everything) → **parallelization (sectioning)** for independent modules (Task 4 auth/secrets,
  Task 5 GitHub client) → prompt-chaining for the dependents (6 checks, 7 PR — both need the client) →
  convergence (8 IPC+wiring → 9 create-from-source → 10 UI) → **evaluator-optimizer + mandatory verifier**
  on the secrets, git-push, PR-merge, and IPC paths.
- **Agents:** `coder` (foundation) → per-section `coder` (auth · client) each paired with `test-author` →
  `coder` (checks · PR) → `coder` (IPC + supervisor/focus wiring) → `frontend-designer`/`coder` (checks UI +
  dialog) → **`code-review` + `verifier` (mandatory)** on Tasks 2, 4, 5, 7, 8 (the heightened-scrutiny surface).
- **Orchestration:** prefer **team** if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled (each teammate owns
  a section via the shared task list, no file conflicts), else **parallel subagents** for the independent
  sections and **sequential** for the foundation + convergence.
- **Parallel decomposition + file-ownership:**
  - *Sequential foundation (disjoint files):* Task 1 owns `db/migrations/0006*`,`0007*`,`db/schema.ts`,
    `db/migrations/index.ts`,`db/repos/integrations.ts`. Task 2 owns `git/index.ts` (+ git tests). Task 3
    owns `shared/github.ts`,`shared/checks.ts`,`shared/ipc.ts`. Land first — everything imports them.
  - *Parallel sections (independent files):* **Auth** owns `integrations/secrets.ts`,`integrations/github/
    auth.ts`,`integrations/index.ts`; **Client** owns `integrations/github/client.ts`. Then **Checks** owns
    `checks/index.ts`; **PR** owns `integrations/github/pr.ts` (both after Client).
  - *Serialized convergence (shared files — one owner each, in order):* Task 8 owns `ipc/register.ts`; Task 9
    owns `workspace/index.ts` + `NewWorkspaceDialog.tsx` + `stores/composer.ts` + `Composer.tsx`; Task 10
    owns `renderer/features/checks/*` + `stores/checks.ts` + `AppLayout.tsx` + `settings/schema.ts`.
    `main/index.ts` is the convergence single-owner file — touched **last**, by one agent, to avoid conflicts.
- **Rationale:** the migrations + git primitives + shared contract are a hard dependency for every module, so
  sequential + first; auth and the GitHub client are genuinely independent (different files) and parallelize;
  the secrets/token, git-push, and PR-merge paths demand a mandatory independent verifier, so those get the
  evaluator-optimizer treatment rather than a single-pass coder.

---

## Validation Gate
Run after all tasks (from repo root):
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: tsc -b + eslint + vitest + electron-vite build)
```
Per-task Vitest commands are listed inline. Main-process tests use temp-dir real-git repos, temp-file SQLite
(`openDb(path)`), a temp `secrets/` dir (`setUserDataRoot`), and an injected fake Octokit `request.fetch`
(no live network, no `nock` dep); renderer tests use jsdom + a stubbed `window.api`.

## Acceptance Criteria
- [ ] Connect GitHub via device flow (and PAT); token encrypted via `safeStorage` on disk; DB stores only `token_ref`.
- [ ] Checks panel shows accurate git/PR/CI/deploy/review/todo signals for a workspace with a pushed branch.
- [ ] Red blockers gate the Merge button; each blocker's one-click action works (commit&push, create PR, fix checks, fix reviews).
- [ ] PR button commits+pushes+opens a PR with an agent-drafted title/body (draft toggle honored).
- [ ] "Fix review comments" and "Fix failing checks" feed real GitHub data into agent turns as attachments.
- [ ] Merge (squash/merge/rebase per settings) works ONLY when green (server-gated); post-merge archive prompt shows.
- [ ] Create workspace from a PR checks out the PR head; from an issue prefills the composer.
- [ ] ETag/conditional caching + focus refresh verified (304 path tested; no rate-limit thrash with several workspaces).
- [ ] Migrations `0006`/`0007` apply cleanly on a fresh DB and are no-ops on re-run; `src/shared/**` changes append-only.
- [ ] No plaintext token in SQLite, logs, error messages, or the renderer (asserted by a test).
- [ ] All Validation Gate blocking gates pass (run /verify); heightened-scrutiny paths (Tasks 2, 4, 5, 7, 8) got a named review + independent verifier.
```
