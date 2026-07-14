// Renderer IPC funnel (README §10 — "all Electron access funnels through this file").
//
// Feature code / stores / hooks import `invoke`, `onEvent`, `subscribeStream` from HERE
// and NEVER touch `window.api` (or `ipcRenderer`, which does not exist in the renderer)
// directly. That keeps the UI portable and gives one place to add cross-cutting
// concerns (logging, ret/telemetry, test doubles) later.
//
// The preload surfaces errors as the PLAIN `SerializedAppError` shape (it must — a thrown
// Error instance loses its custom fields crossing the contextBridge boundary). THIS file
// is where that plain shape is rethrown as a typed `AppError`, so feature code always
// catches an `AppError` and can branch on `error.code` (README §7.2, §10). Stream framing
// + listener cleanup already happened in the preload.

import type {
  CommandChannel,
  CommandReq,
  CommandRes,
  EventChannel,
  EventPayload,
  StreamArg,
  StreamChannel,
  StreamChunk,
} from '@shared/ipc';
import { AppError, isSerializedAppError } from '@shared/errors';
import type { Unsubscribe } from '../../preload/api';

/**
 * Rethrow a rejected IPC value as a typed `AppError`. The preload rejects with a plain
 * `SerializedAppError` (survives contextBridge); anything else is wrapped as `internal`
 * so callers can rely on always catching an `AppError`.
 */
function reviveError(reason: unknown): AppError {
  if (isSerializedAppError(reason)) {
    return AppError.fromJSON(reason);
  }
  if (reason instanceof AppError) {
    return reason;
  }
  if (reason instanceof Error) {
    return new AppError('internal', reason.message, reason);
  }
  return new AppError('internal', 'IPC call failed', reason);
}

/**
 * Typed request/response call to main. Rejects with a typed `AppError` — callers can
 * branch on `error.code`.
 */
export async function invoke<C extends CommandChannel>(
  channel: C,
  req: CommandReq<C>,
): Promise<CommandRes<C>> {
  try {
    return await window.api.invoke(channel, req);
  } catch (reason) {
    throw reviveError(reason);
  }
}

/**
 * Subscribe to a broadcast event. Returns an unsubscribe function — call it on
 * teardown (e.g. a React effect cleanup) so listeners don't leak.
 */
export function onEvent<K extends EventChannel>(
  event: K,
  cb: (payload: EventPayload<K>) => void,
): Unsubscribe {
  return window.api.on(event, cb);
}

/**
 * Subscribe to a scoped stream. `onChunk` runs per chunk; the returned Promise resolves
 * when the stream ends and rejects (typed `AppError`) on error. Pass `opts.signal` to
 * cancel early (which tears down the main-side producer + listeners).
 */
export function subscribeStream<S extends StreamChannel>(
  channel: S,
  arg: StreamArg<S>,
  onChunk: (chunk: StreamChunk<S>) => void,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const id = globalThis.crypto.randomUUID();
  const signal = opts?.signal;
  let aborted = signal?.aborted ?? false;

  if (aborted) {
    return Promise.reject(new DOMException('stream aborted', 'AbortError'));
  }

  const onAbort = (): void => {
    aborted = true;
    window.api.cancelStream(id);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  return window.api
    .stream(channel, arg, onChunk, { id })
    .catch((reason: unknown) => {
      if (aborted) {
        throw new DOMException('stream aborted', 'AbortError');
      }
      throw reviveError(reason);
    })
    .finally(() => {
      signal?.removeEventListener('abort', onAbort);
    });
}
