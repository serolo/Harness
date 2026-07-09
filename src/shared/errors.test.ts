// AppError serialization contract (Task 10 / phase doc §7).
//
// The load-bearing behavior: an AppError thrown in the main process must survive the
// Electron IPC boundary, which structured-clones rejection values. A structured clone
// of an Error subclass DROPS the prototype and any non-enumerable custom fields, so the
// renderer cannot rely on `instanceof AppError`. Instead the boundary serializes to a
// plain `SerializedAppError` shape and revives it with `fromJSON`. These tests exercise
// exactly that round trip using the real `structuredClone` (same algorithm Electron uses).

import { describe, it, expect } from 'vitest';
import {
  AppError,
  decodeAppErrorMessage,
  encodeAppErrorMessage,
  isSerializedAppError,
  type AppErrorCode,
  type SerializedAppError,
} from '@shared/errors';

describe('AppError.toJSON()', () => {
  it('produces a plain object with __appError, code, message, details', () => {
    const err = new AppError('db', 'query failed', { table: 'projects' });
    const json = err.toJSON();

    expect(json).toEqual({
      __appError: true,
      code: 'db',
      message: 'query failed',
      details: { table: 'projects' },
    });
  });

  it('omits details as undefined when not supplied', () => {
    const json = new AppError('internal', 'boom').toJSON();
    expect(json.details).toBeUndefined();
    expect(json.__appError).toBe(true);
  });

  it('is picked up by JSON.stringify (toJSON hook) with the marker + code', () => {
    const err = new AppError('not_found', 'missing');
    const parsed = JSON.parse(JSON.stringify(err)) as SerializedAppError;
    expect(parsed.__appError).toBe(true);
    expect(parsed.code).toBe('not_found');
    expect(parsed.message).toBe('missing');
  });
});

describe('AppError structured-clone round trip (the IPC boundary)', () => {
  // REGRESSION GUARD + CONTRACT NOTE: structuredClone of the RAW AppError instance is
  // NOT a safe transport. `structuredClone` serializes an Error subclass via the
  // platform Error path, which preserves only message/name/stack/cause and DROPS custom
  // own properties (`code`, `details`) — even though the constructor declares them
  // enumerable. This is exactly WHY neither the STREAM path (which sends `toJSON()` as a
  // cloned payload) nor the COMMAND path (which encodes `toJSON()` into the Error message)
  // ever clones the instance. This test pins the true behavior so a future change can't
  // quietly start relying on the instance clone.
  it('DROPS code/details when the raw instance is structured-cloned (message survives)', () => {
    const err = new AppError('conflict', 'name taken', { name: 'paris' });
    const cloned = structuredClone(err) as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };

    // Only the Error-native fields survive; custom fields are lost.
    expect(cloned.message).toBe('name taken');
    expect(cloned.code).toBeUndefined();
    expect(cloned.details).toBeUndefined();
  });

  it('does NOT survive as an AppError instance across the clone (must not rely on instanceof)', () => {
    const err = new AppError('git', 'merge failed');
    const cloned = structuredClone(err);
    // This is the whole reason the serialized shape exists: the prototype is lost.
    expect(cloned instanceof AppError).toBe(false);
  });

  it('round-trips toJSON → structuredClone → fromJSON back to a typed AppError', () => {
    const original = new AppError('invalid_input', 'bad port', { port: -1 });

    // main side: serialize; boundary: structured clone; renderer side: revive.
    const wire = structuredClone(original.toJSON());
    expect(isSerializedAppError(wire)).toBe(true);

    const revived = AppError.fromJSON(wire);
    expect(revived).toBeInstanceOf(AppError);
    expect(revived.code).toBe('invalid_input');
    expect(revived.message).toBe('bad port');
    expect(revived.details).toEqual({ port: -1 });
    // A revived AppError is a real Error too (throwable, has a stack).
    expect(revived).toBeInstanceOf(Error);
  });

  it('preserves the code as the correct AppErrorCode literal for every code', () => {
    const codes: AppErrorCode[] = [
      'io',
      'db',
      'git',
      'harness',
      'integration',
      'settings',
      'not_found',
      'conflict',
      'invalid_input',
      'internal',
    ];
    for (const code of codes) {
      const revived = AppError.fromJSON(
        structuredClone(new AppError(code, 'x').toJSON()),
      );
      expect(revived.code).toBe(code);
    }
  });
});

describe('AppError message codec (the COMMAND / ipcMain.handle boundary)', () => {
  // CONTRACT: Electron does NOT clone a value thrown from `ipcMain.handle`; the renderer
  // receives a generic Error whose message is `Error invoking remote method '<ch>': <msg>`
  // and a thrown plain object degrades to `[object Object]`. So the command path encodes
  // the serialized AppError INTO the message and decodes it back. These tests simulate
  // that message-only transport (the real cross-process assertion lives in e2e/ipc.spec.ts).
  it('round-trips code + details through the encoded message', () => {
    const wire = new AppError('conflict', 'name taken', {
      name: 'paris',
    }).toJSON();
    const decoded = decodeAppErrorMessage(encodeAppErrorMessage(wire));
    expect(decoded).not.toBeNull();
    const revived = AppError.fromJSON(decoded as SerializedAppError);
    expect(revived.code).toBe('conflict');
    expect(revived.details).toEqual({ name: 'paris' });
  });

  it("survives Electron's `Error invoking remote method` message prefix", () => {
    const encoded = encodeAppErrorMessage(
      new AppError('db', 'query failed', { table: 'workspaces' }).toJSON(),
    );
    // Electron prepends this to the thrown Error's message before it reaches the renderer.
    const asRenderer = `Error invoking remote method 'workspace:create': Error: ${encoded}`;
    const decoded = decodeAppErrorMessage(asRenderer);
    expect(decoded?.code).toBe('db');
    expect(decoded?.message).toBe('query failed');
    expect(decoded?.details).toEqual({ table: 'workspaces' });
  });

  it('returns null for a message that carries no encoded AppError', () => {
    expect(decodeAppErrorMessage('some unrelated error')).toBeNull();
    expect(decodeAppErrorMessage('')).toBeNull();
  });
});

describe('isSerializedAppError()', () => {
  it('accepts a well-formed serialized AppError', () => {
    const ok: SerializedAppError = {
      __appError: true,
      code: 'io',
      message: 'x',
    };
    expect(isSerializedAppError(ok)).toBe(true);
  });

  it('rejects a plain Error, a plain object, and non-objects', () => {
    expect(isSerializedAppError(new Error('nope'))).toBe(false);
    expect(isSerializedAppError({ code: 'db', message: 'x' })).toBe(false); // missing marker
    expect(isSerializedAppError({ __appError: true, message: 'x' })).toBe(
      false,
    ); // no code
    expect(isSerializedAppError({ __appError: true, code: 'db' })).toBe(false); // no message
    expect(isSerializedAppError(null)).toBe(false);
    expect(isSerializedAppError(undefined)).toBe(false);
    expect(isSerializedAppError('db')).toBe(false);
  });

  it('rejects an object whose marker is not exactly true', () => {
    expect(
      isSerializedAppError({ __appError: 1, code: 'db', message: 'x' }),
    ).toBe(false);
  });
});
