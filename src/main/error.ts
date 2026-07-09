// Main-process error boundary helpers. Everything error-related in main imports the
// AppError shape from HERE so there is a single import site (the underlying frozen
// definition lives in src/shared/errors.ts and is re-exported below).
//
// NOTE: the IPC boundary wrapper that catches handler throws and rejects with the
// serialized shape lives in `src/main/ipc/register.ts` (Task 6). It uses `toAppError`
// from this module to normalize any thrown value before serializing via `.toJSON()`.

import { AppError } from '@shared/errors';

// Re-export the frozen error contract so main-process code imports error types from
// one place rather than reaching into src/shared directly.
export { AppError, isSerializedAppError } from '@shared/errors';
export type { AppErrorCode, SerializedAppError } from '@shared/errors';

/**
 * Normalize any thrown/rejected value into a typed {@link AppError}.
 *
 * - An existing `AppError` is returned unchanged (preserving its code/details).
 * - A native `Error` keeps its `message`; the original is stashed in `details` so the
 *   stack/cause survives in logs. Defaults to code `"internal"`.
 * - Any other value (string, object, etc.) is stringified into the message and stashed
 *   in `details`.
 *
 * The default code is `"internal"`: callers that can classify the failure more
 * precisely should throw a typed `AppError` themselves rather than rely on this.
 */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) {
    return e;
  }
  if (e instanceof Error) {
    // Preserve the native message; keep the original Error in details for logging.
    return new AppError('internal', e.message, e);
  }
  if (typeof e === 'string') {
    return new AppError('internal', e);
  }
  // Unknown non-Error value: give a stable message, keep the raw value for inspection.
  return new AppError('internal', 'Unknown error', e);
}
