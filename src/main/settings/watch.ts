// Settings hot-reload watcher (Phase 6, Task A4 / phase doc §3.1).
//
// Watches the (≤3) on-disk layer files and fires a DEBOUNCED callback when any of
// them is added, changed, or removed, so the service can re-merge and emit
// `settings:changed`. chokidar is already a dependency (the DiffService uses it);
// this mirrors that add/close idiom.
//
// Watching FILES (not the dir) with `ignoreInitial: true` means the initial scan
// does not fire, and creating a not-yet-existing layer file still fires an `add`.
// The debounce coalesces the burst of events an editor emits on a single save.

import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

/** Default debounce window — long enough to coalesce an editor's save burst. */
const DEFAULT_DEBOUNCE_MS = 150;

/** A live settings watcher; `close()` detaches chokidar + cancels any pending fire. */
export interface SettingsWatcher {
  close(): Promise<void>;
}

/** Options for {@link createSettingsWatcher} (the debounce is overridable in tests). */
export interface WatchOptions {
  debounceMs?: number;
}

/**
 * Watch `files` and invoke `onChange` once per debounced burst of add/change/unlink
 * events. Returns a handle whose `close()` is idempotent and safe to call from quit
 * teardown. `onChange` is never called synchronously from this function.
 */
export function createSettingsWatcher(
  files: readonly string[],
  onChange: () => void,
  options: WatchOptions = {},
): SettingsWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const watcher: FSWatcher = chokidarWatch([...files], {
    ignoreInitial: true,
  });

  const schedule = (): void => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) onChange();
    }, debounceMs);
  };

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);

  return {
    async close(): Promise<void> {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await watcher.close();
    },
  };
}
