// SecretStore — token-at-rest encryption via Electron's `safeStorage` (spec §7).
//
// SECURITY (heightened-scrutiny path — secrets/tokens):
//   * The plaintext token NEVER touches SQLite, logs, or error messages. It lives only
//     as OS-encrypted ciphertext on disk under `<userData>/secrets/<tokenRef>`; the DB
//     holds only the opaque `tokenRef` (a UUIDv7 filename), never the token.
//   * If the OS secure store is unavailable we throw a typed `AppError('integration', …)`
//     rather than writing a weakly/UN-encrypted blob or crashing.
//   * `tokenRef` is confined to a bare filename before it is joined to the secrets dir —
//     a path-traversal guard (reject `/`, `\`, `..`, NUL, absolute paths) so a crafted
//     ref can neither read nor unlink outside the secrets directory.
//
// TESTABILITY: `safeStorage` is injected behind the narrow {@link SafeStorageLike}
// interface (default = Electron's real `safeStorage`) so unit tests supply a fake without
// booting Electron's keychain, and the target directory is injectable (default =
// `paths.secretsDir()`), so tests write into an OS temp dir.

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { safeStorage as electronSafeStorage } from 'electron';
import { v7 as uuidv7 } from 'uuid';

import { AppError } from '@shared/errors';

import { secretsDir } from '../paths';

/**
 * The slice of Electron's `safeStorage` this store depends on. Declared inline (rather
 * than importing the Electron type) so tests can pass a fake and so the shape stays
 * explicit at the injection boundary.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

/** File mode for ciphertext blobs — owner read/write only (no group/other access). */
const SECRET_FILE_MODE = 0o600;

/**
 * Encrypts secrets at rest and hands back an opaque `tokenRef` (the ciphertext filename)
 * that is safe to persist in the DB. Only `get()` ever reconstitutes the plaintext, and
 * it is never logged.
 */
export class SecretStore {
  constructor(
    private readonly safeStorage: SafeStorageLike = electronSafeStorage,
    private readonly dir: string = secretsDir(),
  ) {}

  /**
   * Encrypt `plaintext` and persist it under a fresh `tokenRef`. Returns the `tokenRef`
   * to store in the DB. Throws a typed `AppError` (never crashes) when the OS secure
   * store is unavailable. The plaintext is never logged.
   */
  async put(plaintext: string): Promise<string> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new AppError('integration', 'OS secure storage unavailable');
    }
    // UUIDv7 → an unguessable, time-ordered, filesystem-safe ref.
    const tokenRef = uuidv7();
    const ciphertext = this.safeStorage.encryptString(plaintext);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.resolve(tokenRef), ciphertext, {
      mode: SECRET_FILE_MODE,
    });
    return tokenRef;
  }

  /**
   * Read + decrypt the ciphertext for `tokenRef`, returning the plaintext token. Guards
   * against path traversal and against a missing/unavailable secure store (typed error,
   * never a raw crash).
   */
  async get(tokenRef: string): Promise<string> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new AppError('integration', 'OS secure storage unavailable');
    }
    const ciphertext = await readFile(this.resolve(tokenRef));
    return this.safeStorage.decryptString(ciphertext);
  }

  /**
   * Delete the ciphertext blob for `tokenRef`. Path-traversal guarded; an already-absent
   * blob (ENOENT) is treated as success so disconnect is idempotent.
   */
  async remove(tokenRef: string): Promise<void> {
    try {
      await unlink(this.resolve(tokenRef));
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
    }
  }

  /**
   * Confine `tokenRef` to a bare filename inside the secrets directory. Rejects any ref
   * that could escape it (separators, `..`, NUL, absolute paths) before joining — a
   * crafted ref must not read or unlink outside `this.dir`.
   */
  private resolve(tokenRef: string): string {
    if (
      tokenRef === '' ||
      tokenRef === '.' ||
      tokenRef === '..' ||
      tokenRef.includes('/') ||
      tokenRef.includes('\\') ||
      tokenRef.includes('..') ||
      tokenRef.includes('\0') ||
      isAbsolute(tokenRef)
    ) {
      throw new AppError('invalid_input', 'invalid token reference');
    }
    return join(this.dir, tokenRef);
  }
}

/** Narrow an unknown thrown value to a Node "file not found" error. */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
