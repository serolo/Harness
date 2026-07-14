// Ambient declaration of the preload bridge surface (`window.api`) + its types.
//
// This file is the typed contract between the preload (which implements `Api` and calls
// `contextBridge.exposeInMainWorld('api', ...)`) and the renderer (which consumes
// `window.api` — funnelled through `src/renderer/ipc/`). It is included by both the
// preload tsconfig (via `src/preload/**/*.ts`... note: .d.ts) and the renderer tsconfig
// (which explicitly includes `src/preload/**/*.d.ts`), so the two sides share ONE shape.
//
// It intentionally re-declares only what crosses to the renderer. No `ipcRenderer`, no
// Node globals — those are never on `window`.

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
import type { SerializedAppError } from '@shared/errors';

/** Remove a previously-registered broadcast-event listener. */
export type Unsubscribe = () => void;

/**
 * The wire frame delivered over a scoped `stream:<id>` channel. Mirrors main's
 * `StreamFrame<T>` (src/main/ipc/stream.ts); `error` carries a serialized AppError so it
 * survives structured clone. Declared here (not imported from main) to keep the preload
 * free of any main-process import.
 */
export type StreamFrameWire<T> =
  | { t: 'chunk'; chunk: T }
  | { t: 'end' }
  | { t: 'error'; error: SerializedAppError };

/**
 * The full, typed bridge exposed as `window.api`. Every method is pinned to the frozen
 * `@shared/ipc` maps so channel/payload drift is a renderer compile error.
 */
export interface Api {
  /** Typed request/response call. Rejects with a typed `AppError`. */
  invoke<C extends CommandChannel>(
    channel: C,
    req: CommandReq<C>,
  ): Promise<CommandRes<C>>;

  /** Subscribe to a broadcast event; returns an unsubscribe function. */
  on<K extends EventChannel>(
    event: K,
    cb: (payload: EventPayload<K>) => void,
  ): Unsubscribe;

  /**
   * Start a scoped stream: `onChunk` runs per chunk; the Promise resolves on `end` and
   * rejects (typed `AppError`) on `error`. The renderer allocates the serializable
   * subscription id so it can request cancellation without passing an `AbortSignal`
   * through contextBridge (which would strip its prototype methods).
   */
  stream<S extends StreamChannel>(
    channel: S,
    arg: StreamArg<S>,
    onChunk: (chunk: StreamChunk<S>) => void,
    opts: { id: string },
  ): Promise<void>;

  /** Cancel an active scoped stream by its renderer-allocated subscription id. */
  cancelStream(id: string): void;
}

declare global {
  interface Window {
    /** The ONLY main-process access point in the renderer (README §7.6, §10). */
    readonly api: Api;
  }
}
