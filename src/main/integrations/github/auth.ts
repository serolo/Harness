// GitHub authentication — PAT validation + OAuth device-flow login (spec §5.6 / §6).
//
// Fetch-based and dependency-free: we speak the GitHub REST + device-flow HTTP APIs
// directly rather than pulling `@octokit/auth-oauth-device`, and `fetch` is injected
// (default = the runtime global) so tests drive the whole flow with a fake and without a
// live network or a real GitHub app.
//
// SECURITY (heightened-scrutiny path — secrets/tokens): a token is NEVER placed into any
// thrown message or log. `AppError` messages here carry only GitHub's non-secret error
// CODES (e.g. `authorization_pending`) or fixed strings — never the token or PAT.
//
// FRAME OWNERSHIP: `deviceFlowLogin` emits only the PROGRESS frames of the
// `ConnectStatus` contract — `device_code`, then `pending`/`slow_down` while polling —
// and throws a typed `AppError` on terminal failure. It deliberately does NOT emit the
// terminal `connected`/`error` frames: the `connected` frame must carry the persisted
// `integrations` row id, which only exists after `IntegrationService` writes the row, so
// the caller (`IntegrationService.connectGithub`) owns emitting the single terminal frame.

import { AppError } from '@shared/errors';
import type { ConnectStatus } from '@shared/github';

/** The minimal `Response` slice this module consumes (keeps fakes trivial to write). */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * The narrow `fetch` shape injected into the auth flow. The runtime global `fetch`
 * structurally satisfies this, and a test fake need only implement these fields.
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

const GITHUB_API_BASE = 'https://api.github.com';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** GitHub requires a User-Agent on API requests. */
const USER_AGENT = 'harness';
/** Default scopes when the caller does not specify (PR + repo status access). */
const DEFAULT_SCOPES = 'repo';
/** Fallbacks if GitHub omits them from the device-code response. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 900;
/** `slow_down` bumps the poll interval by this much when no new interval is supplied. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** The runtime global `fetch`, adapted to {@link FetchLike}. */
const boundFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Default sleep — real timers. Injected in tests so polling never actually waits. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Validate a personal access token by fetching the authenticated user. Returns the login
 * on success; throws a typed `AppError` (with NO token in the message) on any non-2xx.
 */
export async function validatePat(
  token: string,
  deps: { fetch?: FetchLike } = {},
): Promise<{ login: string }> {
  const doFetch = deps.fetch ?? boundFetch;
  const res = await doFetch(`${GITHUB_API_BASE}/user`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    // Deliberately opaque: never echo the token/PAT back in the error.
    throw new AppError('integration', 'invalid GitHub token');
  }
  const body = (await res.json()) as { login?: unknown };
  if (typeof body.login !== 'string') {
    throw new AppError('integration', 'GitHub user response missing login');
  }
  return { login: body.login };
}

/** Options identifying the GitHub OAuth app + requested scopes for the device flow. */
export interface DeviceFlowOpts {
  clientId: string;
  scopes?: string;
}

/**
 * Injected collaborators for {@link deviceFlowLogin}. `onFrame` receives the progress
 * frames; `sleep` is injectable so tests don't wait on real poll intervals; `signal`
 * lets the caller abort a long-running flow.
 */
export interface DeviceFlowDeps {
  fetch?: FetchLike;
  onFrame: (frame: ConnectStatus) => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Drive the GitHub OAuth device flow to obtain an access token + login.
 *
 * Emits a leading `device_code` frame (user code + verification URI to display), then
 * `pending`/`slow_down` frames as it polls, honoring the server-provided `interval` and
 * `slow_down` back-off. Resolves with `{ token, login }` once GitHub returns an
 * `access_token`; throws a typed `AppError` on expiry, denial, HTTP failure, or abort.
 * The terminal `connected`/`error` frames are emitted by the caller (see file header).
 */
export async function deviceFlowLogin(
  opts: DeviceFlowOpts,
  deps: DeviceFlowDeps,
): Promise<{ token: string; login: string }> {
  const doFetch = deps.fetch ?? boundFetch;
  const sleep = deps.sleep ?? defaultSleep;
  const emit = deps.onFrame;

  throwIfAborted(deps.signal);

  // 1. Request a device + user code.
  const startRes = await doFetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: formHeaders(),
    body: new URLSearchParams({
      client_id: opts.clientId,
      scope: opts.scopes ?? DEFAULT_SCOPES,
    }).toString(),
  });
  if (!startRes.ok) {
    throw new AppError(
      'integration',
      'GitHub device authorization request failed',
    );
  }
  const start = (await startRes.json()) as {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  };
  if (
    typeof start.device_code !== 'string' ||
    typeof start.user_code !== 'string' ||
    typeof start.verification_uri !== 'string'
  ) {
    throw new AppError(
      'integration',
      'malformed GitHub device authorization response',
    );
  }

  const deviceCode = start.device_code;
  const expiresIn =
    typeof start.expires_in === 'number'
      ? start.expires_in
      : DEFAULT_EXPIRES_IN_SECONDS;
  let intervalSeconds =
    typeof start.interval === 'number'
      ? start.interval
      : DEFAULT_POLL_INTERVAL_SECONDS;

  emit({
    kind: 'device_code',
    userCode: start.user_code,
    verificationUri: start.verification_uri,
    expiresIn,
    interval: intervalSeconds,
  });

  const deadline = Date.now() + expiresIn * 1000;

  // 2. Poll the access-token endpoint until success, error, or expiry.
  for (;;) {
    throwIfAborted(deps.signal);
    if (Date.now() >= deadline) {
      throw new AppError('integration', 'GitHub device code expired');
    }
    await sleep(intervalSeconds * 1000);
    throwIfAborted(deps.signal);

    const pollRes = await doFetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: formHeaders(),
      body: new URLSearchParams({
        client_id: opts.clientId,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }).toString(),
    });
    if (!pollRes.ok) {
      throw new AppError('integration', 'GitHub device token poll failed');
    }
    const poll = (await pollRes.json()) as {
      access_token?: unknown;
      error?: unknown;
      interval?: unknown;
    };

    if (typeof poll.access_token === 'string') {
      const token = poll.access_token;
      const { login } = await validatePat(token, { fetch: doFetch });
      return { token, login };
    }

    // `poll.error` is a GitHub OAuth error CODE (non-secret) — safe to surface.
    const error = typeof poll.error === 'string' ? poll.error : 'unknown_error';
    switch (error) {
      case 'authorization_pending':
        emit({ kind: 'pending' });
        continue;
      case 'slow_down':
        intervalSeconds =
          typeof poll.interval === 'number'
            ? poll.interval
            : intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS;
        emit({ kind: 'slow_down' });
        continue;
      case 'expired_token':
        throw new AppError('integration', 'GitHub device code expired');
      case 'access_denied':
        throw new AppError('integration', 'GitHub authorization was denied');
      default:
        throw new AppError('integration', `GitHub device flow error: ${error}`);
    }
  }
}

/** Authorization + Accept headers for a token-authenticated REST call. */
function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
}

/** Headers for the form-encoded device-flow POSTs (JSON responses requested). */
function formHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': USER_AGENT,
  };
}

/** Throw a typed error if the caller has aborted the flow. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('integration', 'GitHub device flow aborted');
  }
}
