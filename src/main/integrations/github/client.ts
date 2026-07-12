// GithubClient — the thin, injectable wrapper around an authed Octokit that the
// GitHub integration (spec §5.5–5.6 / §6) uses for PRs, check-runs, statuses,
// deployments, and review threads. REST goes through `octokit.request(...)`;
// review threads + their resolution go through `octokit.graphql(...)`.
//
// Design constraints (see root CLAUDE.md + .claude/rules/{security,architecture}.md):
//   - Heightened-scrutiny path (network egress). We NEVER log tokens or auth headers;
//     error messages carry only the HTTP status + Octokit's own message, never headers
//     or request bodies (which could contain credentials).
//   - Fully injectable: the authed Octokit is a constructor argument (produced by
//     `IntegrationService.github()` — Task 4), so tests fake `octokit.request` /
//     `octokit.graphql` directly — no live network, no `nock`. `sleep`/`now` are also
//     injectable so rate-limit/backoff paths are deterministic under test.
//   - Conditional caching: cacheable GETs send `if-none-match` with the stored ETag and
//     treat Octokit's 304 (surfaced as an error with `status === 304`) as a cache HIT.
//   - Rate limits: `x-ratelimit-remaining`/`-reset` drive a bounded wait; secondary
//     (abuse) 403/429 responses trigger a bounded exponential backoff + retry.

import { type Octokit } from '@octokit/rest';
import { AppError } from '../../error';
import type {
  IssueListItem,
  MergeMethod,
  PrListItem,
  PrSummary,
  ReviewThread,
} from '@shared/github';

/** Upper bound on any single rate-limit / backoff sleep, so we never hang for long. */
const MAX_BACKOFF_MS = 60_000;
/** Base unit for the secondary-rate exponential backoff. */
const BASE_BACKOFF_MS = 1_000;
/** How many times to retry a secondary (abuse) rate-limit response before giving up. */
const SECONDARY_RATE_MAX_RETRIES = 3;

/**
 * Minimal structural view of an Octokit REST response. We deliberately do NOT couple to
 * Octokit's generated response types here: the client maps a small, explicit set of
 * fields, and a decoupled shape keeps the test fake trivial (it returns plain objects).
 */
interface OctokitResponseLike<T> {
  data: T;
  status: number;
  headers: Record<string, string | undefined>;
}

/** Injectable clock/timer hooks + logger, so rate-limit paths are testable/deterministic. */
export interface GithubClientOptions {
  /** Sleep for `ms` milliseconds. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Current epoch time in ms. Defaults to `Date.now`. */
  now?: () => number;
}

// --- Local REST payload shapes (only the fields we map) ---------------------------------

interface RestPull {
  number: number;
  html_url: string;
  title: string;
  draft?: boolean;
  state?: string;
  mergeable_state?: string;
  user?: { login?: string } | null;
  updated_at?: string;
}

interface RestCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
}

interface RestCheckRunsResponse {
  check_runs: RestCheckRun[];
}

interface RestCombinedStatus {
  statuses: Array<{
    context: string;
    state: string;
    target_url: string | null;
  }>;
}

interface RestDeployment {
  id: number;
  environment: string;
  sha: string;
}

interface RestDeploymentStatus {
  state: string;
  environment_url: string | null;
}

interface RestIssue {
  number: number;
  title: string;
  html_url: string;
  state?: string;
  updated_at?: string;
  /** Present iff the "issue" is actually a PR — used to exclude PRs from the issue list. */
  pull_request?: unknown;
}

// --- Local GraphQL payload shapes -------------------------------------------------------

interface ReviewThreadsGraphQL {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string | null;
          line: number | null;
          comments: {
            nodes: Array<{ author: { login: string } | null; body: string }>;
          };
        }>;
      } | null;
    } | null;
  } | null;
}

const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            path
            line
            comments(first: 100) {
              nodes {
                author { login }
                body
              }
            }
          }
        }
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation ($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id }
    }
  }
`;

/**
 * Parse a git origin URL into `{ owner, name }`. Handles HTTPS
 * (`https://github.com/OWNER/REPO(.git)`) plus SSH forms
 * (`git@github.com:OWNER/REPO(.git)` and ssh-config host aliases such as
 * `git@github-work:OWNER/REPO(.git)`), stripping a trailing `.git` and tolerating
 * a trailing slash.
 *
 * @throws {AppError} code `integration` on an unparseable / non-github.com URL.
 */
export function parseOwnerName(originUrl: string): {
  owner: string;
  name: string;
} {
  // Trim surrounding whitespace and any trailing slashes before matching.
  const trimmed = originUrl.trim().replace(/\/+$/, '');
  // Non-greedy repo capture + optional `.git` suffix, anchored so the whole string is
  // consumed.
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(
    trimmed,
  );
  const ssh = /^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  const match = https ?? ssh;
  if (!match || !match[1] || !match[2]) {
    throw new AppError(
      'integration',
      `Unrecognized GitHub origin URL: ${originUrl}`,
    );
  }
  return { owner: match[1], name: match[2] };
}

/**
 * A per-repo GitHub API façade. Construct with an already-authed Octokit (kept as a
 * constructor arg so auth stays in `IntegrationService`) and the target repo. All read
 * paths are ETag-cached; all paths respect the primary + secondary rate limits.
 */
export class GithubClient {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  /** Per-endpoint conditional-request cache: key → `{ etag, body }`. */
  private readonly etagCache = new Map<
    string,
    { etag: string; body: unknown }
  >();

  /** Last-seen primary rate-limit budget (from `x-ratelimit-remaining`). */
  private rateRemaining: number | null = null;
  /** Epoch-seconds the primary budget resets (from `x-ratelimit-reset`). */
  private rateReset: number | null = null;

  constructor(
    octokit: Octokit,
    repo: { owner: string; name: string },
    options: GithubClientOptions = {},
  ) {
    this.octokit = octokit;
    this.owner = repo.owner;
    this.repo = repo.name;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  // --- Pull requests --------------------------------------------------------------------

  /**
   * The PR whose head is `owner:branch`, mapped to a {@link PrSummary}, or `null` when
   * the branch has no open/closed PR. ETag-cached per branch.
   */
  async getPr(branch: string): Promise<PrSummary | null> {
    const data = await this.cachedGet<RestPull[]>(
      `getPr:${branch}`,
      'GET /repos/{owner}/{repo}/pulls',
      { head: `${this.owner}:${branch}`, state: 'open', per_page: 1 },
    );
    const first = data[0];
    return first ? this.toPrSummary(first) : null;
  }

  /** Fetch a PR by its number (full detail, so `mergeableState` is authoritative). */
  async getPrByNumber(number: number): Promise<PrSummary> {
    const pr = await this.plainRequest<RestPull>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { pull_number: number },
    );
    return this.toPrSummary(pr);
  }

  /** Open a new pull request and return its summary. */
  async createPr(opts: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<PrSummary> {
    const pr = await this.plainRequest<RestPull>(
      'POST /repos/{owner}/{repo}/pulls',
      {
        head: opts.head,
        base: opts.base,
        title: opts.title,
        body: opts.body,
        draft: opts.draft ?? false,
      },
    );
    return this.toPrSummary(pr);
  }

  /** Merge a PR with the given strategy (`merge` | `squash` | `rebase`). */
  async mergePr(number: number, method: MergeMethod): Promise<void> {
    await this.plainRequest<unknown>(
      'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge',
      { pull_number: number, merge_method: method },
    );
  }

  /** Open PRs for the repo, as list rows. ETag-cached. */
  async listPrs(): Promise<PrListItem[]> {
    const data = await this.cachedGet<RestPull[]>(
      'listPrs',
      'GET /repos/{owner}/{repo}/pulls',
      { state: 'open', per_page: 100 },
    );
    return data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user?.login ?? undefined,
      updatedAt: pr.updated_at,
    }));
  }

  /** Open issues for the repo, excluding PRs (GitHub returns PRs from `/issues`). Cached. */
  async listIssues(): Promise<IssueListItem[]> {
    const data = await this.cachedGet<RestIssue[]>(
      'listIssues',
      'GET /repos/{owner}/{repo}/issues',
      { state: 'open', per_page: 100 },
    );
    return data
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        updatedAt: issue.updated_at,
      }));
  }

  // --- Checks / statuses / deployments --------------------------------------------------

  /** CI check-runs for a commit SHA. ETag-cached per SHA. */
  async listCheckRuns(sha: string): Promise<
    {
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
    }[]
  > {
    const data = await this.cachedGet<RestCheckRunsResponse>(
      `check-runs:${sha}`,
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      { ref: sha, per_page: 100 },
    );
    return (data.check_runs ?? []).map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      detailsUrl: run.details_url ?? null,
    }));
  }

  /** Combined commit statuses for a SHA. ETag-cached per SHA. */
  async listStatuses(
    sha: string,
  ): Promise<{ context: string; state: string; targetUrl: string | null }[]> {
    const data = await this.cachedGet<RestCombinedStatus>(
      `statuses:${sha}`,
      'GET /repos/{owner}/{repo}/commits/{ref}/status',
      { ref: sha, per_page: 100 },
    );
    return (data.statuses ?? []).map((status) => ({
      context: status.context,
      state: status.state,
      targetUrl: status.target_url ?? null,
    }));
  }

  /** Deployments for the repo, optionally filtered to a SHA. ETag-cached. */
  async listDeployments(
    sha?: string,
  ): Promise<{ id: number; environment: string; sha: string }[]> {
    const params: Record<string, unknown> = { per_page: 100 };
    if (sha) params.sha = sha;
    const data = await this.cachedGet<RestDeployment[]>(
      `deployments:${sha ?? ''}`,
      'GET /repos/{owner}/{repo}/deployments',
      params,
    );
    return data.map((deployment) => ({
      id: deployment.id,
      environment: deployment.environment,
      sha: deployment.sha,
    }));
  }

  /** Statuses for one deployment. ETag-cached per deployment id. */
  async listDeploymentStatuses(
    deploymentId: number,
  ): Promise<{ state: string; environmentUrl: string | null }[]> {
    const data = await this.cachedGet<RestDeploymentStatus[]>(
      `deployment-statuses:${deploymentId}`,
      'GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses',
      { deployment_id: deploymentId, per_page: 100 },
    );
    return data.map((status) => ({
      state: status.state,
      environmentUrl: status.environment_url ?? null,
    }));
  }

  // --- Review threads (GraphQL) ---------------------------------------------------------

  /** All review threads for a PR (id, resolved, anchor, comments) in ONE GraphQL call. */
  async reviewThreads(prNumber: number): Promise<ReviewThread[]> {
    const result = await this.runGraphql<ReviewThreadsGraphQL>(
      REVIEW_THREADS_QUERY,
      { owner: this.owner, name: this.repo, number: prNumber },
    );
    const nodes = result.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.map((node) => ({
      id: node.id,
      path: node.path ?? undefined,
      line: node.line ?? undefined,
      resolved: node.isResolved,
      comments: (node.comments?.nodes ?? []).map((comment) => ({
        author: comment.author?.login ?? '',
        body: comment.body,
      })),
    }));
  }

  /** Mark a review thread resolved. */
  async resolveThread(threadId: string): Promise<void> {
    await this.runGraphql<unknown>(RESOLVE_THREAD_MUTATION, { threadId });
  }

  // --- Internals ------------------------------------------------------------------------

  /** Map a REST pull object to the cross-boundary {@link PrSummary} DTO. */
  private toPrSummary(pr: RestPull): PrSummary {
    return {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      draft: pr.draft ?? false,
      mergeableState: pr.mergeable_state ?? 'unknown',
      state: pr.state,
    };
  }

  /**
   * Cacheable GET with conditional (ETag) support. Sends `if-none-match` when a prior
   * ETag is known; on a 304 (surfaced by Octokit as an error with `status === 304`)
   * returns the cached body; on a 200 refreshes the stored `{ etag, body }`.
   */
  private async cachedGet<T>(
    cacheKey: string,
    route: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const cached = this.etagCache.get(cacheKey);
    const headers: Record<string, string> = {};
    if (cached) headers['if-none-match'] = cached.etag;
    try {
      const res = await this.send<T>(route, { ...params, headers });
      const etag = res.headers.etag;
      if (typeof etag === 'string' && etag.length > 0) {
        this.etagCache.set(cacheKey, { etag, body: res.data });
      }
      return res.data;
    } catch (err) {
      // 304 Not Modified with a matching ETag → serve the cached body as a HIT.
      if (this.statusOf(err) === 304 && cached) {
        this.updateRateFromError(err);
        return cached.body as T;
      }
      throw this.wrap(err);
    }
  }

  /** Non-cached REST call that returns `data` and normalizes errors to {@link AppError}. */
  private async plainRequest<T>(
    route: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    try {
      const res = await this.send<T>(route, params);
      return res.data;
    } catch (err) {
      throw this.wrap(err);
    }
  }

  /**
   * Low-level REST send: waits for the primary rate-limit budget, issues the request,
   * updates the budget from response/error headers, and retries a secondary (abuse)
   * rate-limit 403/429 with bounded exponential backoff. Errors are rethrown RAW so
   * callers can special-case a 304 before wrapping.
   */
  private async send<T>(
    route: string,
    params: Record<string, unknown>,
  ): Promise<OctokitResponseLike<T>> {
    let attempt = 0;
    for (;;) {
      await this.awaitPrimaryRateBudget();
      try {
        // Octokit types `request` loosely for a dynamic route string; we intentionally
        // map a small explicit field set, so narrow to our structural response view.
        const res = (await this.octokit.request(
          route,
          params,
        )) as unknown as OctokitResponseLike<T>;
        this.updateRateFromHeaders(res.headers);
        return res;
      } catch (err) {
        this.updateRateFromError(err);
        const status = this.statusOf(err);
        const isSecondary = status === 403 || status === 429;
        if (
          isSecondary &&
          this.hasRetrySignal(err) &&
          attempt < SECONDARY_RATE_MAX_RETRIES
        ) {
          await this.sleep(this.secondaryBackoffMs(err, attempt));
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
  }

  /** GraphQL call with normalized error handling. */
  private async runGraphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.octokit.graphql<T>(query, variables);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  /**
   * If the primary budget is exhausted, wait until it resets (bounded by
   * {@link MAX_BACKOFF_MS}) so we don't spend the wait exceeding rate limits.
   */
  private async awaitPrimaryRateBudget(): Promise<void> {
    if (
      this.rateRemaining !== null &&
      this.rateRemaining <= 0 &&
      this.rateReset !== null
    ) {
      const waitMs = this.rateReset * 1_000 - this.now();
      const bounded = Math.min(Math.max(waitMs, 0), MAX_BACKOFF_MS);
      if (bounded > 0) await this.sleep(bounded);
      // Assume the window has rolled over; a stale value would just trigger a 403 the
      // retry path handles, rather than an unbounded wait.
      this.rateRemaining = null;
    }
  }

  /** Record `x-ratelimit-remaining` / `-reset` from a successful response. */
  private updateRateFromHeaders(
    headers: Record<string, string | undefined>,
  ): void {
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];
    if (remaining !== undefined) {
      const parsed = Number.parseInt(remaining, 10);
      if (!Number.isNaN(parsed)) this.rateRemaining = parsed;
    }
    if (reset !== undefined) {
      const parsed = Number.parseInt(reset, 10);
      if (!Number.isNaN(parsed)) this.rateReset = parsed;
    }
  }

  /** Record rate-limit budget carried on an error response (403/429/304 all carry it). */
  private updateRateFromError(err: unknown): void {
    const headers = this.headersOf(err);
    if (headers) this.updateRateFromHeaders(headers);
  }

  /**
   * Milliseconds to back off before retrying a secondary-rate response: honor
   * `retry-after` (seconds) when present, else exponential from {@link BASE_BACKOFF_MS},
   * always bounded by {@link MAX_BACKOFF_MS}.
   */
  private secondaryBackoffMs(err: unknown, attempt: number): number {
    const headers = this.headersOf(err);
    const retryAfter = headers?.['retry-after'];
    if (retryAfter !== undefined) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(seconds)) {
        return Math.min(seconds * 1_000, MAX_BACKOFF_MS);
      }
    }
    return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  }

  /** Whether an error looks like a rate-limit signal worth retrying. */
  private hasRetrySignal(err: unknown): boolean {
    const headers = this.headersOf(err);
    if (!headers) return false;
    return (
      headers['retry-after'] !== undefined ||
      headers['x-ratelimit-remaining'] === '0'
    );
  }

  /** Extract an HTTP status from an Octokit error, or `null`. */
  private statusOf(err: unknown): number | null {
    const status = (err as { status?: unknown } | null)?.status;
    return typeof status === 'number' ? status : null;
  }

  /** Extract response headers from an Octokit error, or `null`. */
  private headersOf(err: unknown): Record<string, string | undefined> | null {
    const headers = (err as { response?: { headers?: unknown } } | null)
      ?.response?.headers;
    return headers && typeof headers === 'object'
      ? (headers as Record<string, string | undefined>)
      : null;
  }

  /**
   * Normalize a thrown value into a typed {@link AppError}. The message carries only the
   * HTTP status + Octokit's own message — never headers or the request body, which could
   * contain the auth token (heightened-scrutiny: no secrets in logs/errors).
   */
  private wrap(err: unknown): AppError {
    if (err instanceof AppError) return err;
    const status = this.statusOf(err);
    const base = err instanceof Error ? err.message : String(err);
    const message =
      status !== null
        ? `GitHub API request failed (${status}): ${base}`
        : `GitHub API request failed: ${base}`;
    return new AppError('integration', message);
  }
}
