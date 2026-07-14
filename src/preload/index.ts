// Preload bridge (README §7.6 — renderer hardening is NON-NEGOTIABLE).
//
// This is the ONLY surface the renderer can reach the main process through. It exposes
// a single frozen `window.api` object via `contextBridge`. It exposes NO `ipcRenderer`,
// NO `require`, NO `process`, NO Node globals — the renderer cannot touch Electron
// except through the typed methods below.
//
// Runs under `sandbox: true`: the preload has a limited context (`contextBridge` +
// `ipcRenderer` are available; arbitrary `require` is not). So this file stays
// dependency-free at runtime — it imports only the pure, dependency-free type/value
// contracts from `@shared/*` (which the bundler inlines), never a Node/native module.

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { Api, StreamFrameWire, Unsubscribe } from './api';
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
import {
  decodeAppErrorMessage,
  isSerializedAppError,
  type SerializedAppError,
} from '@shared/errors';

const STREAM_START_CHANNEL = 'stream:start';
const STREAM_CANCEL_CHANNEL = 'stream:cancel';

/** Build the per-subscription data channel name (must match main's `streamChannel`). */
function streamChannel(id: string): string {
  return `stream:${id}`;
}

/**
 * Normalize a rejected IPC call to the PLAIN `SerializedAppError` shape.
 *
 * Why plain (not an `AppError` instance): the preload runs in a separate isolated world,
 * and `contextBridge` STRIPS custom properties off any thrown `Error` before it reaches
 * the renderer (only `message`/`stack` survive) — but it deep-clones a plain object
 * intact. So the preload must surface a plain object; the renderer funnel
 * (`src/renderer/ipc`) revives it into a typed `AppError` (README §7.2, §10).
 *
 * Two upstream transports feed this:
 *  - COMMAND (`invoke`) rejections: Electron carries only the Error *message* across a
 *    `handle()` rejection, so main encodes the serialized shape into it — decode it back.
 *  - STREAM error frames: `webContents.send` clones the payload intact, so it already
 *    arrives as a `SerializedAppError` (detected by shape).
 */
function toWireError(reason: unknown): SerializedAppError {
  if (reason instanceof Error) {
    const decoded = decodeAppErrorMessage(reason.message);
    if (decoded) {
      return decoded;
    }
    return { __appError: true, code: 'internal', message: reason.message };
  }
  if (isSerializedAppError(reason)) {
    return reason;
  }
  return { __appError: true, code: 'internal', message: 'IPC call failed' };
}

/** A plain serialized AppError built in the preload (e.g. for local stream aborts). */
function wireError(message: string): SerializedAppError {
  return { __appError: true, code: 'internal', message };
}

/**
 * `invoke` — typed request/response. Rejects with the PLAIN `SerializedAppError` shape
 * (survives the contextBridge boundary); the renderer funnel rethrows it as a typed
 * `AppError` so callers get `error.code` etc.
 */
async function invoke<C extends CommandChannel>(
  channel: C,
  req: CommandReq<C>,
): Promise<CommandRes<C>> {
  try {
    return (await ipcRenderer.invoke(channel, req)) as CommandRes<C>;
  } catch (reason) {
    throw toWireError(reason);
  }
}

/**
 * `on` — subscribe to a broadcast event. Returns an unsubscribe function. The raw
 * `IpcRendererEvent` is stripped before the callback so the renderer never receives an
 * object carrying `sender`/port handles (defense in depth).
 */
function on<K extends EventChannel>(
  event: K,
  cb: (payload: EventPayload<K>) => void,
): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: EventPayload<K>): void => {
    cb(payload);
  };
  ipcRenderer.on(event, listener);
  return () => {
    ipcRenderer.removeListener(event, listener);
  };
}

const activeStreamCancels = new Map<string, () => void>();

/**
 * `stream` — the renderer side of `createStream()`. Starts a scoped stream, delivers
 * each chunk to `onChunk`, resolves the returned Promise on `end`, and rejects it
 * (typed AppError) on `error`. Cleans up its `stream:<id>` listener on ANY terminal
 * path. Cancellation is requested separately through `cancelStream(id)` so only plain,
 * serializable values cross contextBridge — no listener leaks across turns.
 *
 * @returns a Promise that settles when the stream ends.
 */
function stream<S extends StreamChannel>(
  channel: S,
  arg: StreamArg<S>,
  onChunk: (chunk: StreamChunk<S>) => void,
  opts: { id: string },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { id } = opts;
    let settled = false;
    let aborted = false;
    const dataChannel = streamChannel(id);

    const cleanup = (): void => {
      ipcRenderer.removeListener(dataChannel, frameListener);
      activeStreamCancels.delete(id);
    };

    const frameListener = (
      _e: IpcRendererEvent,
      frame: StreamFrameWire<StreamChunk<S>>,
    ): void => {
      if (settled) {
        return;
      }
      switch (frame.t) {
        case 'chunk':
          onChunk(frame.chunk);
          break;
        case 'end':
          settled = true;
          cleanup();
          resolve();
          break;
        case 'error':
          settled = true;
          cleanup();
          // frame.error is already a plain SerializedAppError (cloned via send).
          reject(frame.error);
          break;
      }
    };

    // Subscribe before asking main to start. Fast producers (notably a workspace using
    // the current checkout) may emit `chunk` + `end` before invoke() resolves.
    ipcRenderer.on(dataChannel, frameListener);

    activeStreamCancels.set(id, () => {
      if (settled) return;
      aborted = true;
      settled = true;
      cleanup();
      ipcRenderer.send(STREAM_CANCEL_CHANNEL, id);
      reject(wireError('stream aborted'));
    });

    ipcRenderer
      .invoke(STREAM_START_CHANNEL, { channel, arg, id })
      .then((res: { id: string }) => {
        if (settled) {
          // An abort can happen before main has registered the id, so repeat the
          // cancellation after startup resolves. A normal fast end needs no cancel.
          if (aborted) ipcRenderer.send(STREAM_CANCEL_CHANNEL, res.id);
          return;
        }
        if (res.id !== id) {
          settled = true;
          cleanup();
          reject(wireError('stream subscription id mismatch'));
        }
      })
      .catch((reason: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(toWireError(reason));
      });
  });
}

/** Renderer-requested cancellation for a stream started through {@link stream}. */
function cancelStream(id: string): void {
  activeStreamCancels.get(id)?.();
}

const api: Api = { invoke, on, stream, cancelStream };

// The single, frozen bridge. Nothing else is exposed to the renderer.
contextBridge.exposeInMainWorld('api', api);
