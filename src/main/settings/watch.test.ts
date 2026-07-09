// Hot-reload watcher (Task A4). Writes real temp files and asserts the debounced
// callback fires on add/change and coalesces a burst, then that close() detaches.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSettingsWatcher, type SettingsWatcher } from './watch';

let tmpDir: string;
let watcher: SettingsWatcher | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-watch-'));
});
afterEach(async () => {
  if (watcher !== undefined) await watcher.close();
  watcher = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Resolve once `predicate()` is true or reject after `timeoutMs`. */
function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('createSettingsWatcher', () => {
  it('fires the debounced callback when a watched file is created then changed', async () => {
    const file = join(tmpDir, 'settings.toml');
    let calls = 0;
    watcher = createSettingsWatcher([file], () => calls++, { debounceMs: 30 });

    // Give chokidar a moment to attach, then create + edit the file.
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(file, '[git]\nbranchPrefix = "a"\n', 'utf8');
    await waitFor(() => calls >= 1);

    const afterAdd = calls;
    writeFileSync(file, '[git]\nbranchPrefix = "b"\n', 'utf8');
    await waitFor(() => calls > afterAdd);
    expect(calls).toBeGreaterThan(afterAdd);
  });

  it('coalesces a rapid burst into a single callback (debounce)', async () => {
    const file = join(tmpDir, 'settings.toml');
    const cb = vi.fn();
    watcher = createSettingsWatcher([file], cb, { debounceMs: 80 });
    await new Promise((r) => setTimeout(r, 100));

    // Several writes inside one debounce window → one callback.
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, `[git]\nbranchPrefix = "v${i}"\n`, 'utf8');
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor(() => cb.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 150)); // let any stragglers land
    expect(cb.mock.calls.length).toBe(1);
  });

  it('does not fire after close()', async () => {
    const file = join(tmpDir, 'settings.toml');
    const cb = vi.fn();
    watcher = createSettingsWatcher([file], cb, { debounceMs: 30 });
    await new Promise((r) => setTimeout(r, 100));
    await watcher.close();
    watcher = undefined;

    writeFileSync(file, '[git]\nbranchPrefix = "a"\n', 'utf8');
    await new Promise((r) => setTimeout(r, 150));
    expect(cb).not.toHaveBeenCalled();
  });
});
