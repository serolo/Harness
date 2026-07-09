// ChecksService — merge-readiness aggregator (spec §5.5). Combines Git, PR, CI,
// deployment, review-thread, and todo signals per workspace into a single Checks
// result; blockers gate the Merge button and drive suggested next actions. Emits
// `checks:updated` on refresh. Implemented in Phase 5.
//
// Reads git via GitService and PR/CI/review/deployment state via IntegrationService
// (+ the per-repo GithubClient); todos + git-local signals need no network.
//
// The roll-up DTOs (`ChecksState` / `CheckSource` / `CheckSeverity` / `CheckItem` /
// `ChecksResult` + the `CheckDetails` discriminated union) are the CANONICAL shared
// contract in `@shared/checks`; this module re-exports them so existing importers of
// the `../checks` names keep resolving (mirrors how `src/main/diff` re-exports from
// `@shared/review`). The service returns the SHARED `ChecksResult` so `checks:get`
// hands the renderer the identical type.
//
// SECURITY: GitHub is a heightened-scrutiny path (network egress + tokens). Auth stays
// in IntegrationService (the decrypted token never reaches this module); a missing
// account / non-github origin / any client error DEGRADES gracefully — the git + todos
// items still return — rather than throwing out of `get`/`refresh`. No secrets are ever
// logged or placed in a check label/detail.

import { AppError } from '@shared/errors';
import type { CheckDetails, CheckItem, ChecksResult } from '@shared/checks';
import type { EventChannel, EventPayload } from '@shared/ipc';
import type { Project, Workspace } from '@shared/models';

import type { TodosRepo } from '../db/repos/todos';
import type { GitService, HeadInfo } from '../git';
import { GithubClient, parseOwnerName } from '../integrations/github/client';
import type { IntegrationService } from '../integrations';

// The roll-up DTOs live in the shared contract; re-export so callers (register.ts,
// tests, context.ts) keep importing them from `../checks` as they did off the stub.
export type {
  ChecksState,
  CheckSource,
  CheckSeverity,
  CheckDetails,
  CheckItem,
  ChecksResult,
} from '@shared/checks';

/**
 * Collaborators injected into {@link ChecksService} (constructed in `src/main/index.ts`).
 * Everything side-effecting or environment-specific is passed in so the service is
 * unit-testable without a live network or a booted DB:
 *   - `git`         — the shared stateless {@link GitService} (local, no network).
 *   - `getWorkspace`— resolves a workspace by id (null when unknown); carries
 *     `worktreePath`, `baseBranch`, `branch`, `prNumber`.
 *   - `getProject`  — resolves the owning project (its `originUrl` → owner/name).
 *   - `integrations`— resolves an authed Octokit for the active GitHub account.
 *   - `todos`       — the `todos` table repository (open-todo signal).
 *   - `emit`        — broadcasts a typed IPC event to open windows.
 *   - `setNeedsAttention` — optional hook to flip a workspace to `needs_attention`
 *     (wired in a later task); called on failing CI. Fire-and-forget.
 */
export interface ChecksServiceDeps {
  git: GitService;
  getWorkspace: (id: string) => Promise<Workspace | null>;
  getProject: (id: string) => Promise<Project | null>;
  integrations: IntegrationService;
  todos: TodosRepo;
  emit: <K extends EventChannel>(event: K, payload: EventPayload<K>) => void;
  setNeedsAttention?: (
    workspaceId: string,
    reason: string,
  ) => void | Promise<void>;
}

/** One cached checks computation, keyed on a `(headSha, prNumber, signal)` signature. */
interface ChecksCacheEntry {
  key: string;
  result: ChecksResult;
}

/**
 * Conclusions from a CI check-run that count as a hard failure (a blocker). A `null`
 * conclusion means the run is still in flight (queued/in-progress) — pending, not failing.
 */
const FAILING_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);

/** Combined-status states that count as a hard failure (a blocker). */
const FAILING_STATUS_STATES = new Set(['failure', 'error']);

/** Deployment status states that count as a failed environment (a warning, never a blocker). */
const FAILED_DEPLOY_STATES = new Set(['failure', 'error']);

/**
 * Aggregates merge-readiness signals per workspace. One instance is shared via
 * `AppContext`. Stateless apart from a single-slot per-workspace result cache that
 * {@link get} reads and {@link refresh} overwrites.
 */
export class ChecksService {
  /** Per-workspace single-slot result cache; overwritten on every {@link refresh}. */
  private readonly cache = new Map<string, ChecksCacheEntry>();

  constructor(private readonly deps: ChecksServiceDeps) {}

  /**
   * Return the last-computed checks for a workspace (cached), computing on first access
   * via {@link refresh} when nothing is cached yet.
   */
  async get(workspaceId: string): Promise<ChecksResult> {
    const cached = this.cache.get(workspaceId);
    if (cached !== undefined) return cached.result;
    return this.refresh(workspaceId);
  }

  /**
   * Recompute every signal for a workspace, cache + emit `checks:updated`, and return the
   * result. Called on window focus, after turns, and after git/PR actions (spec §5.5).
   *
   * Signals: git (always, local), then the GitHub-dependent pr/ci/deployment/review items
   * (skipped as a group when no account is connected / the origin is non-github / any
   * client call fails — the git + todos items still return), then todos (always, local).
   */
  async refresh(workspaceId: string): Promise<ChecksResult> {
    const workspace = await this.deps.getWorkspace(workspaceId);
    if (workspace === null) {
      throw new AppError('not_found', 'workspace not found', { workspaceId });
    }

    // Todos need neither the network nor a worktree — compute once, append last.
    const todosItem = await this.buildTodosItem(workspaceId);

    const wt = workspace.worktreePath;
    if (wt === null) {
      // Archived / no worktree: no git or GitHub signals are meaningful — return a
      // minimal result carrying only the (worktree-free) todos signal.
      return this.finalize(workspaceId, [todosItem], '', workspace.prNumber);
    }

    const items: CheckItem[] = [];

    // --- git (always, no network) -------------------------------------------------------
    const { item: gitItem, headSha } = await this.buildGitItem(
      wt,
      workspace.baseBranch,
    );
    items.push(gitItem);

    // --- GitHub-dependent signals (degrade as a GROUP on any failure) -------------------
    // The pr/ci/deployment/review rows are accumulated into a LOCAL array and only merged
    // into the result once the ENTIRE group has been computed successfully. This keeps the
    // degrade atomic: if an early call succeeds (e.g. PR lookup) but a LATER one throws
    // (e.g. check-runs 500s), we discard the partial group rather than surfacing a `pr` row
    // with the ci/deployment/review rows silently missing — an all-or-nothing contract the
    // panel relies on.
    let prNumber = workspace.prNumber;
    try {
      const project = await this.deps.getProject(workspace.projectId);
      if (project !== null && project.originUrl !== '') {
        const octokit = await this.deps.integrations.github();
        const client = new GithubClient(
          octokit,
          parseOwnerName(project.originUrl),
        );

        const githubItems: CheckItem[] = [];

        // pr: prefer the workspace's recorded PR number, else look it up by branch.
        const pr =
          workspace.prNumber !== null
            ? await client.getPrByNumber(workspace.prNumber)
            : await client.getPr(workspace.branch);
        githubItems.push(buildPrItem(pr));

        // ci: check-runs + combined statuses on the pushed head sha.
        githubItems.push(await this.buildCiItem(client, headSha));

        // deployment: environments for the head sha (ok/warning only).
        githubItems.push(await this.buildDeploymentItem(client, headSha));

        // review: unresolved review threads (only meaningful when a PR exists).
        if (pr !== null) {
          githubItems.push(await this.buildReviewItem(client, pr.number));
        }

        // Whole group succeeded — commit it (and the resolved PR number) as a unit.
        items.push(...githubItems);
        if (pr !== null) prNumber = pr.number;
      }
    } catch {
      // No account connected / non-github origin / any GitHub client error → skip the
      // pr/ci/deployment/review items ENTIRELY. The git + todos items still surface. The
      // caught error is intentionally swallowed (it may reference the origin, never a token).
    }

    items.push(todosItem);
    return this.finalize(workspaceId, items, headSha, prNumber);
  }

  // -------------------------------------------------------------------------
  // Signal builders
  // -------------------------------------------------------------------------

  /**
   * The `git` signal: ahead/behind the base branch, uncommitted change count, and whether
   * the branch was ever pushed (no upstream ⇒ unpushed). Every sub-query degrades to a
   * neutral default on failure (unborn branch, missing `origin/<base>`, …) so the git row
   * always returns. Returns the item plus the resolved HEAD sha (the CI head, `''` when
   * unresolved — e.g. an unborn branch).
   */
  private async buildGitItem(
    wt: string,
    baseBranch: string,
  ): Promise<{ item: CheckItem; headSha: string }> {
    let ahead = 0;
    let behind = 0;
    let headSha = '';
    try {
      // Prefer the remote base (`origin/<base>`); fall back to the local base branch
      // when there is no `origin` remote (mirrors DiffService.mergeBaseWithFallback).
      let head: HeadInfo;
      try {
        head = await this.deps.git.headInfo(wt, `origin/${baseBranch}`);
      } catch {
        head = await this.deps.git.headInfo(wt, baseBranch);
      }
      ahead = head.ahead;
      behind = head.behind;
      headSha = head.sha;
    } catch {
      // No base ref resolvable — still try for a bare HEAD sha (CI needs it).
      try {
        headSha = (await this.deps.git.headInfo(wt)).sha;
      } catch {
        headSha = '';
      }
    }

    let uncommitted = 0;
    try {
      uncommitted = (await this.deps.git.status(wt)).files.length;
    } catch {
      uncommitted = 0;
    }

    // "unpushed" = the branch has no upstream tracking ref yet (never pushed). A missing
    // upstream is a normal condition GitService.hasUpstream reports as `false`.
    let unpushed = false;
    try {
      unpushed = !(await this.deps.git.hasUpstream(wt));
    } catch {
      unpushed = false;
    }

    const details: CheckDetails = {
      source: 'git',
      ahead,
      behind,
      uncommitted,
      unpushed,
    };

    // A pending git row when there is local work to publish; otherwise ok.
    const needsPublish = uncommitted > 0 || unpushed;
    let label: string;
    if (uncommitted > 0) {
      label = `${uncommitted} uncommitted change${uncommitted === 1 ? '' : 's'}`;
    } else if (unpushed) {
      label = 'Unpushed commits';
    } else if (behind > 0) {
      label = `${behind} commit${behind === 1 ? '' : 's'} behind base`;
    } else {
      label = 'Up to date with base';
    }

    return {
      item: {
        source: 'git',
        label,
        severity: needsPublish ? 'pending' : 'ok',
        suggestedAction: needsPublish ? 'Commit & push' : undefined,
        details,
      },
      headSha,
    };
  }

  /**
   * The `ci` signal: fold check-runs + combined statuses on the pushed head sha into a
   * (total, failing, pending) roll-up. Any failing conclusion/state is a blocker.
   */
  private async buildCiItem(
    client: GithubClient,
    headSha: string,
  ): Promise<CheckItem> {
    // No pushed head → no CI to report (avoid a wasted API call on an empty ref).
    if (headSha === '') {
      return {
        source: 'ci',
        label: 'No CI',
        severity: 'ok',
        details: { source: 'ci', total: 0, failing: 0, pending: 0, runs: [] },
      };
    }

    const [checkRuns, statuses] = await Promise.all([
      client.listCheckRuns(headSha),
      client.listStatuses(headSha),
    ]);

    const runs: {
      name: string;
      conclusion: string | null;
      detailsUrl: string | null;
    }[] = [];
    let failing = 0;
    let pending = 0;

    for (const run of checkRuns) {
      runs.push({
        name: run.name,
        conclusion: run.conclusion,
        detailsUrl: run.detailsUrl,
      });
      if (run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion)) {
        failing += 1;
      } else if (run.status !== 'completed') {
        pending += 1;
      }
    }

    for (const status of statuses) {
      runs.push({
        name: status.context,
        conclusion: status.state,
        detailsUrl: status.targetUrl,
      });
      if (FAILING_STATUS_STATES.has(status.state)) {
        failing += 1;
      } else if (status.state === 'pending') {
        pending += 1;
      }
    }

    const total = runs.length;
    const details: CheckDetails = {
      source: 'ci',
      total,
      failing,
      pending,
      runs,
    };

    if (failing > 0) {
      return {
        source: 'ci',
        label: `CI: ${failing} failing`,
        severity: 'blocker',
        suggestedAction: 'Fix failing checks',
        details,
      };
    }
    if (pending > 0) {
      return {
        source: 'ci',
        label: `CI: ${pending} pending`,
        severity: 'pending',
        details,
      };
    }
    return {
      source: 'ci',
      label: total === 0 ? 'No CI' : 'CI passing',
      severity: 'ok',
      details,
    };
  }

  /**
   * The `deployment` signal: the latest status per deployment of the head sha. A failed
   * environment is a warning (deployments never block a merge).
   */
  private async buildDeploymentItem(
    client: GithubClient,
    headSha: string,
  ): Promise<CheckItem> {
    const deployments =
      headSha === '' ? [] : await client.listDeployments(headSha);

    const environments = await Promise.all(
      deployments.map(async (deployment) => {
        // The statuses endpoint returns newest-first; the head is the current state.
        const statuses = await client.listDeploymentStatuses(deployment.id);
        const latest = statuses[0];
        return {
          name: deployment.environment,
          state: latest?.state ?? 'pending',
          url: latest?.environmentUrl ?? undefined,
        };
      }),
    );

    const anyFailed = environments.some((env) =>
      FAILED_DEPLOY_STATES.has(env.state),
    );
    const details: CheckDetails = { source: 'deployment', environments };

    return {
      source: 'deployment',
      label:
        environments.length === 0
          ? 'No deployments'
          : `${environments.length} environment${environments.length === 1 ? '' : 's'}`,
      severity: anyFailed ? 'warning' : 'ok',
      details,
    };
  }

  /**
   * The `review` signal: unresolved review threads on the PR. Unresolved comments block a
   * merge (they are a `blocker`).
   */
  private async buildReviewItem(
    client: GithubClient,
    prNumber: number,
  ): Promise<CheckItem> {
    const threads = await client.reviewThreads(prNumber);
    const unresolved = threads.filter((thread) => !thread.resolved).length;
    const details: CheckDetails = {
      source: 'review',
      unresolved,
      threads,
    };

    if (unresolved > 0) {
      return {
        source: 'review',
        label: `${unresolved} unresolved review comment${unresolved === 1 ? '' : 's'}`,
        severity: 'blocker',
        suggestedAction: 'Fix review comments',
        details,
      };
    }
    return {
      source: 'review',
      label: 'Reviews resolved',
      severity: 'ok',
      details,
    };
  }

  /**
   * The `todos` signal: open todos for the workspace (user + agent). Any open todo makes
   * the row `pending` with a suggested action listing them.
   */
  private async buildTodosItem(workspaceId: string): Promise<CheckItem> {
    let all: { body: string; done: boolean }[] = [];
    try {
      all = (await this.deps.todos.list(workspaceId)).map((todo) => ({
        body: todo.body,
        done: todo.done,
      }));
    } catch {
      all = [];
    }

    const open = all.filter((todo) => !todo.done);
    const details: CheckDetails = {
      source: 'todos',
      open: open.length,
      items: all,
    };

    if (open.length > 0) {
      return {
        source: 'todos',
        label: `${open.length} open todo${open.length === 1 ? '' : 's'}`,
        severity: 'pending',
        suggestedAction: `Complete: ${open.map((todo) => todo.body).join('; ')}`,
        details,
      };
    }
    return {
      source: 'todos',
      label: 'No open todos',
      severity: 'ok',
      details,
    };
  }

  // -------------------------------------------------------------------------
  // Roll-up + cache + emit
  // -------------------------------------------------------------------------

  /**
   * Roll the items into a {@link ChecksResult}, cache it under a `(headSha, prNumber,
   * signal)` signature, emit `checks:updated`, fire the failing-CI attention hook, and
   * return the result. `state` is `blocked` when any item is a `blocker`, else `pending`
   * when any is `pending`, else `green` (warnings do not change the roll-up state).
   */
  private finalize(
    workspaceId: string,
    items: CheckItem[],
    headSha: string,
    prNumber: number | null,
  ): ChecksResult {
    const hasBlocker = items.some((item) => item.severity === 'blocker');
    const hasPending = items.some((item) => item.severity === 'pending');
    const state = hasBlocker ? 'blocked' : hasPending ? 'pending' : 'green';

    const result: ChecksResult = {
      workspaceId,
      state,
      items,
      updatedAt: Date.now(),
    };

    // Signature the cache entry is computed against: the head, the PR, and each item's
    // (source, severity). Stored so a later staleness check can compare cheaply.
    const signal = items
      .map((item) => `${item.source}=${item.severity}`)
      .join(',');
    const key = `${headSha}:${prNumber ?? ''}:${signal}`;
    this.cache.set(workspaceId, { key, result });

    this.deps.emit('checks:updated', { workspaceId, checks: result });

    // Failing CI is a blocker worth surfacing as needs-attention (best-effort hook).
    const ciFailing = items.some(
      (item) => item.source === 'ci' && item.severity === 'blocker',
    );
    if (ciFailing) {
      void Promise.resolve(
        this.deps.setNeedsAttention?.(workspaceId, 'CI failing'),
      ).catch(() => {
        /* attention hook is best-effort — never let it wedge a refresh. */
      });
    }

    return result;
  }
}

/**
 * The `pr` signal: a PR summary when one exists, else a pending "Create PR" row. Pure
 * (no I/O) — the PR was already fetched by the caller.
 */
function buildPrItem(
  pr: {
    number: number;
    url: string;
    title: string;
    draft: boolean;
    mergeableState: string;
  } | null,
): CheckItem {
  if (pr === null) {
    return {
      source: 'pr',
      label: 'No PR',
      severity: 'pending',
      suggestedAction: 'Create PR',
      details: { source: 'pr' },
    };
  }

  const details: CheckDetails = {
    source: 'pr',
    number: pr.number,
    url: pr.url,
    title: pr.title,
    draft: pr.draft,
    mergeableState: pr.mergeableState,
  };
  return {
    source: 'pr',
    label: pr.draft ? `PR #${pr.number} (draft)` : `PR #${pr.number}`,
    severity: 'ok',
    details,
  };
}
