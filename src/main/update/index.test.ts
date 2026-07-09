// UpdateService tests (Phase 6, Track H4). Exercises BOTH the descoped/unsupported path
// (no feed / dev / no injected autoUpdater) and the supported path driven by a fake
// autoUpdater that emits electron-updater-shaped lifecycle events.

import { describe, it, expect, vi } from 'vitest';

import { UpdateService, type AutoUpdaterLike } from './index';
import { AppError } from '@shared/errors';

/** A fake autoUpdater that records listeners so a test can drive the lifecycle. */
function fakeUpdater(): AutoUpdaterLike & {
  emit: (event: string, arg?: unknown) => void;
  checkForUpdates: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  quitAndInstall: ReturnType<typeof vi.fn<() => void>>;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    autoDownload: false,
    checkForUpdates: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
    quitAndInstall: vi.fn<() => void>(),
    on(event, listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    removeAllListeners() {
      listeners.clear();
    },
    emit(event, arg) {
      for (const l of listeners.get(event) ?? []) l(arg);
    },
  };
}

describe('UpdateService — unsupported (descoped) path', () => {
  it('reports unsupported and never touches the updater when no feed is configured', async () => {
    const svc = new UpdateService({ isPackaged: true, feedConfigured: false });
    expect(svc.getStatus().state).toBe('unsupported');

    const status = await svc.checkForUpdates();
    expect(status.state).toBe('unsupported');
    expect(status.message).toMatch(/unavailable/i);
  });

  it('reports unsupported in a dev build even with a feed + updater', async () => {
    const svc = new UpdateService({
      isPackaged: false,
      feedConfigured: true,
      autoUpdater: fakeUpdater(),
    });
    expect(svc.getStatus().state).toBe('unsupported');
  });

  it('install rejects with a typed AppError when unsupported', async () => {
    const svc = new UpdateService({ isPackaged: false, feedConfigured: false });
    await expect(svc.install()).rejects.toBeInstanceOf(AppError);
  });

  it('checkOnLaunch is a no-op (does not throw) when unsupported', async () => {
    const svc = new UpdateService({ isPackaged: false, feedConfigured: false });
    await expect(svc.checkOnLaunch()).resolves.toBeUndefined();
  });
});

describe('UpdateService — supported path', () => {
  const supported = (updater: AutoUpdaterLike): UpdateService =>
    new UpdateService({
      isPackaged: true,
      feedConfigured: true,
      autoUpdater: updater,
    });

  it('mirrors updater events into UpdateStatus', async () => {
    const updater = fakeUpdater();
    const svc = supported(updater);
    expect(updater.autoDownload).toBe(true);

    await svc.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    updater.emit('update-available', { version: '1.2.3' });
    expect(svc.getStatus()).toEqual({ state: 'available', version: '1.2.3' });

    updater.emit('update-downloaded', { version: '1.2.3' });
    expect(svc.getStatus()).toEqual({ state: 'downloaded', version: '1.2.3' });
  });

  it('install quits + installs only once an update is downloaded', async () => {
    const updater = fakeUpdater();
    const svc = supported(updater);

    // Nothing downloaded yet → typed rejection, no quitAndInstall.
    await expect(svc.install()).rejects.toBeInstanceOf(AppError);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    updater.emit('update-downloaded', { version: '2.0.0' });
    await svc.install();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('normalizes a thrown check into an error status', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockRejectedValueOnce(
      new Error('feed unreachable'),
    );
    const svc = supported(updater);

    const status = await svc.checkForUpdates();
    expect(status.state).toBe('error');
    expect(status.message).toMatch(/unreachable/);
  });

  it('dispose detaches updater listeners', () => {
    const updater = fakeUpdater();
    const spy = vi.spyOn(updater, 'removeAllListeners');
    const svc = supported(updater);
    svc.dispose();
    expect(spy).toHaveBeenCalled();
  });
});
