// Auto-update service — electron-updater wrapper (Phase 6, Track H4 / README §6.5).
//
// The production-only electron-builder config embeds the public GitHub release feed and
// signs/notarizes the app. Development and unsigned local packages deliberately omit that
// metadata. electron-updater's `autoUpdater.checkForUpdates()` throws when no feed exists,
// so this service degrades gracefully:
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
  autoInstallOnAppQuit?: boolean;
  allowPrerelease?: boolean;
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
   * path. Injected so dev/test never loads electron-updater.
   */
  autoUpdater?: AutoUpdaterLike;
  /** Version of the currently running application. */
  currentVersion?: string;
  /** Synchronous observer invoked for every status transition. */
  onStatusChange?: (status: UpdateStatus) => void;
  /** Optional log sink (defaults to no-op). */
  log?: (message: string) => void;
}

export interface ReleaseUpdaterLoaderDeps {
  /** Development and generic unpackaged runs never inspect or import updater code. */
  isPackaged: boolean;
  /** Read the embedded app-update.yml contents. Injected for deterministic tests. */
  readMetadata: () => Promise<string>;
  /** Lazily import electron-updater only after metadata passes validation. */
  importUpdater: () => Promise<AutoUpdaterLike>;
  /** Optional fixed-message diagnostic sink. */
  log?: (message: string) => void;
}

/** Human-readable reason surfaced when updates aren't available in this build. */
const UNSUPPORTED_MESSAGE =
  'Automatic updates are unavailable in this build (no signed release feed is configured).';
const UPDATE_ERROR_MESSAGE =
  'Unable to check for updates. Please try again later.';
const INSTALL_ERROR_MESSAGE =
  'Unable to restart and install the update. Please try again.';
const TRUSTED_RELEASE_METADATA_KEYS = new Set([
  'provider',
  'owner',
  'repo',
  'releaseType',
  'updaterCacheDirName',
]);
const SAFE_UPDATER_CACHE_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Decide whether embedded electron-builder metadata authorizes the production updater.
 * Only the expected public GitHub repository is trusted; malformed or duplicate fields
 * fail closed.
 */
export function isTrustedReleaseMetadata(metadata: string): boolean {
  const values = new Map<string, string>();
  for (const rawLine of metadata.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (rawLine !== rawLine.trimStart()) return false;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!match) return false;

    const key = match[1];
    if (!TRUSTED_RELEASE_METADATA_KEYS.has(key)) return false;
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    if (values.has(key)) return false;
    values.set(key, value);
  }

  const updaterCacheDirName = values.get('updaterCacheDirName');
  const releaseType = values.get('releaseType');
  return (
    values.get('provider') === 'github' &&
    values.get('owner') === 'serolo' &&
    values.get('repo') === 'Harness' &&
    (releaseType === undefined || releaseType === 'draft') &&
    (updaterCacheDirName === undefined ||
      SAFE_UPDATER_CACHE_DIR_NAME.test(updaterCacheDirName))
  );
}

/**
 * Load electron-updater only after a packaged build's embedded release metadata passes
 * validation. Missing/corrupt/wrong-repository metadata never calls `importUpdater`.
 */
export async function loadReleaseUpdater(
  deps: ReleaseUpdaterLoaderDeps,
): Promise<AutoUpdaterLike | undefined> {
  if (!deps.isPackaged) return undefined;

  let metadata: string;
  try {
    metadata = await deps.readMetadata();
  } catch {
    deps.log?.(
      '[update] embedded release metadata is unavailable; updates disabled',
    );
    return undefined;
  }
  if (!isTrustedReleaseMetadata(metadata)) {
    deps.log?.(
      '[update] embedded release metadata is invalid; updates disabled',
    );
    return undefined;
  }

  try {
    return await deps.importUpdater();
  } catch {
    deps.log?.(
      '[update] release updater could not be loaded; updates disabled',
    );
    return undefined;
  }
}

/**
 * Wraps electron-updater with a typed `UpdateStatus` state machine + a hard unsupported path
 * for unsigned/dev/no-feed builds. Construct once at startup; expose `checkForUpdates` /
 * `install` over IPC and call `checkOnLaunch()` from `whenReady`.
 */
export class UpdateService {
  private status: UpdateStatus = { state: 'idle' };
  private readonly updater: AutoUpdaterLike | undefined;
  private readonly supported: boolean;
  private readonly log: (message: string) => void;
  private readonly currentVersion: string | undefined;
  private readonly onStatusChange: (status: UpdateStatus) => void;
  private installRequested = false;

  constructor(deps: UpdateServiceDeps) {
    this.log = deps.log ?? (() => {});
    this.currentVersion = deps.currentVersion;
    this.onStatusChange = deps.onStatusChange ?? (() => {});
    this.supported =
      deps.isPackaged && deps.feedConfigured && deps.autoUpdater !== undefined;
    this.updater = this.supported ? deps.autoUpdater : undefined;

    if (this.updater) {
      // Manual control: we trigger checks explicitly and gate install on `downloaded`.
      this.updater.autoDownload = true;
      this.updater.autoInstallOnAppQuit = false;
      this.updater.allowPrerelease = false;
      this.wireEvents(this.updater);
      this.setStatus({ state: 'idle' });
    } else {
      this.setStatus({
        state: 'unsupported',
        message: UNSUPPORTED_MESSAGE,
      });
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
      this.setStatus({
        state: 'unsupported',
        message: UNSUPPORTED_MESSAGE,
      });
      return this.getStatus();
    }
    this.setStatus({ state: 'checking' });
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this.setStatus({
        state: 'error',
        message: userFacingError(err),
      });
      this.log(`[update] check failed: ${technicalError(err)}`);
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
    if (this.installRequested) return;
    this.installRequested = true;
    try {
      this.updater.quitAndInstall();
    } catch (error) {
      this.installRequested = false;
      this.log(`[update] install failed: ${technicalError(error)}`);
      throw new AppError('internal', INSTALL_ERROR_MESSAGE);
    }
  }

  /** Best-effort check on launch. Never throws — a failure is logged and swallowed. */
  async checkOnLaunch(): Promise<void> {
    if (!this.updater) return;
    try {
      await this.checkForUpdates();
    } catch (err) {
      this.log(`[update] launch check failed: ${technicalError(err)}`);
    }
  }

  /** Detach updater listeners (quit teardown). Safe on the unsupported path. */
  dispose(): void {
    this.updater?.removeAllListeners();
  }

  /** Mirror electron-updater's lifecycle events into the typed `UpdateStatus`. */
  private wireEvents(updater: AutoUpdaterLike): void {
    updater.on('checking-for-update', () => {
      this.setStatus({ state: 'checking' });
    });
    updater.on('update-available', (info: unknown) => {
      this.setStatus({ state: 'available', version: versionOf(info) });
    });
    updater.on('update-not-available', () => {
      this.setStatus({ state: 'not-available' });
    });
    updater.on('download-progress', (progress: unknown) => {
      const percent = normalizedPercent(progress);
      this.setStatus({
        state: 'downloading',
        version: this.status.version,
        ...(percent === undefined ? {} : { percent }),
      });
    });
    updater.on('update-downloaded', (info: unknown) => {
      this.setStatus({ state: 'downloaded', version: versionOf(info) });
    });
    updater.on('error', (err: unknown) => {
      this.log(`[update] updater error: ${technicalError(err)}`);
      this.setStatus({
        state: 'error',
        message: userFacingError(err),
      });
    });
  }

  /**
   * Store and publish one immutable snapshot. Centralizing transitions prevents event
   * listeners and command paths from exposing subtly different status shapes.
   */
  private setStatus(status: UpdateStatus): void {
    this.status = {
      ...status,
      ...(this.currentVersion === undefined
        ? {}
        : { currentVersion: this.currentVersion }),
    };
    this.onStatusChange({ ...this.status });
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

/** Extract, validate, and bound electron-updater's progress percentage. */
function normalizedPercent(progress: unknown): number | undefined {
  if (
    progress === null ||
    typeof progress !== 'object' ||
    !('percent' in progress)
  ) {
    return undefined;
  }
  const percent = (progress as { percent: unknown }).percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return undefined;
  }
  return Math.min(100, Math.max(0, percent));
}

/**
 * Preserve short, useful transport failures while refusing strings that resemble a URL,
 * credential, authorization header, or local path.
 */
function userFacingError(error: unknown): string {
  if (!(error instanceof Error)) return UPDATE_ERROR_MESSAGE;
  const message = error.message.trim();
  if (
    message === '' ||
    message.length > 160 ||
    /https?:\/\/|www\.|token|secret|password|credential|api[-_ ]?key|authorization|bearer|signature|x-amz|[A-Za-z]:\\|\/(?:Users|home|private|tmp)\//i.test(
      message,
    )
  ) {
    return UPDATE_ERROR_MESSAGE;
  }
  return message;
}

/** Technical log detail constrained to the same secret-safe message policy. */
function technicalError(error: unknown): string {
  const kind = error instanceof Error ? error.name : typeof error;
  return `${kind}: ${userFacingError(error)}`;
}
