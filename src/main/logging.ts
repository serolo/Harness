// electron-log initialization for the MAIN process (README §7.5).
//
// `initLogging()` is designed to be the FIRST thing `src/main/index.ts` (Task 9) calls,
// before any other subsystem — so early failures are captured. It is safe to call before
// `app.whenReady()`: the file transport's path is resolved lazily by electron-log the
// first time it actually writes, via `paths.logsDir()`, so nothing touches
// `app.getPath('userData')` at import time.

import { join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';
import { logsDir } from './paths';
import type { AppError } from './error';

/**
 * Whether the console transport should be on. `app.isPackaged` is a plain property that
 * is safe to read at call time (initLogging runs after import, in the main process). A
 * packaged build silences the console; dev keeps it verbose.
 */
function isDev(): boolean {
  return !app.isPackaged;
}

let initialized = false;

/**
 * Configure electron-log's transports and install global crash handlers. Idempotent:
 * calling more than once is a no-op after the first successful init.
 *
 * - File transport: writes into `paths.logsDir()` (resolved lazily on first write).
 * - Console transport: enabled in dev, silenced in a packaged build.
 * - Crash handlers: routes uncaughtException / unhandledRejection through electron-log
 *   (via `errorHandler.startCatching`) AND installs explicit `process.on(...)` handlers
 *   as a belt-and-suspenders guarantee that nothing escapes unlogged.
 *
 * Returns the configured logger so callers can `const logger = initLogging()`.
 */
export function initLogging(): typeof log {
  if (initialized) {
    return log;
  }
  initialized = true;

  // File transport → <userData>/logs/main.log. resolvePathFn runs on first write,
  // safely after app-ready, so app.getPath is valid by then (see paths.ts contract).
  log.transports.file.level = 'info';
  log.transports.file.resolvePathFn = () => join(logsDir(), 'main.log');

  // Console transport: only in dev; a packaged app should not spam stdout.
  log.transports.console.level = isDev() ? 'debug' : false;

  // Route unhandled crashes through electron-log with app/electron/os versions.
  log.errorHandler.startCatching({
    showDialog: false,
    onError({ error, errorName }) {
      log.error(`[${errorName}]`, error);
    },
  });

  // Explicit belt-and-suspenders handlers (phase doc §3.8). electron-log's
  // startCatching already registers these; registering our own guarantees the log line
  // even if electron-log's handler is ever reconfigured. Both are additive, not
  // exclusive — `process.on` appends listeners.
  process.on('uncaughtException', (err) => {
    log.error('[uncaughtException]', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('[unhandledRejection]', reason);
  });

  return log;
}

/**
 * Route an {@link AppError} to the log at error level, including its typed `code` and
 * any `details`. Use this at boundaries (IPC handlers, service catch blocks) so logged
 * errors carry the structured shape rather than a bare stack.
 */
export function logAppError(err: AppError): void {
  log.error(`[AppError:${err.code}] ${err.message}`, err.details ?? '');
}

/** The configured logger. Prefer calling `initLogging()` first; import this elsewhere. */
export { log as logger };
