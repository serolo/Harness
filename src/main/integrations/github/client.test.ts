// GithubClient tests (Phase 5, Task 5) — written independently of the implementation,
// from the spec in this file's own header comments + `@shared/github` DTOs. Heightened
// scrutiny: network egress, ETag conditional-caching, rate-limit backoff, no secret
// leaks. NO live network / nock: a fake Octokit (`{ request, graphql }`) stands in for
// the real client, and `sleep`/`now` are injected so backoff paths are instant and
// deterministic.

import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { GithubClient, parseOwnerName } from './client';
import { AppError } from '../../error';

/** Minimal fake Octokit: only `request`/`graphql` are ever called by GithubClient. */
function fakeOctokit(): {
  request: ReturnType<typeof vi.fn>;
  graphql: ReturnType<typeof vi.fn>;
} {
  return { request: vi.fn(), graphql: vi.fn() };
}

/** A successful Octokit REST response shape. */
function ok<T>(
  data: T,
  headers: Record<string, string | undefined> = {},
): { data: T; status: number; headers: Record<string, string | undefined> } {
  return { data, status: 200, headers };
}

/** A thrown Octokit-style error carrying `status` + `response.headers`. */
function httpError(
  status: number,
  headers: Record<string, string | undefined> = {},
  message = 'error',
): Error & { status: number; response: { headers: typeof headers } } {
  const err = new Error(message) as Error & {
    status: number;
    response: { headers: typeof headers };
  };
  err.status = status;
  err.response = { headers };
  return err;
}

/** A minimal REST pull payload (only fields the client maps). */
function restPull(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 42,
    html_url: 'https://github.com/o/r/pull/42',
    title: 'Add feature',
    draft: false,
    state: 'open',
    mergeable_state: 'clean',
    user: { login: 'alice' },
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeClient(
  octokit: ReturnType<typeof fakeOctokit>,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): GithubClient {
  const sleep: (ms: number) => Promise<void> =
    opts.sleep ?? vi.fn(async (_ms: number) => undefined);
  const now: () => number = opts.now ?? vi.fn(() => 0);
  return new GithubClient(
    octokit as unknown as Octokit,
    { owner: 'o', name: 'r' },
    { sleep, now },
  );
}

describe('parseOwnerName', () => {
  it('parses an https origin with .git suffix', () => {
    expect(parseOwnerName('https://github.com/o/r.git')).toEqual({
      owner: 'o',
      name: 'r',
    });
  });

  it('parses an https origin without .git suffix', () => {
    expect(parseOwnerName('https://github.com/o/r')).toEqual({
      owner: 'o',
      name: 'r',
    });
  });

  it('parses an ssh origin', () => {
    expect(parseOwnerName('git@github.com:o/r.git')).toEqual({
      owner: 'o',
      name: 'r',
    });
  });

  it('parses an ssh-config host alias origin', () => {
    expect(parseOwnerName('git@github-work:o/r.git')).toEqual({
      owner: 'o',
      name: 'r',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(parseOwnerName('https://github.com/o/r/')).toEqual({
      owner: 'o',
      name: 'r',
    });
  });

  it('throws AppError(integration) on an unparseable URL', () => {
    expect(() => parseOwnerName('not a url')).toThrow(AppError);
    try {
      parseOwnerName('not a url');
      expect.fail('expected parseOwnerName to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('integration');
    }
  });

  it('throws on a non-github.com host', () => {
    expect(() => parseOwnerName('https://gitlab.com/o/r.git')).toThrow(
      AppError,
    );
  });
});

describe('GithubClient PRs', () => {
  it('getPr maps the matching PR to a PrSummary', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(ok([restPull()]));
    const client = makeClient(octokit);

    const pr = await client.getPr('feature-branch');

    expect(pr).toEqual({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'Add feature',
      draft: false,
      mergeableState: 'clean',
      state: 'open',
    });
    // head filter + owner scoping is sent correctly
    const [route, params] = octokit.request.mock.calls[0];
    expect(route).toBe('GET /repos/{owner}/{repo}/pulls');
    expect(params).toMatchObject({
      head: 'o:feature-branch',
      state: 'open',
      per_page: 1,
    });
  });

  it('getPr returns null when the branch has no PR', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(ok([]));
    const client = makeClient(octokit);

    await expect(client.getPr('no-pr-branch')).resolves.toBeNull();
  });

  it('getPrByNumber maps a full PR detail to a PrSummary', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(
      ok(restPull({ number: 7, mergeable_state: 'blocked' })),
    );
    const client = makeClient(octokit);

    const pr = await client.getPrByNumber(7);

    expect(pr.number).toBe(7);
    expect(pr.mergeableState).toBe('blocked');
    const [route, params] = octokit.request.mock.calls[0];
    expect(route).toBe('GET /repos/{owner}/{repo}/pulls/{pull_number}');
    expect(params).toMatchObject({ pull_number: 7 });
  });

  it('createPr sends head/base/title/body/draft and maps the result', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(
      ok(restPull({ number: 99, title: 'New PR', draft: true })),
    );
    const client = makeClient(octokit);

    const pr = await client.createPr({
      head: 'feature',
      base: 'main',
      title: 'New PR',
      body: 'description',
      draft: true,
    });

    expect(pr).toMatchObject({ number: 99, title: 'New PR', draft: true });
    const [route, params] = octokit.request.mock.calls[0];
    expect(route).toBe('POST /repos/{owner}/{repo}/pulls');
    expect(params).toMatchObject({
      head: 'feature',
      base: 'main',
      title: 'New PR',
      body: 'description',
      draft: true,
    });
  });

  it('createPr defaults draft to false when omitted', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(ok(restPull()));
    const client = makeClient(octokit);

    await client.createPr({
      head: 'feature',
      base: 'main',
      title: 'T',
      body: 'B',
    });

    const [, params] = octokit.request.mock.calls[0];
    expect(params).toMatchObject({ draft: false });
  });

  it('mergePr issues a PUT .../merge with the given merge_method', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(ok({}));
    const client = makeClient(octokit);

    await client.mergePr(42, 'squash');

    const [route, params] = octokit.request.mock.calls[0];
    expect(route).toBe('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge');
    expect(params).toMatchObject({ pull_number: 42, merge_method: 'squash' });
  });

  it('mergePr threads through each supported merge method', async () => {
    for (const method of ['merge', 'squash', 'rebase'] as const) {
      const octokit = fakeOctokit();
      octokit.request.mockResolvedValueOnce(ok({}));
      const client = makeClient(octokit);
      await client.mergePr(1, method);
      expect(octokit.request.mock.calls[0][1]).toMatchObject({
        merge_method: method,
      });
    }
  });

  it('listPrs maps rows including a missing author/updatedAt', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(
      ok([
        restPull({ number: 1, user: { login: 'bob' } }),
        restPull({ number: 2, user: null, updated_at: undefined }),
      ]),
    );
    const client = makeClient(octokit);

    const rows = await client.listPrs();

    expect(rows).toEqual([
      expect.objectContaining({ number: 1, author: 'bob' }),
      expect.objectContaining({ number: 2, author: undefined }),
    ]);
  });
});

describe('GithubClient issues', () => {
  it('listIssues excludes rows that are actually PRs', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(
      ok([
        {
          number: 1,
          title: 'Real issue',
          html_url: 'https://github.com/o/r/issues/1',
          state: 'open',
        },
        {
          number: 2,
          title: 'Actually a PR',
          html_url: 'https://github.com/o/r/pull/2',
          pull_request: { url: 'x' },
        },
      ]),
    );
    const client = makeClient(octokit);

    const issues = await client.listIssues();

    expect(issues).toEqual([
      expect.objectContaining({ number: 1, title: 'Real issue' }),
    ]);
  });
});

describe('GithubClient checks/statuses', () => {
  it('listCheckRuns maps a mix of pass/fail rows', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(
      ok({
        check_runs: [
          {
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            details_url: 'https://ci/1',
          },
          {
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            details_url: null,
          },
        ],
      }),
    );
    const client = makeClient(octokit);

    const runs = await client.listCheckRuns('deadbeef');

    expect(runs).toEqual([
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        detailsUrl: 'https://ci/1',
      },
      {
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        detailsUrl: null,
      },
    ]);
    const [route, params] = octokit.request.mock.calls[0];
    expect(route).toBe('GET /repos/{owner}/{repo}/commits/{ref}/check-runs');
    expect(params).toMatchObject({ ref: 'deadbeef' });
  });

  it('listStatuses maps the combined-status rows', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(
      ok({
        statuses: [
          { context: 'ci/lint', state: 'success', target_url: 'https://ci/2' },
          { context: 'ci/e2e', state: 'pending', target_url: null },
        ],
      }),
    );
    const client = makeClient(octokit);

    const statuses = await client.listStatuses('deadbeef');

    expect(statuses).toEqual([
      { context: 'ci/lint', state: 'success', targetUrl: 'https://ci/2' },
      { context: 'ci/e2e', state: 'pending', targetUrl: null },
    ]);
  });

  it('listDeployments filters by sha when provided', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(
      ok([{ id: 1, environment: 'prod', sha: 'abc' }]),
    );
    const client = makeClient(octokit);

    await client.listDeployments('abc');

    const [, params] = octokit.request.mock.calls[0];
    expect(params).toMatchObject({ sha: 'abc' });
  });

  it('listDeploymentStatuses maps rows', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(
      ok([{ state: 'success', environment_url: 'https://env/1' }]),
    );
    const client = makeClient(octokit);

    const rows = await client.listDeploymentStatuses(55);

    expect(rows).toEqual([
      { state: 'success', environmentUrl: 'https://env/1' },
    ]);
    const [, params] = octokit.request.mock.calls[0];
    expect(params).toMatchObject({ deployment_id: 55 });
  });
});

describe('GithubClient review threads (GraphQL)', () => {
  it('maps threads to ReviewThread[] with resolved from isResolved, in ONE call', async () => {
    const octokit = fakeOctokit();
    octokit.graphql.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'RT_1',
                isResolved: true,
                path: 'src/a.ts',
                line: 10,
                comments: {
                  nodes: [{ author: { login: 'alice' }, body: 'looks good' }],
                },
              },
              {
                id: 'RT_2',
                isResolved: false,
                path: null,
                line: null,
                comments: { nodes: [{ author: null, body: 'hmm' }] },
              },
            ],
          },
        },
      },
    });
    const client = makeClient(octokit);

    const threads = await client.reviewThreads(42);

    expect(threads).toEqual([
      {
        id: 'RT_1',
        path: 'src/a.ts',
        line: 10,
        resolved: true,
        comments: [{ author: 'alice', body: 'looks good' }],
      },
      {
        id: 'RT_2',
        path: undefined,
        line: undefined,
        resolved: false,
        comments: [{ author: '', body: 'hmm' }],
      },
    ]);
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
    const [, vars] = octokit.graphql.mock.calls[0];
    expect(vars).toMatchObject({ owner: 'o', name: 'r', number: 42 });
  });

  it('returns [] when the PR/threads are absent from the response', async () => {
    const octokit = fakeOctokit();
    octokit.graphql.mockResolvedValueOnce({ repository: null });
    const client = makeClient(octokit);

    await expect(client.reviewThreads(1)).resolves.toEqual([]);
  });

  it('resolveThread issues the resolve mutation with the thread id', async () => {
    const octokit = fakeOctokit();
    octokit.graphql.mockResolvedValueOnce({
      resolveReviewThread: { thread: { id: 'RT_1' } },
    });
    const client = makeClient(octokit);

    await client.resolveThread('RT_1');

    expect(octokit.graphql).toHaveBeenCalledTimes(1);
    const [query, vars] = octokit.graphql.mock.calls[0];
    expect(query).toMatch(/resolveReviewThread/);
    expect(vars).toMatchObject({ threadId: 'RT_1' });
  });
});

describe('GithubClient ETag conditional caching', () => {
  it('sends if-none-match on the second call and serves the cached body on a 304', async () => {
    const octokit = fakeOctokit();
    const firstPayload = {
      check_runs: [
        {
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          details_url: null,
        },
      ],
    };
    octokit.request.mockResolvedValueOnce(
      ok(firstPayload, { etag: 'W/"abc"' }),
    );
    const client = makeClient(octokit);

    const first = await client.listCheckRuns('sha1');
    expect(first).toEqual([
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        detailsUrl: null,
      },
    ]);

    // Second call: fake throws a 304 — the client must have SENT if-none-match with the
    // stored etag, and must return the cached body rather than treating 304 as an error.
    octokit.request.mockImplementationOnce(async (_route, params) => {
      expect(
        (params as { headers?: Record<string, string> }).headers?.[
          'if-none-match'
        ],
      ).toBe('W/"abc"');
      throw httpError(304, {});
    });

    const second = await client.listCheckRuns('sha1');
    expect(second).toEqual(first);
    expect(octokit.request).toHaveBeenCalledTimes(2);
  });

  it('refreshes the cached etag/body on a subsequent 200', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(
      ok({ check_runs: [] }, { etag: 'W/"v1"' }),
    );
    const client = makeClient(octokit);
    await client.listCheckRuns('sha1');

    const updatedPayload = {
      check_runs: [
        {
          name: 'new',
          status: 'completed',
          conclusion: 'success',
          details_url: null,
        },
      ],
    };
    octokit.request.mockResolvedValueOnce(
      ok(updatedPayload, { etag: 'W/"v2"' }),
    );
    const second = await client.listCheckRuns('sha1');
    expect(second).toEqual([
      {
        name: 'new',
        status: 'completed',
        conclusion: 'success',
        detailsUrl: null,
      },
    ]);

    // Third call, a 304 now must serve the REFRESHED (v2) body, not the stale v1 one.
    octokit.request.mockImplementationOnce(async (_route, params) => {
      expect(
        (params as { headers?: Record<string, string> }).headers?.[
          'if-none-match'
        ],
      ).toBe('W/"v2"');
      throw httpError(304, {});
    });
    const third = await client.listCheckRuns('sha1');
    expect(third).toEqual(second);
  });

  it('caches getPr/listPrs/listIssues/listStatuses/listDeployments/listDeploymentStatuses independently by key', async () => {
    // Two different SHAs must not collide in the cache: a 304 for sha2 without a prior
    // 200 for sha2 has no cached entry to serve, so it must propagate as a real error.
    const octokit = fakeOctokit();
    octokit.request.mockImplementationOnce(async () => {
      throw httpError(304, {});
    });
    const client = makeClient(octokit);

    await expect(client.listCheckRuns('never-seen-sha')).rejects.toThrow(
      AppError,
    );
  });
});

describe('GithubClient rate-limit backoff', () => {
  it('waits out an exhausted primary budget via the injected sleep before the next call', async () => {
    const octokit = fakeOctokit();
    const sleep = vi.fn(async (_ms: number) => undefined);
    // now() = 0s; reset at epoch-seconds 5 → wait 5000ms, well under MAX_BACKOFF_MS.
    const now = vi.fn(() => 0);
    const client = makeClient(octokit, { sleep, now });

    // First call exhausts the budget.
    octokit.request.mockResolvedValueOnce(
      ok(restPull(), {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '5',
      }),
    );
    await client.getPrByNumber(1);
    expect(sleep).not.toHaveBeenCalled(); // no wait needed before the FIRST call

    // Second call must wait for the remaining budget to reset before issuing the request.
    octokit.request.mockResolvedValueOnce(ok(restPull()));
    await client.getPrByNumber(2);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBe(5000);
  });

  it('retries a secondary 403 with retry-after using the injected sleep, then succeeds', async () => {
    const octokit = fakeOctokit();
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(octokit, { sleep });

    octokit.request
      .mockImplementationOnce(async () => {
        throw httpError(403, { 'retry-after': '2' });
      })
      .mockResolvedValueOnce(ok(restPull()));

    const pr = await client.getPrByNumber(1);

    expect(pr.number).toBe(42);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBe(2000); // honors retry-after (seconds → ms)
    expect(octokit.request).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded number of secondary-rate retries and surfaces AppError', async () => {
    const octokit = fakeOctokit();
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(octokit, { sleep });

    // Always a secondary rate-limit signal — never succeeds.
    octokit.request.mockImplementation(async () => {
      throw httpError(429, { 'x-ratelimit-remaining': '0' });
    });

    await expect(client.getPrByNumber(1)).rejects.toThrow(AppError);
    // bounded: SECONDARY_RATE_MAX_RETRIES retries + the initial attempt, no more.
    expect(octokit.request.mock.calls.length).toBeLessThanOrEqual(4);
    // every sleep is bounded, so this never actually hangs in real time.
    for (const call of sleep.mock.calls) {
      expect(call[0]).toBeLessThanOrEqual(60_000);
    }
  });

  it('does not retry a plain 403/429 lacking any rate-limit signal', async () => {
    const octokit = fakeOctokit();
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(octokit, { sleep });

    octokit.request.mockImplementationOnce(async () => {
      throw httpError(403, {}); // no retry-after, no x-ratelimit-remaining
    });

    await expect(client.getPrByNumber(1)).rejects.toThrow(AppError);
    expect(sleep).not.toHaveBeenCalled();
    expect(octokit.request).toHaveBeenCalledTimes(1);
  });
});

describe('GithubClient error handling / no secret leakage', () => {
  it('wraps a thrown error into an AppError(integration) carrying only status + message', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockImplementationOnce(async () => {
      throw httpError(
        500,
        { authorization: 'Bearer secret-token-xyz' },
        'boom',
      );
    });
    const client = makeClient(octokit);

    try {
      await client.getPrByNumber(1);
      expect.fail('expected getPrByNumber to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('integration');
      expect(appErr.message).toContain('500');
      expect(appErr.message).toContain('boom');
      // the secret header value must never appear in the surfaced message
      expect(appErr.message).not.toContain('secret-token-xyz');
      expect(JSON.stringify(appErr)).not.toContain('secret-token-xyz');
    }
  });

  it('never calls console methods during a normal call (no incidental logging of requests)', async () => {
    const octokit = fakeOctokit();
    octokit.request.mockResolvedValueOnce(ok(restPull()));
    const client = makeClient(octokit);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await client.getPrByNumber(1);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('propagates a GraphQL failure as an AppError without leaking the query variables', async () => {
    const octokit = fakeOctokit();
    octokit.graphql.mockImplementationOnce(async () => {
      throw httpError(401, { authorization: 'Bearer topsecret' }, 'bad creds');
    });
    const client = makeClient(octokit);

    try {
      await client.reviewThreads(1);
      expect.fail('expected reviewThreads to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).not.toContain('topsecret');
    }
  });
});
