// Linear auth — API-key validation (heightened-scrutiny path: secrets/tokens). Tests are
// written independently of the implementation from the module's stated contract (see the
// header of `./auth.ts`):
//   * validateApiKey resolves the account label on a valid key,
//   * it NEVER leaks the key into a thrown error message,
//   * an invalid key rejects with a typed AppError.
//
// A fake `fetch` (FetchLike) is injected so no test touches the network.

import { describe, it, expect } from 'vitest';

import { AppError } from '@shared/errors';

import { validateApiKey } from './auth';
import type { FetchLike, HttpResponse } from './client';

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe('validateApiKey', () => {
  it('resolves { label } from the viewer name and sends the key as the Authorization header', async () => {
    const key = 'lin_api_validKey123';
    const seen: Array<Record<string, string> | undefined> = [];
    const fetch: FetchLike = (_url, init) => {
      seen.push(init?.headers);
      return Promise.resolve(
        jsonResponse(200, {
          data: { viewer: { id: 'u1', name: 'Grace Hopper', email: null } },
        }),
      );
    };

    const result = await validateApiKey(key, { fetch });

    expect(result).toEqual({ label: 'Grace Hopper' });
    // Personal API keys are sent raw (no Bearer prefix).
    expect(seen[0]?.Authorization).toBe(key);
  });

  it('rejects an invalid key with a typed AppError that does NOT contain the key', async () => {
    const key = 'lin_api_badKeyMustNeverLeak';
    const fetch: FetchLike = () => Promise.resolve(jsonResponse(401, {}));

    try {
      await validateApiKey(key, { fetch });
      expect.unreachable('validateApiKey should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('integration');
      expect(appErr.message).not.toContain(key);
      expect(JSON.stringify(appErr)).not.toContain(key);
    }
  });

  it('rejects when the viewer is missing from an otherwise-OK response', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(jsonResponse(200, { data: { viewer: null } }));

    await expect(validateApiKey('lin_api_x', { fetch })).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
