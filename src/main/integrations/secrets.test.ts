// SecretStore — token-at-rest encryption (heightened-scrutiny path: secrets/tokens).
//
// These tests are written INDEPENDENTLY of the implementation, from the security
// properties the module claims (see file header of `./secrets.ts`):
//   1. round-trip through put()/get() returns the exact plaintext,
//   2. the on-disk blob is never the plaintext (real ciphertext, 0600 mode),
//   3. the tokenRef is an opaque id, not the token itself,
//   4. an unavailable OS secure store fails CLOSED (typed AppError, no file written),
//   5. tokenRef path traversal is rejected before any fs access,
//   6. remove() is idempotent and actually deletes the ciphertext.
//
// A fake `SafeStorageLike` is injected so this never depends on the real OS keychain,
// and `dir` is pointed at an os.tmpdir() directory so nothing touches the real
// userData secrets directory.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppError } from '@shared/errors';

import { SecretStore, type SafeStorageLike } from './secrets';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-secrets-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A deterministic fake — never touches the real OS keychain. Uses a reversible
 * transform (base64, not a plain prefix) so the on-disk bytes do NOT textually
 * contain the plaintext — otherwise the "ciphertext at rest" test below would
 * pass even if the real implementation forgot to encrypt at all.
 */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) =>
      Buffer.from(Buffer.from(s, 'utf8').toString('base64')),
    decryptString: (b: Buffer) =>
      Buffer.from(b.toString('utf8'), 'base64').toString('utf8'),
  };
}

describe('SecretStore — round-trip', () => {
  it('put() then get() returns the exact same plaintext', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);
    const secret = 'ghp_superSecretToken1234567890';

    const tokenRef = await store.put(secret);
    const recovered = await store.get(tokenRef);

    expect(recovered).toBe(secret);
  });

  it('two puts of the same secret produce different, independent tokenRefs', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);
    const secret = 'same-secret-value';

    const ref1 = await store.put(secret);
    const ref2 = await store.put(secret);

    expect(ref1).not.toBe(ref2);
    expect(await store.get(ref1)).toBe(secret);
    expect(await store.get(ref2)).toBe(secret);
  });
});

describe('SecretStore — ciphertext at rest', () => {
  it('the on-disk blob does NOT contain the plaintext token', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);
    const secret = 'ghp_thisMustNeverAppearOnDisk';

    const tokenRef = await store.put(secret);

    const raw = readFileSync(join(tmpDir, tokenRef));
    expect(raw.toString('utf8')).not.toContain(secret);
  });

  it('writes the ciphertext file with mode 0600 (owner read/write only)', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);
    const tokenRef = await store.put('some-token');

    const mode = statSync(join(tmpDir, tokenRef)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('the tokenRef itself is an opaque id, not the token', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);
    const secret = 'ghp_myActualToken';

    const tokenRef = await store.put(secret);

    expect(tokenRef).not.toBe(secret);
    expect(tokenRef).not.toContain(secret);
  });
});

describe('SecretStore — safeStorage unavailable (fail closed)', () => {
  it('put() rejects with a typed AppError("integration") and writes no file', async () => {
    const store = new SecretStore(fakeSafeStorage(false), tmpDir);

    await expect(store.put('secret')).rejects.toMatchObject({
      code: 'integration',
    });
    await expect(store.put('secret')).rejects.toBeInstanceOf(AppError);

    // Nothing should have been written to disk (dir may not even exist yet).
    const entries = existsSync(tmpDir) ? readdirSync(tmpDir) : [];
    expect(entries).toEqual([]);
  });

  it('the AppError message does not leak the plaintext secret', async () => {
    const store = new SecretStore(fakeSafeStorage(false), tmpDir);
    const secret = 'ghp_shouldNotAppearInError';

    try {
      await store.put(secret);
      expect.unreachable('put() should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).not.toContain(secret);
    }
  });
});

describe('SecretStore — path traversal guard', () => {
  it('get() rejects a relative traversal ref before touching the fs', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);

    await expect(store.get('../etc/passwd')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    // The traversal target must not exist / not have been read into existence.
    expect(existsSync(join(tmpDir, '..', 'etc', 'passwd'))).toBe(false);
  });

  it('get() rejects an absolute path ref', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);

    await expect(store.get('/etc/passwd')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('remove() rejects a traversal ref rather than unlinking outside dir', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);

    await expect(store.remove('../../evil')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('rejects refs containing embedded separators, "..", or NUL', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);

    await expect(store.get('foo/../bar')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(store.get('foo\\bar')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(store.get('foo\0bar')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('SecretStore — remove()', () => {
  it('deletes the ciphertext; a subsequent get() fails', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);
    const tokenRef = await store.put('to-be-removed');

    expect(existsSync(join(tmpDir, tokenRef))).toBe(true);
    await store.remove(tokenRef);
    expect(existsSync(join(tmpDir, tokenRef))).toBe(false);

    await expect(store.get(tokenRef)).rejects.toBeTruthy();
  });

  it('removing an already-missing ref does not throw (idempotent disconnect)', async () => {
    const store = new SecretStore(fakeSafeStorage(), tmpDir);
    // A well-formed but never-written tokenRef (valid bare filename).
    await expect(
      store.remove('01234567-89ab-7cde-8000-000000000000'),
    ).resolves.toBeUndefined();
  });
});
