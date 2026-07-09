// Typed broadcast-event emitters for the MAIN process (README §6.2).
//
// Broadcast events are one-way `webContents.send('<domain>:<event>', payload)` pushes
// the renderer subscribes to via `api.on(...)`. The event names + payload shapes are
// FROZEN in `@shared/ipc` (`Events`); this module is a thin typed wrapper that makes
// `tsc` reject a wrong channel name or a mismatched payload at every call site.
//
// Owning services (WorkspaceManager, etc.) import `emit` from here rather than calling
// `webContents.send` directly, so the contract is enforced in one place.

import type { WebContents } from 'electron';
import type { EventChannel, EventPayload } from '@shared/ipc';

/**
 * Send one broadcast event to a single renderer. `event` is constrained to the frozen
 * `Events` keys and `payload` to that key's payload type, so channel/payload drift is a
 * compile error.
 */
export function emit<K extends EventChannel>(
  webContents: WebContents,
  event: K,
  payload: EventPayload<K>,
): void {
  if (webContents.isDestroyed()) {
    return;
  }
  webContents.send(event, payload);
}

/**
 * Broadcast one event to several renderers (e.g. every open window). Destroyed
 * WebContents are skipped. Same type-safety as {@link emit}.
 */
export function emitAll<K extends EventChannel>(
  targets: readonly WebContents[],
  event: K,
  payload: EventPayload<K>,
): void {
  for (const wc of targets) {
    emit(wc, event, payload);
  }
}
