# Phase 5 — GitHub Integration, Checks Panel & PR Workflow (Electron)

> **Read [`README.md`](./README.md) first.**

**Spec refs:** §3 (integrations table), §5.1 (create from PR/issue), §5.5 (checks), §5.6 (PR workflow), §6 (integrations), §7 (tokens), §8 (M5), §9 (rate limits).
**Estimated size:** ~2 weeks. **Depends on:** Phase 0, Phase 1, Phase 4 (diff/todos). **Parallelizable with:** Phase 6.

---

## 1. Goal

Close the loop to merge: connect GitHub (OAuth device flow, `safeStorage`-encrypted token), aggregate
merge-readiness **Checks** per workspace (git/PR/CI/deploy/review/todos), and run the PR workflow
(commit+push+open PR with agent-drafted title/body, ingest review threads, fix-review / fix-checks
agent actions, merge). Also **complete Phase 1's deferred** create-from-PR / create-from-GitHub-issue
prefill.

---

## 2. Scope

**In scope**
- `IntegrationService` + GitHub client (**Octokit**): OAuth **device flow** (PAT fallback), token
  encrypted with **`safeStorage`** (ciphertext under `userData/secrets/`), REST (PRs, check-runs,
  statuses, deployments), GraphQL (review threads + resolution), **ETag/conditional caching**,
  focus-based + interval polling, per-project batching.
- `ChecksService`: aggregate the six signal sources (spec §5.5) into a `Checks` model with blockers;
  emit `checks:updated`.
- Checks panel UI: signals, red blockers gating Merge, one-click "next action" suggestions.
- PR workflow: commit-if-needed → push → open PR (agent-drafted title/description from template, draft
  toggle); "Fix review comments" and "Fix failing checks" as agent turns; merge (merge/squash/rebase
  per settings) gated on green; post-merge archive prompt.
- Create workspace **from PR** (checkout PR head) and **from GitHub issue** (prefill composer with
  title+body) — completes Phase 1 §3.3.

**Out of scope**
- Linear (Phase 7). Webhooks (out of scope per spec — polling only).

---

## 3. Task breakdown

### 3.1 Auth & IntegrationService (`src/main/integrations/`, `.../github/`)
- OAuth **device flow**: request device code → show user code + `shell.openExternal(verificationUri)`
  → poll for token → **encrypt with `safeStorage.encryptString`** → write ciphertext to
  `userData/secrets/<id>` → persist an `integrations` row with `token_ref` (the file id) +
  `account_label` (spec §3, §7). **Never** store the plaintext token in SQLite. PAT fallback path.
  Decrypt on demand with `safeStorage.decryptString`.
- `IntegrationService.github()` returns an authenticated Octokit; multi-account allowed (N rows) — UI
  defaults to one active account for v1 (schema supports more; resolve the multi-account open question
  minimally here).

### 3.2 GitHub client (`src/main/integrations/github/client.ts`)
- Octokit REST: `getPr`, `createPr`, `mergePr(method)`, `listCheckRuns(sha)`, `listStatuses(sha)`,
  `listDeployments`, `listDeploymentStatuses`. Octokit GraphQL: `reviewThreads(pr)`,
  `resolveThread(id)`.
- **Conditional requests / ETags** per endpoint (Octokit supports `If-None-Match`; cache last ETag +
  body, treat 304 as cache hit). **Refresh on window focus** (`browserWindow.on('focus')`) + a slow
  interval timer; per-project batching via GraphQL to respect rate limits (spec §9). Handle
  `x-ratelimit-remaining` with backoff.
- Map the repo's `origin_url` → `owner/name`. Push via the user's git credential helper (GitService);
  prefer existing git auth over injecting the OAuth token into remotes.

### 3.3 ChecksService (`src/main/checks/`)
```ts
interface Checks {
  git: { uncommitted: boolean; unpushed: number; behindBase: number };
  pr?: { number: number; state: string; draft: boolean; mergeableState: string };
  ci: { runs: CheckRun[]; rollup: 'pass'|'fail'|'pending' };
  deployments: DeploymentStatus[];
  review: { unresolvedThreads: number };
  todos: { open: number };
  blockers: Blocker[];   // red items gating merge, each with a suggested next action
}
class ChecksService { compute(workspaceId: string): Promise<Checks>; }
```
- Git signals from GitService (`headInfo` ahead/behind, `git status`). PR/CI/deploy/review from the
  GitHub client (keyed on the branch's pushed head sha). Todos from Phase 4.
- **Blockers → next action** (spec §5.5/§5.6): uncommitted→"Commit & push"; no PR→"Create PR"; failing
  check→"Fix failing check" (agent prompt); unresolved threads→"Fix review comments"; open todos→list.
  Each action is a one-click git action or agent turn.
- Recompute on: focus, interval, `diff:changed`, `turn_end`, push/PR/merge actions. Emit
  `checks:updated`. Failing checks may raise `needs_attention` (spec §5.8).

### 3.4 PR workflow (`src/main/integrations/github/pr.ts`)
- `pr:open(workspaceId, { draft })`: commit if needed (message from settings/agent) → push branch →
  generate title/description (agent turn using a template from settings, spec §5.6) → `createPr` →
  persist PR number on the workspace. Exclude `refs/checkpoints/*`.
- `pr:fixReviews(workspaceId)`: fetch unresolved review threads → serialize as attachments (reuse the
  Phase 2/4 attachment shape) → agent turn. On resolution, `resolveThread`.
- `pr:fixChecks(workspaceId)`: fetch failing check-run **logs (truncated)** → agent turn.
- `pr:merge(workspaceId, method)`: enabled only when `blockers` empty → merge/squash/rebase per repo
  settings → post-merge prompt to archive the workspace (Phase 1 archive).

### 3.5 Create-from-source (completes Phase 1)
- Extend the New Workspace dialog: **From PR** (list open PRs → checkout PR head branch instead of
  creating a new branch, spec §5.1) and **From GitHub issue** (list issues → prefill composer with
  title+body as first prompt). Store `sourceKind`/`sourceRef`; hand the prefill prompt to chat via the
  Phase 1 `pendingPrompt` seam.

### 3.6 Checks panel UI (`src/renderer/features/checks/`)
- Per-workspace panel: each signal pass/fail/pending; **red blockers** listed with one-click action
  buttons; a prominent **Merge** button gated on green with method selector. PR card (state/draft/
  mergeable), CI list (link to logs via `shell.openExternal`), review threads (resolvable in-app),
  deployments, todos. Live-updates on `checks:updated`. ⌘⇧P triggers `pr:open` (shortcut in Phase 6).

---

## 4. Data model owned by this phase
- Migration `0006_integrations`: `integrations` (spec §3). Add `pr_number INTEGER` to `workspaces`
  (migration `0007_workspace_pr`) if not reusing `source_ref`. Checks are computed (not persisted);
  optionally cache last-computed JSON per workspace for instant paint.

## 5. IPC surface added
- Commands: `github:connect()` (device flow, streamed status), `github:accounts()`,
  `checks:get(workspaceId)`, `pr:open(workspaceId, opts)`, `pr:merge(workspaceId, method)`,
  `pr:fixReviews(workspaceId)`, `pr:fixChecks(workspaceId)`, `github:listPrs(projectId)`,
  `github:listIssues(projectId)`, `review:resolveThread(id)`.
- Events: `checks:updated`, `notify:needsAttention` (failing checks).

## 6. Definition of Done
- [ ] Connect GitHub via device flow; token encrypted via `safeStorage` on disk; DB stores only `token_ref`.
- [ ] Checks panel shows accurate git/PR/CI/deploy/review/todo signals for a workspace with a pushed branch.
- [ ] Red blockers gate the Merge button; each blocker's one-click action works (commit&push, create PR,
      fix checks, fix reviews).
- [ ] ⌘⇧P/PR button commits+pushes+opens a PR with an agent-drafted title/body (draft toggle honored).
- [ ] "Fix review comments" and "Fix failing checks" feed real GitHub data into agent turns.
- [ ] Merge (squash/merge/rebase per settings) works only when green; post-merge archive prompt shows.
- [ ] Create workspace from a PR checks out the PR head; from an issue prefills the composer.
- [ ] ETag/conditional caching + focus refresh verified (no rate-limit thrash with several workspaces).
- [ ] `npm run check` green.

## 7. Tests
- GitHub client against mocked HTTP (nock / Octokit fetch interceptor) with recorded fixtures: PR CRUD,
  check-runs, statuses, deployments, review threads, 304/ETag path, rate-limit backoff.
- ChecksService: blocker computation for each state combination; next-action mapping.
- Auth: device-flow state machine (mocked token endpoint); `safeStorage` round-trip (encrypt→store→
  decrypt); token not in DB.
- Renderer: checks panel renders each signal; merge gating; create-from-PR/issue dialog.

## 8. Risks / notes
- **Rate limits** with many workspaces — ETag/conditional + focus refresh + GraphQL batching + backoff
  (spec §9).
- **Push auth** — reuse the user's git credentials rather than injecting the OAuth token into remotes
  where possible; document the fallback.
- **`safeStorage` availability** — on macOS it uses Keychain; guard `isEncryptionAvailable()` and fail
  with a clear error. (keytar is the literal-Keychain fallback if required — README §11.)
- **`refs/checkpoints/*` must be excluded** from push/PR (coordinate with Phase 4).
- **mergeable_state** is eventually-consistent on GitHub — poll/retry before enabling Merge.
