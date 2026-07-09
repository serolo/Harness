// Auto-update service — electron-updater wrapper (Phase 6, Track H4 / README §6.5).
//
// DESCOPE (flagged in the plan, decided from the checkout): this repo ships NO release
// feed and NO code-signing/notarization (`electron-builder.yml` has no `publish:` block,
// `hardenedRuntime: false`, and there is no `app-update.yml`). electron-updater's
// `autoUpdater.checkForUpdates()` throws in exactly that situation (dev run / unsigned /
// no feed). So this service is built for the real updater but DEGRADES GRACEFULLY:
//
//   - When updates are UNSUPPORTED (not packaged, or no feed configured), `checkForUpdates`
//     returns a typed `{ state: 'unsupported', message }` snapshot and NEVER touches
//     electron-updater; `install` rejects with a typed `AppError`. No crash either way.
//   - When a real `autoUpdater` is injected (a signed, packaged build with a feed), it
//     drives the normal check → download → `quitAndInstall` lifecycle and mirrors the
//     updater events into `UpdateStatus`.
//
// The `autoUpdater` is INJECTED (not imported here) so this stays unit-testable without
// electron-updater and so dev/test never loads it. `src/main/index.ts` lazily imports the
// real `autoUpdater` only when packaged + a feed is configured.

import type { UpdateStatus } from '@shared/ipc';
import { AppError } from '@shared/errors';

/**
 * The slice of electron-updater's `autoUpdater` this service uses. Kept as a narrow
 * structural type so tests can supply a fake and the real module is never a compile-time
 * dependency of this file.
 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners(event?: string): void;
}

export interface UpdateServiceDeps {
  /** Whether this is a packaged build (dev runs are never updatable). */
  isPackaged: boolean;
  /** Whether a release feed is configured (no feed → updates unsupported). */
  feedConfigured: boolean;
  /**
   * The real `electron-updater` autoUpdater, or `undefined` to force the unsupported
   * (descoped) path. Injected so dev/test never loads electron-updater.
   */
  autoUpdater?: AutoUpdaterLike;
  /** Optional log sink (defaults to no-op). */
  log?: (message: string) => void;
}

/** Human-readable reason surfaced when updates aren't available in this build. */
const UNSUPPORTED_MESSAGE =
  'Automatic updates are unavailable in this build (no signed release feed is configured).';

/**
 * Wraps electron-updater with a typed `UpdateStatus` state machine + a hard descope path
 * for unsigned/dev/no-feed builds. Construct once at startup; expose `checkForUpdates` /
 * `install` over IPC and call `checkOnLaunch()` from `whenReady`.
 */
export class UpdateService {
  private status: UpdateStatus = { state: 'idle' };
  private readonly updater: AutoUpdaterLike | undefined;
  private readonly supported: boolean;
  private readonly log: (message: string) => void;

  constructor(deps: UpdateServiceDeps) {
    this.log = deps.log ?? (() => {});
    this.supported =
      deps.isPackaged && deps.feedConfigured && deps.autoUpdater !== undefined;
    this.updater = this.supported ? deps.autoUpdater : undefined;

    if (this.updater) {
      // Manual control: we trigger checks explicitly and gate install on `downloaded`.
      this.updater.autoDownload = true;
      this.wireEvents(this.updater);
    } else {
      this.status = { state: 'unsupported', message: UNSUPPORTED_MESSAGE };
    }
  }

  /** The latest updater status snapshot (returned by `update:check` and after events). */
  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /**
   * Trigger an update check. On an unsupported build this is a pure, no-throw report of
   * `unsupported`. On a supported build it flips to `checking` and lets the updater events
   * carry the outcome; a thrown check (e.g. an unreachable feed) is normalized to `error`.
   */
  async checkForUpdates(): Promise<UpdateStatus> {
    if (!this.updater) {
      this.status = { state: 'unsupported', message: UNSUPPORTED_MESSAGE };
      return this.getStatus();
    }
    this.status = { state: 'checking' };
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this.status = {
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
      this.log(`[update] check failed: ${String(err)}`);
    }
    return this.getStatus();
  }

  /**
   * Quit and install a downloaded update. Rejects with a typed `AppError` when updates are
   * unsupported or nothing has been downloaded yet — the renderer surfaces the message
   * rather than the app silently doing nothing.
   */
  async install(): Promise<void> {
    if (!this.updater) {
      // No new AppError code (the union is frozen): `not_found` = no updater/feed to use.
      throw new AppError('not_found', UNSUPPORTED_MESSAGE);
    }
    if (this.status.state !== 'downloaded') {
      throw new AppError(
        'not_found',
        'No update has been downloaded yet — check for updates first.',
      );
    }
    this.updater.quitAndInstall();
  }

  /** Best-effort check on launch. Never throws — a failure is logged and swallowed. */
  async checkOnLaunch(): Promise<void> {
    if (!this.updater) return;
    try {
      await this.checkForUpdates();
    } catch (err) {
      this.log(`[update] launch check failed: ${String(err)}`);
    }
  }

  /** Detach updater listeners (quit teardown). Safe on the unsupported path. */
  dispose(): void {
    this.updater?.removeAllListeners();
  }

  /** Mirror electron-updater's lifecycle events into the typed `UpdateStatus`. */
  private wireEvents(updater: AutoUpdaterLike): void {
    updater.on('checking-for-update', () => {
      this.status = { state: 'checking' };
    });
    updater.on('update-available', (info: unknown) => {
      this.status = { state: 'available', version: versionOf(info) };
    });
    updater.on('update-not-available', () => {
      this.status = { state: 'not-available' };
    });
    updater.on('download-progress', () => {
      this.status = { state: 'downloading' };
    });
    updater.on('update-downloaded', (info: unknown) => {
      this.status = { state: 'downloaded', version: versionOf(info) };
    });
    updater.on('error', (err: unknown) => {
      this.status = {
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    });
  }
}

/** Best-effort extraction of a `version` string from an electron-updater info payload. */
function versionOf(info: unknown): string | undefined {
  if (info !== null && typeof info === 'object' && 'version' in info) {
    const v = (info as { version: unknown }).version;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}
