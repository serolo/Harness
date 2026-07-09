// Scoped-stream helper for the MAIN process (README §6.2 — the Electron analogue
// of Tauri's `Channel<T>`).
//
// Two transports, one shared `StreamSink<T>` shape (frozen in `@shared/ipc`):
//
//   1. createStream()          — WebContents.send over a per-subscription channel
//                                `stream:<id>`. Simple, correct, good default for
//                                low/medium-rate streams (clone progress, run-script
//                                logs, the `app:echoStream` demo).
//
//   2. createMessageChannelStream() — MessageChannelMain: a dedicated MessagePort
//                                pair. Main keeps one port, the renderer receives the
//                                other via `postMessage`. Use for HIGH-THROUGHPUT
//                                streams (PTY bytes, agent token deltas) where the
//                                per-message `WebContents.send` IPC overhead and the
//                                main-thread hop would dominate (README §6.2).
//
// BOTH variants guarantee: no listener leaks. Every path that can end a stream
// (end / error / renderer navigation / renderer destroyed / cancel) runs the SAME
// idempotent teardown, so nothing survives across turns. This helper is load-bearing
// for Phases 2/3 — the teardown discipline here is deliberate.

import { randomUUID } from 'node:crypto';
import { MessageChannelMain } from 'electron';
import type { WebContents } from 'electron';
import type { StreamSink } from '@shared/ipc';
import type { AppError } from '@shared/errors';
import { logger } from '../logging';

/**
 * The three frame kinds pushed over a scoped `stream:<id>` channel. The renderer
 * side (`preload`) discriminates on `t`. `chunk` carries the typed payload; `error`
 * carries a serialized AppError (so it survives structured clone).
 */
export type StreamFrame<T> =
  | { t: 'chunk'; chunk: T }
  | { t: 'end' }
  | { t: 'error'; error: ReturnType<AppError['toJSON']> };

/**
 * The renderer → main cancel signal for a scoped stream. Sent by the preload's
 * `stream()` teardown on `stream:cancel` with the subscription id, so main can stop
 * pushing (e.g. the component unmounted before `end`).
 */
export const STREAM_CANCEL_CHANNEL = 'stream:cancel';

/** Build the per-subscription data channel name from an id. */
export function streamChannel(id: string): string {
  return `stream:${id}`;
}

/**
 * Options for {@link createStream}. `id` is normally auto-generated; callers that
 * received a renderer-allocated id (future: renderer-initiated `api.stream`) pass it
 * through so the two sides agree on the channel name.
 */
export interface CreateStreamOptions {
  /** The renderer window to push chunks to. */
  webContents: WebContents;
  /** Subscription id; defaults to a fresh UUID. Determines the channel name. */
  id?: string;
  /**
   * Called once when the stream is fully torn down (after end/error/disconnect),
   * exactly once. Owners use it to drop their reference to the returned sink.
   */
  onClose?: () => void;
}

/** A {@link StreamSink} plus its subscription id and the channel the renderer listens on. */
export interface CreatedStream<T> {
  /** The subscription id (returned to the renderer so it subscribes to the right channel). */
  id: string;
  /** The channel name (`stream:<id>`) the renderer subscribes to. */
  channel: string;
  /** The push handle handed to the producing service. */
  sink: StreamSink<T>;
}

/**
 * Allocate a scoped stream over `WebContents.send`.
 *
 * The producer pushes into `sink`; each `push` sends one `{ t: 'chunk' }` frame on
 * `stream:<id>`, `end()` sends `{ t: 'end' }`, and `error()` sends a serialized
 * AppError. After end/error the sink is inert (further calls are ignored) and all
 * listeners are removed.
 *
 * Backpressure: `WebContents.send` is fire-and-forget with no ack, so there is no
 * transport-level credit signal. We approximate backpressure by (a) refusing to
 * enqueue once the stream is closed, and (b) coalescing sends through a microtask
 * flush queue so a producer that pushes in a tight synchronous loop yields to the
 * event loop between batches rather than starving it. For a true credit-based
 * high-rate stream, prefer {@link createMessageChannelStream}, whose port applies OS
 * socket buffering.
 *
 * Teardown (idempotent, runs exactly once):
 *  - producer calls `end()` or `error()`;
 *  - the renderer sends `stream:cancel` with this id;
 *  - the WebContents is destroyed or navigates (`destroyed` / `did-start-navigation`).
 * Any of these removes the cancel listener + navigation listeners and fires `onClose`.
 */
export function createStream<T>(
  options: CreateStreamOptions,
): CreatedStream<T> {
  const { webContents, onClose } = options;
  const id = options.id ?? randomUUID();
  const channel = streamChannel(id);

  let closed = false;
  // Microtask-batched send queue: decouples a synchronous push-loop from the IPC
  // send so the producer cannot monopolize the main-thread stack (soft backpressure).
  let queue: Array<StreamFrame<T>> = [];
  let flushScheduled = false;

  const flush = (): void => {
    flushScheduled = false;
    if (closed && queue.length === 0) {
      return;
    }
    const batch = queue;
    queue = [];
    for (const frame of batch) {
      // The WebContents may have gone away between scheduling and flushing.
      if (webContents.isDestroyed()) {
        teardown();
        return;
      }
      webContents.send(channel, frame);
    }
  };

  const scheduleFlush = (): void => {
    if (flushScheduled) {
      return;
    }
    flushScheduled = true;
    queueMicrotask(flush);
  };

  // The single teardown path. Idempotent: guarded by `closed`.
  const teardown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    // Drop every listener we added so nothing leaks across turns.
    ipcCancelListeners.delete(id);
    if (!webContents.isDestroyed()) {
      webContents.removeListener('destroyed', teardown);
      webContents.removeListener('did-start-navigation', teardown);
    }
    onClose?.();
  };

  // Renderer-initiated cancel is routed here by the shared `stream:cancel` handler
  // (registered once in register.ts). We register by id in a shared map.
  ipcCancelListeners.set(id, teardown);

  // Renderer going away (closed tab, reload, navigation) ends the stream.
  webContents.once('destroyed', teardown);
  webContents.once('did-start-navigation', teardown);

  const sink: StreamSink<T> = {
    push(chunk: T): void {
      if (closed) {
        return;
      }
      queue.push({ t: 'chunk', chunk });
      scheduleFlush();
    },
    end(): void {
      if (closed) {
        return;
      }
      queue.push({ t: 'end' });
      // Flush the queued frames (incl. this `end`) on the next microtask, THEN tear
      // down — so the `end` frame is delivered before listeners are removed.
      queueMicrotask(() => {
        flush();
        teardown();
      });
    },
    error(e: AppError): void {
      if (closed) {
        return;
      }
      queue.push({ t: 'error', error: e.toJSON() });
      queueMicrotask(() => {
        flush();
        teardown();
      });
    },
  };

  return { id, channel, sink };
}

/**
 * Shared registry of per-id cancel callbacks. `register.ts` installs ONE
 * `ipcMain.on('stream:cancel', ...)` listener that looks the id up here and invokes
 * the matching teardown. Keeping a single ipcMain listener (rather than one per
 * stream) is itself a leak-avoidance measure.
 */
export const ipcCancelListeners = new Map<string, () => void>();

/** Dispatch a renderer cancel for `id` (called by the shared `stream:cancel` handler). */
export function handleStreamCancel(id: string): void {
  const teardown = ipcCancelListeners.get(id);
  if (teardown) {
    teardown();
  }
}

// ---------------------------------------------------------------------------
// MessageChannelMain variant — high-throughput streams (PTY, agent tokens).
// ---------------------------------------------------------------------------

/** Options for {@link createMessageChannelStream}. */
export interface CreateMessageChannelStreamOptions {
  /** The renderer window that receives the transferred port. */
  webContents: WebContents;
  /**
   * The channel the renderer listens on (via `ipcRenderer.on(portChannel, e => e.ports[0])`)
   * to receive the transferred MessagePort. Defaults to `stream-port:<id>`.
   */
  portChannel?: string;
  /** Subscription id; defaults to a fresh UUID. */
  id?: string;
  /** Fired exactly once on teardown so the owner can drop its reference. */
  onClose?: () => void;
}

/** Result of {@link createMessageChannelStream}: the id, the port channel, and the sink. */
export interface CreatedMessageChannelStream<T> {
  id: string;
  /** The IPC channel the transferred port was posted on. */
  portChannel: string;
  sink: StreamSink<T>;
}

/**
 * Allocate a high-throughput stream backed by a {@link MessageChannelMain}.
 *
 * Main creates the channel, transfers `port2` to the renderer over `portChannel`
 * (via `WebContents.postMessage`, which supports port transfer), and keeps `port1`.
 * The producer's `push`/`end`/`error` write framed messages to `port1`; the renderer
 * receives them on `port2` with NO main-thread `send` hop per message — the OS-level
 * port buffer provides real backpressure and far lower overhead than `send`
 * (README §6.2: "use MessageChannelMain … to avoid main-thread send overhead").
 *
 * Use this for PTY bytes and agent token deltas. Use {@link createStream} for
 * everything else.
 *
 * Teardown (idempotent): `end()`/`error()`, the port `close` event, or the
 * WebContents being destroyed all run the same cleanup — `port1.close()` +
 * listener removal + `onClose`. No leaks across turns.
 */
export function createMessageChannelStream<T>(
  options: CreateMessageChannelStreamOptions,
): CreatedMessageChannelStream<T> {
  const { webContents, onClose } = options;
  const id = options.id ?? randomUUID();
  const portChannel = options.portChannel ?? `stream-port:${id}`;

  const { port1, port2 } = new MessageChannelMain();

  let closed = false;

  const teardown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (!webContents.isDestroyed()) {
      webContents.removeListener('destroyed', teardown);
    }
    // Closing our port releases the pair; the renderer sees a `close` on its port.
    try {
      port1.close();
    } catch (err) {
      logger.warn('[stream] port1.close() failed', err);
    }
    onClose?.();
  };

  // If the renderer's port closes (component unmounted, window gone), we stop.
  port1.on('close', teardown);
  webContents.once('destroyed', teardown);

  // `start()` is required before messages flow on a MessagePortMain.
  port1.start();

  // Hand port2 to the renderer. postMessage supports transferring the port; the
  // renderer picks it up from `event.ports[0]` on `portChannel`.
  webContents.postMessage(portChannel, { id }, [port2]);

  const sink: StreamSink<T> = {
    push(chunk: T): void {
      if (closed) {
        return;
      }
      const frame: StreamFrame<T> = { t: 'chunk', chunk };
      port1.postMessage(frame);
    },
    end(): void {
      if (closed) {
        return;
      }
      const frame: StreamFrame<T> = { t: 'end' };
      port1.postMessage(frame);
      teardown();
    },
    error(e: AppError): void {
      if (closed) {
        return;
      }
      const frame: StreamFrame<T> = { t: 'error', error: e.toJSON() };
      port1.postMessage(frame);
      teardown();
    },
  };

  return { id, portChannel, sink };
}
