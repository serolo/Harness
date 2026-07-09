// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
// The single AppError shape used across the whole app. See README §7.2.

/**
 * The closed set of error codes. Every AppError carries exactly one of these.
 * Order/values are frozen — later phases may only append (README §5.2).
 */
export type AppErrorCode =
  | 'io'
  | 'db'
  | 'git'
  | 'harness'
  | 'integration'
  | 'settings'
  | 'not_found'
  | 'conflict'
  | 'invalid_input'
  | 'internal';

/**
 * Plain-object form of an AppError — the shape that actually crosses the process
 * boundaries. An `Error` instance loses its custom fields at BOTH boundaries an IPC
 * error traverses: `ipcMain.handle` rejections carry only the message string, and the
 * `contextBridge` preload→renderer hop strips custom props off `Error`s (a plain object,
 * by contrast, is cloned intact). So errors are always transported AS this plain shape
 * and revived with `fromJSON` in the renderer funnel — never via the class or `instanceof`.
 * See `encodeAppErrorMessage`/`decodeAppErrorMessage` (command path) and the stream frames.
 */
export interface SerializedAppError {
  /** Discriminator so the renderer can detect a serialized AppError by shape. */
  readonly __appError: true;
  readonly code: AppErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * Typed application error. Extends Error for good stack traces in the process
 * that throws it, but MUST NOT be relied on via `instanceof` across the IPC
 * boundary — use {@link AppError.fromJSON} / {@link isSerializedAppError} there.
 *
 * NOTE: a `structuredClone` of an AppError *instance* still drops `code`/`details`
 * (the platform Error clone keeps only message/name/stack/cause). What crosses the
 * IPC boundary is therefore the {@link SerializedAppError} produced by
 * {@link AppError.toJSON} — never the instance. The enumerable own properties
 * below are for `JSON.stringify` fidelity and log output, not clone survival.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;

    // `Error` sets `message` as a non-enumerable own property; we redefine these
    // fields as enumerable so `JSON.stringify(err)` and log serializers include
    // them. (This does NOT make them survive a structured clone of the instance —
    // that path is handled by toJSON(); see the class doc comment.)
    Object.defineProperty(this, 'code', {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(this, 'message', {
      value: message,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(this, 'details', {
      value: details,
      enumerable: true,
      writable: false,
      configurable: false,
    });

    // Restore prototype chain for environments that break it on Error subclassing.
    Object.setPrototypeOf(this, AppError.prototype);
  }

  /** Serialize to the plain shape that survives the IPC structured-clone boundary. */
  toJSON(): SerializedAppError {
    return {
      __appError: true,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }

  /** Reconstruct a typed AppError from its serialized shape (renderer side). */
  static fromJSON(obj: SerializedAppError): AppError {
    return new AppError(obj.code, obj.message, obj.details);
  }
}

/**
 * Structural guard for a serialized AppError. Safe to use across the IPC
 * boundary where `instanceof AppError` is unreliable.
 */
export function isSerializedAppError(
  value: unknown,
): value is SerializedAppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __appError?: unknown }).__appError === true &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/**
 * Sentinel used to smuggle a {@link SerializedAppError} across the `ipcMain.handle`
 * rejection boundary.
 *
 * IMPORTANT (empirically verified): Electron does NOT structured-clone a value thrown
 * from an `ipcMain.handle` handler. The renderer's `invoke` rejection is a fresh generic
 * `Error` whose message is `Error invoking remote method '<channel>': <message>` — ALL
 * custom fields (and a thrown plain object) are lost; only the message string survives.
 * So the command (invoke) path cannot rely on throwing `toJSON()` directly. Instead the
 * main side encodes the serialized shape INTO the thrown Error's message with this
 * sentinel, and the preload decodes it back to a typed `AppError`.
 *
 * The STREAM path is different and unaffected: stream frames travel via
 * `webContents.send`, which DOES structured-clone the payload intact, so streams keep
 * sending the plain `SerializedAppError` object (detected via {@link isSerializedAppError}).
 */
export const APP_ERROR_MESSAGE_SENTINEL = '@@AppError@@';

/** Encode a serialized AppError into a string safe to carry as an Error message. */
export function encodeAppErrorMessage(err: SerializedAppError): string {
  return APP_ERROR_MESSAGE_SENTINEL + JSON.stringify(err);
}

/**
 * Extract a {@link SerializedAppError} from an Error message produced by
 * {@link encodeAppErrorMessage}, tolerating Electron's `Error invoking remote method …`
 * prefix. Returns `null` if the message carries no encoded AppError.
 */
export function decodeAppErrorMessage(
  message: string,
): SerializedAppError | null {
  const at = message.indexOf(APP_ERROR_MESSAGE_SENTINEL);
  if (at < 0) return null;
  const json = message.slice(at + APP_ERROR_MESSAGE_SENTINEL.length);
  try {
    const parsed: unknown = JSON.parse(json);
    return isSerializedAppError(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
