// LinearClient tests (Phase 7, Task 5) — written independently of the implementation, from
// this module's header contract + the Linear GraphQL API shapes. Heightened scrutiny:
// network egress, credential handling, defensive response parsing, NO secret leaks. NO live
// network: a fake `fetch` (FetchLike) stands in and records the requests it receives.

import { describe, it, expect } from 'vitest';

import { AppError } from '@shared/errors';

import {
  LinearClient,
  authHeaderValue,
  graphqlRequest,
  LINEAR_GRAPHQL_URL,
  type FetchLike,
  type HttpResponse,
} from './client';

/** Build a fake HttpResponse. */
function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/** A fetch fake that records every request and returns a fixed response. */
function recordingFetch(response: HttpResponse): {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }>;
} {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

/** Parse a recorded request body into `{ query, variables }`. */
function parseBody(init?: Parameters<FetchLike>[1]): {
  query: string;
  variables: Record<string, unknown>;
} {
  return JSON.parse(init?.body ?? '{}') as {
    query: string;
    variables: Record<string, unknown>;
  };
}

describe('authHeaderValue', () => {
  it('sends a personal API key (lin_api_ prefix) RAW, without a Bearer prefix', () => {
    expect(authHeaderValue('lin_api_abc123')).toBe('lin_api_abc123');
  });

  it('sends a non-key token (OAuth access token) with a Bearer prefix', () => {
    expect(authHeaderValue('oauth-access-token')).toBe(
      'Bearer oauth-access-token',
    );
  });
});

describe('graphqlRequest', () => {
  it('POSTs to the Linear endpoint with the Authorization header + JSON body', async () => {
    const { fetch, calls } = recordingFetch(
      jsonResponse(200, { data: { ok: true } }),
    );

    const data = await graphqlRequest<{ ok: boolean }>({
      token: 'lin_api_key',
      query: 'query { ok }',
      variables: { a: 1 },
      fetch,
    });

    expect(data).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(LINEAR_GRAPHQL_URL);
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers?.Authorization).toBe('lin_api_key');
    expect(parseBody(calls[0].init)).toEqual({
      query: 'query { ok }',
      variables: { a: 1 },
    });
  });

  it('throws a typed AppError on a non-2xx HTTP status, carrying only the status (no token)', async () => {
    const token = 'lin_api_shouldNeverLeak';
    const { fetch } = recordingFetch(jsonResponse(401, {}));

    try {
      await graphqlRequest({ token, query: 'query { viewer { id } }', fetch });
      expect.unreachable('graphqlRequest should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('integration');
      expect(appErr.message).toContain('401');
      expect(appErr.message).not.toContain(token);
      expect(JSON.stringify(appErr)).not.toContain(token);
    }
  });

  it('throws a typed AppError on a GraphQL errors array (200) without leaking the token', async () => {
    const token = 'lin_api_secretKeyValue';
    const { fetch } = recordingFetch(
      jsonResponse(200, {
        errors: [{ message: 'Entity not found' }],
      }),
    );

    try {
      await graphqlRequest({ token, query: 'query { viewer { id } }', fetch });
      expect.unreachable('graphqlRequest should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).toContain('Entity not found');
      expect((err as AppError).message).not.toContain(token);
    }
  });

  it('degrades a data-less response to a typed AppError (never a raw throw)', async () => {
    const { fetch } = recordingFetch(jsonResponse(200, { data: null }));

    await expect(
      graphqlRequest({ token: 'lin_api_x', query: 'query { x }', fetch }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('LinearClient.viewerLabel', () => {
  it('resolves the viewer name and sends a raw Authorization header for an API key', async () => {
    const { fetch, calls } = recordingFetch(
      jsonResponse(200, {
        data: { viewer: { id: 'u1', name: 'Ada Lovelace', email: 'ada@x.io' } },
      }),
    );
    const client = new LinearClient({ token: 'lin_api_key', fetch });

    const label = await client.viewerLabel();

    expect(label).toBe('Ada Lovelace');
    expect(calls[0].init?.headers?.Authorization).toBe('lin_api_key');
  });

  it('falls back to email, then id, when name is absent', async () => {
    const emailOnly = new LinearClient({
      token: 'lin_api_k',
      fetch: recordingFetch(
        jsonResponse(200, {
          data: { viewer: { id: 'u1', name: null, email: 'only@x.io' } },
        }),
      ).fetch,
    });
    expect(await emailOnly.viewerLabel()).toBe('only@x.io');

    const idOnly = new LinearClient({
      token: 'lin_api_k',
      fetch: recordingFetch(
        jsonResponse(200, {
          data: { viewer: { id: 'u-fallback', name: null, email: null } },
        }),
      ).fetch,
    });
    expect(await idOnly.viewerLabel()).toBe('u-fallback');
  });

  it('rejects a bad key with a typed AppError that does NOT contain the key', async () => {
    const token = 'lin_api_badKeyMustNotLeak';
    const client = new LinearClient({
      token,
      fetch: recordingFetch(jsonResponse(401, {})).fetch,
    });

    try {
      await client.viewerLabel();
      expect.unreachable('viewerLabel should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).not.toContain(token);
      expect(JSON.stringify(err)).not.toContain(token);
    }
  });

  it('rejects a viewer-less response with a typed AppError', async () => {
    const client = new LinearClient({
      token: 'lin_api_k',
      fetch: recordingFetch(jsonResponse(200, { data: { viewer: null } }))
        .fetch,
    });

    await expect(client.viewerLabel()).rejects.toBeInstanceOf(AppError);
  });
});

describe('LinearClient.listIssues', () => {
  it('maps GraphQL issue nodes to LinearIssue[]', async () => {
    const { fetch, calls } = recordingFetch(
      jsonResponse(200, {
        data: {
          issues: {
            nodes: [
              {
                id: 'issue-1',
                identifier: 'ENG-123',
                title: 'Fix the thing',
                url: 'https://linear.app/x/issue/ENG-123',
                state: { name: 'In Progress' },
              },
              {
                id: 'issue-2',
                identifier: 'ENG-124',
                title: 'Ship it',
                url: 'https://linear.app/x/issue/ENG-124',
                state: null,
              },
            ],
          },
        },
      }),
    );
    const client = new LinearClient({ token: 'lin_api_k', fetch });

    const issues = await client.listIssues({ first: 10 });

    expect(issues).toEqual([
      {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix the thing',
        url: 'https://linear.app/x/issue/ENG-123',
        state: 'In Progress',
      },
      {
        id: 'issue-2',
        identifier: 'ENG-124',
        title: 'Ship it',
        url: 'https://linear.app/x/issue/ENG-124',
        state: null,
      },
    ]);
    // the requested page size is threaded through as a GraphQL variable
    expect(parseBody(calls[0].init).variables).toMatchObject({ first: 10 });
  });

  it('degrades a null issues connection to an empty list', async () => {
    const client = new LinearClient({
      token: 'lin_api_k',
      fetch: recordingFetch(jsonResponse(200, { data: { issues: null } }))
        .fetch,
    });

    await expect(client.listIssues()).resolves.toEqual([]);
  });
});

describe('LinearClient write-back mutations', () => {
  it('linkBranch issues an attachmentCreate mutation with the issue id + url', async () => {
    const { fetch, calls } = recordingFetch(
      jsonResponse(200, {
        data: { attachmentCreate: { success: true, attachment: { id: 'a1' } } },
      }),
    );
    const client = new LinearClient({ token: 'lin_api_k', fetch });

    await client.linkBranch('issue-1', 'https://github.com/o/r/tree/feature');

    const body = parseBody(calls[0].init);
    expect(body.query).toContain('attachmentCreate');
    expect(body.variables).toMatchObject({
      issueId: 'issue-1',
      url: 'https://github.com/o/r/tree/feature',
    });
    expect(typeof body.variables.title).toBe('string');
  });

  it('linkPr issues an attachmentCreate mutation with the PR url', async () => {
    const { fetch, calls } = recordingFetch(
      jsonResponse(200, {
        data: { attachmentCreate: { success: true, attachment: { id: 'a2' } } },
      }),
    );
    const client = new LinearClient({ token: 'lin_api_k', fetch });

    await client.linkPr('issue-9', 'https://github.com/o/r/pull/42');

    const body = parseBody(calls[0].init);
    expect(body.query).toContain('attachmentCreate');
    expect(body.variables).toMatchObject({
      issueId: 'issue-9',
      url: 'https://github.com/o/r/pull/42',
    });
  });

  it('throws a typed AppError when attachmentCreate reports success:false', async () => {
    const client = new LinearClient({
      token: 'lin_api_k',
      fetch: recordingFetch(
        jsonResponse(200, { data: { attachmentCreate: { success: false } } }),
      ).fetch,
    });

    await expect(
      client.linkBranch('issue-1', 'https://x/branch'),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('setIssueState issues an issueUpdate mutation with id + stateId', async () => {
    const { fetch, calls } = recordingFetch(
      jsonResponse(200, {
        data: { issueUpdate: { success: true, issue: { id: 'issue-1' } } },
      }),
    );
    const client = new LinearClient({ token: 'lin_api_k', fetch });

    await client.setIssueState('issue-1', 'state-done');

    const body = parseBody(calls[0].init);
    expect(body.query).toContain('issueUpdate');
    expect(body.variables).toMatchObject({
      id: 'issue-1',
      stateId: 'state-done',
    });
  });

  it('throws a typed AppError when issueUpdate reports success:false', async () => {
    const client = new LinearClient({
      token: 'lin_api_k',
      fetch: recordingFetch(
        jsonResponse(200, { data: { issueUpdate: { success: false } } }),
      ).fetch,
    });

    await expect(
      client.setIssueState('issue-1', 'state-x'),
    ).rejects.toBeInstanceOf(AppError);
  });
});
