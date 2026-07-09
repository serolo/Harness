// LinearClient — the thin, injectable wrapper around Linear's GraphQL API (spec §6 /
// Phase 7 Task 5) that the issue-picker + branch/PR write-back flows use. Linear exposes a
// single GraphQL endpoint (`https://api.linear.app/graphql`); unlike the GitHub REST
// client this speaks GraphQL directly over an injected `fetch` — no `graphql-request`
// dependency (see the dependency note below).
//
// Design constraints (see root CLAUDE.md + .claude/rules/{security,architecture}.md):
//   - Heightened-scrutiny path (network egress + credentials). The token is placed ONLY
//     into the `Authorization` request header; it is NEVER logged and NEVER put into a
//     thrown message. Error messages carry only the HTTP status or Linear's own non-secret
//     GraphQL error text — never the request headers or the token.
//   - Fully injectable: `fetch` is a constructor dependency (default = the runtime global),
//     so tests drive the whole flow with a fake and without a live network.
//   - Responses are treated DEFENSIVELY: an unexpected/malformed shape degrades to a typed
//     `AppError('integration', …)` or a safe empty list rather than throwing a raw value.
//
// DEPENDENCY NOTE: the plan floated `graphql-request`, but Linear's API is a single POST of
// `{ query, variables }` returning `{ data, errors }`. A ~15-line injected-`fetch` helper
// (mirroring `github/auth.ts`'s dependency-free fetch approach) covers it, keeps the token
// handling in our control, and avoids adding an npm dependency — so we do NOT add one.

import { AppError } from '@shared/errors';
import type { LinearIssue } from '@shared/linear';

/** Linear's single GraphQL endpoint. */
export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/** The minimal `Response` slice this module consumes (keeps test fakes trivial). */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * The narrow `fetch` shape injected into the Linear HTTP calls. The runtime global `fetch`
 * structurally satisfies this, and a test fake need only implement these fields. Kept local
 * to the Linear subsystem (rather than importing GitHub's) so the two connectors stay
 * decoupled.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;

/** The runtime global `fetch`, adapted to {@link FetchLike}. */
const boundFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/**
 * Build the `Authorization` header value for a Linear credential. Linear personal API keys
 * (prefixed `lin_api_`) are sent RAW — sending them with a `Bearer` prefix fails auth —
 * whereas OAuth2 access tokens use the `Bearer` scheme. The token is used only here; it is
 * never logged or surfaced.
 */
export function authHeaderValue(token: string): string {
  return token.startsWith('lin_api_') ? token : `Bearer ${token}`;
}

/**
 * Low-level Linear GraphQL POST. Sends `{ query, variables }` with the token in the
 * `Authorization` header and returns the typed `data` payload.
 *
 * Fails CLOSED with a typed {@link AppError} — never a raw throw — on a non-2xx HTTP status,
 * a GraphQL `errors` array, or a response missing `data`. The token is NEVER included in any
 * thrown message: HTTP failures carry only the status, and GraphQL failures carry only
 * Linear's own (server-generated, non-secret) error text.
 */
export async function graphqlRequest<T>(opts: {
  token: string;
  query: string;
  variables?: Record<string, unknown>;
  fetch?: FetchLike;
}): Promise<T> {
  const doFetch = opts.fetch ?? boundFetch;
  const res = await doFetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: authHeaderValue(opts.token),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: opts.query,
      variables: opts.variables ?? {},
    }),
  });
  if (!res.ok) {
    // Deliberately opaque: only the status, never the token or request headers.
    throw new AppError(
      'integration',
      `Linear API request failed (${res.status})`,
    );
  }

  const body = (await res.json()) as {
    data?: unknown;
    errors?: unknown;
  };

  // Linear returns HTTP 200 with a top-level `errors` array on a GraphQL error. Surface
  // only Linear's own message text (non-secret) — never the variables or headers.
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new AppError(
      'integration',
      `Linear GraphQL error: ${firstErrorMessage(body.errors)}`,
    );
  }
  if (body.data === undefined || body.data === null) {
    throw new AppError('integration', 'malformed Linear GraphQL response');
  }
  return body.data as T;
}

/** Extract a display message from a GraphQL `errors` array without leaking anything else. */
function firstErrorMessage(errors: unknown[]): string {
  const first = errors[0];
  if (
    typeof first === 'object' &&
    first !== null &&
    'message' in first &&
    typeof (first as { message?: unknown }).message === 'string'
  ) {
    return (first as { message: string }).message;
  }
  return 'unknown error';
}

// --- GraphQL documents (kept small per the plan's fixture-maintenance risk note) ---------

const VIEWER_QUERY = `
  query {
    viewer { id name email }
  }
`;

const ISSUES_QUERY = `
  query ($first: Int) {
    issues(first: $first, orderBy: updatedAt) {
      nodes {
        id
        identifier
        title
        url
        state { name }
      }
    }
  }
`;

const ATTACHMENT_CREATE_MUTATION = `
  mutation ($issueId: String!, $url: String!, $title: String!) {
    attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) {
      success
      attachment { id }
    }
  }
`;

const ISSUE_UPDATE_STATE_MUTATION = `
  mutation ($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue { id }
    }
  }
`;

/** Default limit for {@link LinearClient.listIssues} when the caller does not specify one. */
const DEFAULT_ISSUE_LIMIT = 50;

// --- Local GraphQL payload shapes (only the fields we map) -------------------------------

interface ViewerPayload {
  viewer: { id: string; name?: string | null; email?: string | null } | null;
}

interface IssuesPayload {
  issues: {
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
      url: string;
      state: { name?: string | null } | null;
    }>;
  } | null;
}

interface AttachmentCreatePayload {
  attachmentCreate: { success: boolean } | null;
}

interface IssueUpdatePayload {
  issueUpdate: { success: boolean } | null;
}

/**
 * A Linear GraphQL API façade. Construct with an already-resolved token (kept as a
 * constructor arg so auth/decryption stays in `LinearService`) and an injected `fetch`.
 * Every method treats the response defensively: unknown shapes degrade to a typed
 * {@link AppError} or a safe empty list.
 */
export class LinearClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(deps: { token: string; fetch?: FetchLike }) {
    this.token = deps.token;
    this.fetchImpl = deps.fetch ?? boundFetch;
  }

  /**
   * Validate the credential + resolve the account label by querying `viewer`. Returns the
   * viewer's name, falling back to email then id. Throws a typed {@link AppError} (with NO
   * token in the message) on any auth/HTTP failure or a viewer-less response.
   */
  async viewerLabel(): Promise<string> {
    const data = await this.run<ViewerPayload>(VIEWER_QUERY);
    const viewer = data.viewer;
    if (viewer === null || typeof viewer.id !== 'string') {
      throw new AppError(
        'integration',
        'Linear viewer response missing account',
      );
    }
    // Prefer the human name; fall back to email, then the opaque id, so the label is never
    // empty.
    return viewer.name ?? viewer.email ?? viewer.id;
  }

  /**
   * List issues (newest-updated first), mapped to {@link LinearIssue}. A missing/`null`
   * connection degrades to an empty list rather than throwing.
   */
  async listIssues(opts?: { first?: number }): Promise<LinearIssue[]> {
    const data = await this.run<IssuesPayload>(ISSUES_QUERY, {
      first: opts?.first ?? DEFAULT_ISSUE_LIMIT,
    });
    const nodes = data.issues?.nodes ?? [];
    return nodes.map((node) => ({
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      url: node.url,
      state: node.state?.name ?? null,
    }));
  }

  /**
   * Link a workspace branch back to an issue as a Linear attachment. `title` defaults to a
   * branch label. Throws a typed {@link AppError} if the mutation reports failure.
   */
  async linkBranch(
    issueId: string,
    url: string,
    title?: string,
  ): Promise<void> {
    await this.createAttachment(issueId, url, title ?? `Branch: ${url}`);
  }

  /**
   * Link a pull request back to an issue as a Linear attachment. `title` defaults to a PR
   * label. Throws a typed {@link AppError} if the mutation reports failure.
   */
  async linkPr(issueId: string, url: string, title?: string): Promise<void> {
    await this.createAttachment(issueId, url, title ?? `Pull request: ${url}`);
  }

  /**
   * Transition an issue to a workflow state (the settings-gated status change on PR
   * open/merge). Throws a typed {@link AppError} if the mutation reports failure.
   */
  async setIssueState(issueId: string, stateId: string): Promise<void> {
    const data = await this.run<IssueUpdatePayload>(
      ISSUE_UPDATE_STATE_MUTATION,
      { id: issueId, stateId },
    );
    if (data.issueUpdate?.success !== true) {
      throw new AppError('integration', 'Linear issue state update failed');
    }
  }

  /** Shared attachment-create write-back used by {@link linkBranch}/{@link linkPr}. */
  private async createAttachment(
    issueId: string,
    url: string,
    title: string,
  ): Promise<void> {
    const data = await this.run<AttachmentCreatePayload>(
      ATTACHMENT_CREATE_MUTATION,
      { issueId, url, title },
    );
    if (data.attachmentCreate?.success !== true) {
      throw new AppError('integration', 'Linear attachment create failed');
    }
  }

  /** Issue a GraphQL request with this client's token + injected fetch. */
  private run<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    return graphqlRequest<T>({
      token: this.token,
      query,
      variables,
      fetch: this.fetchImpl,
    });
  }
}
