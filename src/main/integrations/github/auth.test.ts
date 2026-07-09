// GitHub auth — PAT validation + OAuth device-flow login (heightened-scrutiny path:
// secrets/tokens). Tests are written INDEPENDENTLY of the implementation from the
// module's stated contract (see file header of `./auth.ts`):
//   * validatePat succeeds/fails correctly and NEVER leaks the token into a thrown
//     error message,
//   * deviceFlowLogin emits the documented progress frames (`device_code`, `pending`,
//     `slow_down`), honors the server-provided/incremented poll interval via the
//     injected `sleep`, and resolves `{ token, login }` on success,
//   * expiry/denial/error terminal states reject with a typed AppError.
//
// A fake `fetch` (FetchLike) is injected so no test touches the network, and `sleep`
// is a spy that resolves immediately so polling never actually waits.

import { describe, it, expect, vi } from 'vitest';

import { AppError } from '@shared/errors';
import type { ConnectStatus } from '@shared/github';

import {
  validatePat,
  deviceFlowLogin,
  type FetchLike,
  type HttpResponse,
} from './auth';

/** Build a fake HttpResponse. */
function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe('validatePat', () => {
  it('resolves { login } on a 200 response and sends an Authorization header with the token', async () => {
    const token = 'ghp_validTokenAbc123';
    const seenHeaders: Record<string, string>[] = [];
    const fetch: FetchLike = (_url, init) => {
      seenHeaders.push(init?.headers ?? {});
      return Promise.resolve(jsonResponse(200, { login: 'octocat' }));
    };

    const result = await validatePat(token, { fetch });

    expect(result).toEqual({ login: 'octocat' });
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0].Authorization).toBe(`Bearer ${token}`);
  });

  it('rejects a bad token with a typed AppError that does NOT contain the token', async () => {
    const token = 'ghp_badTokenShouldNeverLeak';
    const fetch: FetchLike = () => Promise.resolve(jsonResponse(401, {}));

    await expect(validatePat(token, { fetch })).rejects.toBeInstanceOf(
      AppError,
    );

    try {
      await validatePat(token, { fetch });
      expect.unreachable('validatePat should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('integration');
      expect(appErr.message).not.toContain(token);
      expect(JSON.stringify(appErr)).not.toContain(token);
    }
  });

  it('rejects with a typed error when the 200 body is missing login', async () => {
    const fetch: FetchLike = () => Promise.resolve(jsonResponse(200, {}));

    await expect(validatePat('ghp_x', { fetch })).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe('deviceFlowLogin — happy path', () => {
  it('emits device_code then pending, honors the interval via sleep, and resolves { token, login }', async () => {
    let pollCount = 0;
    const fetch: FetchLike = (url, init) => {
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          jsonResponse(200, {
            device_code: 'devcode123',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
        );
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        pollCount += 1;
        if (pollCount === 1) {
          return Promise.resolve(
            jsonResponse(200, { error: 'authorization_pending' }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, { access_token: 'ghp_finalToken' }),
        );
      }
      if (url === 'https://api.github.com/user') {
        // validatePat is called internally once the token is obtained.
        expect(init?.headers?.Authorization).toBe('Bearer ghp_finalToken');
        return Promise.resolve(jsonResponse(200, { login: 'octocat' }));
      }
      throw new Error(`unexpected url ${url}`);
    };

    const frames: ConnectStatus[] = [];
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    const result = await deviceFlowLogin(
      { clientId: 'client-123' },
      { fetch, onFrame: (f) => frames.push(f), sleep },
    );

    expect(result).toEqual({ token: 'ghp_finalToken', login: 'octocat' });

    expect(frames[0]).toMatchObject({
      kind: 'device_code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
    });
    expect(frames.some((f) => f.kind === 'pending')).toBe(true);

    // Polling used the injected sleep (so the test never actually waited),
    // honoring the server's 5-second interval.
    expect(sleep).toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(5000);
  });
});

describe('deviceFlowLogin — slow_down', () => {
  it('emits a slow_down frame and increases the poll interval before succeeding', async () => {
    let pollCount = 0;
    const fetch: FetchLike = (url) => {
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          jsonResponse(200, {
            device_code: 'devcode',
            user_code: 'WXYZ-5678',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
        );
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        pollCount += 1;
        if (pollCount === 1) {
          return Promise.resolve(
            jsonResponse(200, { error: 'slow_down', interval: 10 }),
          );
        }
        return Promise.resolve(jsonResponse(200, { access_token: 'ghp_tok2' }));
      }
      if (url === 'https://api.github.com/user') {
        return Promise.resolve(jsonResponse(200, { login: 'octobuddy' }));
      }
      throw new Error(`unexpected url ${url}`);
    };

    const frames: ConnectStatus[] = [];
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    const result = await deviceFlowLogin(
      { clientId: 'client-123' },
      { fetch, onFrame: (f) => frames.push(f), sleep },
    );

    expect(result).toEqual({ token: 'ghp_tok2', login: 'octobuddy' });
    expect(frames.some((f) => f.kind === 'slow_down')).toBe(true);

    // First sleep uses the initial 5s interval; the poll AFTER slow_down must
    // use the larger, server-provided 10s interval — proving the back-off took
    // effect before the next request went out.
    const sleptMs = sleep.mock.calls.map((c) => c[0]);
    expect(sleptMs[0]).toBe(5000);
    expect(sleptMs[sleptMs.length - 1]).toBe(10000);
  });
});

describe('deviceFlowLogin — terminal failures', () => {
  function startDeviceCodeFetch(pollBody: unknown): FetchLike {
    return (url) => {
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          jsonResponse(200, {
            device_code: 'devcode',
            user_code: 'CODE-0000',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 1,
          }),
        );
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        return Promise.resolve(jsonResponse(200, pollBody));
      }
      throw new Error(`unexpected url ${url}`);
    };
  }

  it('expired_token rejects with a typed AppError', async () => {
    const fetch = startDeviceCodeFetch({ error: 'expired_token' });
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const frames: ConnectStatus[] = [];

    await expect(
      deviceFlowLogin(
        { clientId: 'client-123' },
        { fetch, onFrame: (f) => frames.push(f), sleep },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('access_denied rejects with a typed AppError', async () => {
    const fetch = startDeviceCodeFetch({ error: 'access_denied' });
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    await expect(
      deviceFlowLogin(
        { clientId: 'client-123' },
        { fetch, onFrame: () => {}, sleep },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('an unrecognized error code still rejects with a typed AppError (fail closed)', async () => {
    const fetch = startDeviceCodeFetch({ error: 'some_unknown_future_code' });
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    await expect(
      deviceFlowLogin(
        { clientId: 'client-123' },
        { fetch, onFrame: () => {}, sleep },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
