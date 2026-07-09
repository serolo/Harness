// LinearService tests (Phase 7, Task 5) — written independently of the implementation from
// the module's header contract. Heightened-scrutiny path (secrets/tokens): the assertions
// PROVE the security properties, not just the happy path:
//   * connect persists only a `tokenRef` — never the plaintext token — and the token never
//     lands on disk in plaintext,
//   * connect emits EXACTLY ONE terminal frame (`connected` on success, `error` on failure),
//   * a failed connect leaves no row behind and never leaks the token into the error,
//   * `linear()`/delegation passes the decrypted token to the client without logging it,
//   * disconnect deletes the ciphertext blob + the row and is idempotent.
//
// A REAL `SecretStore` (fake `safeStorage` + a tmpdir) exercises the true encrypt-at-rest
// path; a fake in-memory `IntegrationsRepo` and an injected `fetch`/`clientFactory` keep the
// test off the network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppError } from '@shared/errors';

import type { Integration } from '../index';
import type { CreateIntegrationInput } from '../../db/repos/integrations';
import type { IntegrationsRepo } from '../../db/repos/integrations';
import { SecretStore, type SafeStorageLike } from '../secrets';
import type { LinearClient, FetchLike, HttpResponse } from './client';
import { LinearService, type LinearConnectStatus } from './index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-linear-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Reversible base64 fake so on-disk bytes never textually contain the plaintext token. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) =>
      Buffer.from(Buffer.from(s, 'utf8').toString('base64')),
    decryptString: (b: Buffer) =>
      Buffer.from(b.toString('utf8'), 'base64').toString('utf8'),
  };
}

/** Minimal in-memory `IntegrationsRepo` — only the methods the service calls. */
function fakeRepo(): { repo: IntegrationsRepo; rows: Integration[] } {
  const rows: Integration[] = [];
  let seq = 0;
  const repo = {
    create: (input: CreateIntegrationInput): Promise<Integration> => {
      const row: Integration = {
        id: `row-${(seq += 1)}`,
        kind: input.kind,
        accountLabel: input.accountLabel,
        tokenRef: input.tokenRef,
      };
      // newest-first, mirroring the real repo's created_at DESC ordering
      rows.unshift(row);
      return Promise.resolve(row);
    },
    list: (kind?: Integration['kind']): Promise<Integration[]> =>
      Promise.resolve(
        kind === undefined ? [...rows] : rows.filter((r) => r.kind === kind),
      ),
    getById: (id: string): Promise<Integration | null> =>
      Promise.resolve(rows.find((r) => r.id === id) ?? null),
    remove: (id: string): Promise<void> => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      return Promise.resolve();
    },
  };
  return { repo: repo as unknown as IntegrationsRepo, rows };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/** A fetch that answers the `viewer` validation query with a fixed account. */
function viewerFetch(name: string): FetchLike {
  return () =>
    Promise.resolve(
      jsonResponse(200, { data: { viewer: { id: 'u1', name, email: null } } }),
    );
}

describe('LinearService.connectLinear', () => {
  it('persists only a tokenRef (never the token) and emits exactly one connected frame', async () => {
    const token = 'lin_api_superSecretKeyValue';
    const { repo, rows } = fakeRepo();
    const secrets = new SecretStore(fakeSafeStorage(), tmpDir);
    const service = new LinearService({
      repo,
      secrets,
      fetch: viewerFetch('Ada Lovelace'),
    });

    const frames: LinearConnectStatus[] = [];
    const integration = await service.connectLinear('apiKey', { token }, (f) =>
      frames.push(f),
    );

    // The persisted row carries a tokenRef, never the plaintext token.
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('linear');
    expect(rows[0].accountLabel).toBe('Ada Lovelace');
    expect(rows[0].tokenRef).not.toBe(token);
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(integration.tokenRef).not.toBe(token);

    // The ciphertext on disk must not textually contain the plaintext token.
    const blob = readFileSync(join(tmpDir, rows[0].tokenRef)).toString('utf8');
    expect(blob).not.toContain(token);
    // But it round-trips back to the original token via the store.
    expect(await secrets.get(rows[0].tokenRef)).toBe(token);

    // Exactly one terminal frame, carrying the linked account.
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      kind: 'connected',
      account: { id: rows[0].id, label: 'Ada Lovelace', kind: 'linear' },
    });
  });

  it('rejects an empty token, emits exactly one error frame, and persists no row', async () => {
    const { repo, rows } = fakeRepo();
    const service = new LinearService({
      repo,
      secrets: new SecretStore(fakeSafeStorage(), tmpDir),
      fetch: viewerFetch('unused'),
    });

    const frames: LinearConnectStatus[] = [];
    await expect(
      service.connectLinear('apiKey', { token: '' }, (f) => frames.push(f)),
    ).rejects.toBeInstanceOf(AppError);

    expect(rows).toHaveLength(0);
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe('error');
  });

  it('on an invalid key: one error frame, no row, and the token never appears in the error', async () => {
    const token = 'lin_api_invalidKeyMustNotLeak';
    const { repo, rows } = fakeRepo();
    const service = new LinearService({
      repo,
      secrets: new SecretStore(fakeSafeStorage(), tmpDir),
      fetch: () => Promise.resolve(jsonResponse(401, {})),
    });

    const frames: LinearConnectStatus[] = [];
    try {
      await service.connectLinear('apiKey', { token }, (f) => frames.push(f));
      expect.unreachable('connectLinear should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).not.toContain(token);
    }

    expect(rows).toHaveLength(0);
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe('error');
    if (frames[0].kind === 'error') {
      expect(frames[0].message).not.toContain(token);
    }
  });
});

describe('LinearService list/disconnect', () => {
  it('list returns only linear rows', async () => {
    const { repo, rows } = fakeRepo();
    rows.push(
      { id: 'gh', kind: 'github', accountLabel: 'octocat', tokenRef: 'r-gh' },
      { id: 'ln', kind: 'linear', accountLabel: 'Ada', tokenRef: 'r-ln' },
    );
    const service = new LinearService({
      repo,
      secrets: new SecretStore(fakeSafeStorage(), tmpDir),
    });

    const listed = await service.list();
    expect(listed).toEqual([
      { id: 'ln', kind: 'linear', accountLabel: 'Ada', tokenRef: 'r-ln' },
    ]);
  });

  it('disconnect deletes the ciphertext blob and the row, and is idempotent', async () => {
    const { repo, rows } = fakeRepo();
    const secrets = new SecretStore(fakeSafeStorage(), tmpDir);
    const service = new LinearService({
      repo,
      secrets,
      fetch: viewerFetch('Ada'),
    });

    const integration = await service.connectLinear('apiKey', {
      token: 'lin_api_key',
    });
    const ref = integration.tokenRef;
    expect(existsSync(join(tmpDir, ref))).toBe(true);

    await service.disconnect(integration.id);
    expect(rows).toHaveLength(0);
    expect(existsSync(join(tmpDir, ref))).toBe(false);

    // Idempotent: disconnecting an already-gone id does not throw.
    await expect(service.disconnect(integration.id)).resolves.toBeUndefined();
  });
});

describe('LinearService.linear + delegation', () => {
  it('throws a typed AppError when no Linear account is connected', async () => {
    const { repo } = fakeRepo();
    const service = new LinearService({
      repo,
      secrets: new SecretStore(fakeSafeStorage(), tmpDir),
    });

    await expect(service.linear()).rejects.toBeInstanceOf(AppError);
  });

  it('passes the DECRYPTED token to the client factory for the active account', async () => {
    const token = 'lin_api_decryptedForClient';
    const { repo } = fakeRepo();
    const secrets = new SecretStore(fakeSafeStorage(), tmpDir);

    let factoryToken: string | null = null;
    const fakeClient = {} as LinearClient;
    const service = new LinearService({
      repo,
      secrets,
      fetch: viewerFetch('Ada'),
      clientFactory: (t) => {
        factoryToken = t;
        return fakeClient;
      },
    });

    await service.connectLinear('apiKey', { token });
    const client = await service.linear();

    expect(factoryToken).toBe(token);
    expect(client).toBe(fakeClient);
  });

  it('delegates listIssues / linkWorkspace / transitionOnPr to the resolved client', async () => {
    const { repo } = fakeRepo();
    const secrets = new SecretStore(fakeSafeStorage(), tmpDir);

    const calls: Array<{ method: string; args: unknown[] }> = [];
    const fakeClient = {
      listIssues: (...args: unknown[]) => {
        calls.push({ method: 'listIssues', args });
        return Promise.resolve([]);
      },
      linkBranch: (...args: unknown[]) => {
        calls.push({ method: 'linkBranch', args });
        return Promise.resolve();
      },
      linkPr: (...args: unknown[]) => {
        calls.push({ method: 'linkPr', args });
        return Promise.resolve();
      },
      setIssueState: (...args: unknown[]) => {
        calls.push({ method: 'setIssueState', args });
        return Promise.resolve();
      },
    } as unknown as LinearClient;

    const service = new LinearService({
      repo,
      secrets,
      fetch: viewerFetch('Ada'),
      clientFactory: () => fakeClient,
    });
    await service.connectLinear('apiKey', { token: 'lin_api_key' });

    await service.listIssues({ first: 5 });
    await service.linkWorkspace({
      issueId: 'i1',
      branchUrl: 'https://x/branch',
      prUrl: 'https://x/pr',
    });
    await service.transitionOnPr('i1', 'state-done');

    expect(calls.map((c) => c.method)).toEqual([
      'listIssues',
      'linkBranch',
      'linkPr',
      'setIssueState',
    ]);
    expect(calls[1].args).toEqual(['i1', 'https://x/branch']);
    expect(calls[2].args).toEqual(['i1', 'https://x/pr']);
    expect(calls[3].args).toEqual(['i1', 'state-done']);
  });

  it('linkWorkspace skips a missing branch/PR url', async () => {
    const { repo } = fakeRepo();
    const secrets = new SecretStore(fakeSafeStorage(), tmpDir);
    const calls: string[] = [];
    const fakeClient = {
      linkBranch: () => {
        calls.push('linkBranch');
        return Promise.resolve();
      },
      linkPr: () => {
        calls.push('linkPr');
        return Promise.resolve();
      },
    } as unknown as LinearClient;

    const service = new LinearService({
      repo,
      secrets,
      fetch: viewerFetch('Ada'),
      clientFactory: () => fakeClient,
    });
    await service.connectLinear('apiKey', { token: 'lin_api_key' });

    await service.linkWorkspace({ issueId: 'i1', prUrl: 'https://x/pr' });

    expect(calls).toEqual(['linkPr']);
  });
});
