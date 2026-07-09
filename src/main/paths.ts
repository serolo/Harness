// The ONLY module allowed to hardcode on-disk locations (phase doc §3.2).
// Resolves everything relative to Electron's `userData` directory. Every export is a
// FUNCTION, never a module-level constant: `app.getPath('userData')` is only valid
// after the Electron `app` has initialized, so evaluating a path at import time (before
// app-ready) would throw or resolve to the wrong place. See spec §2.3 for the layout.

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { app } from 'electron';

/**
 * Test seam (Task 10 depends on this).
 *
 * Main-process unit tests must resolve paths WITHOUT booting Electron. Two overrides,
 * checked in order:
 *   1. `setUserDataRoot(path)` — explicit programmatic override (preferred in tests).
 *   2. `AGENTAPP_USER_DATA` env var — override without importing this module first.
 * When neither is set we fall back to the real `app.getPath('userData')`.
 *
 * Keep this the only place that knows how the base is chosen.
 */
let userDataRootOverride: string | undefined;

/**
 * Point the path tree at an arbitrary base directory (e.g. an OS temp dir in tests).
 * Pass `undefined` to clear the override and fall back to Electron / env.
 */
export function setUserDataRoot(path: string | undefined): void {
  userDataRootOverride = path;
}

/** Resolve the userData base, honoring the test seam before touching Electron. */
function userDataRoot(): string {
  if (userDataRootOverride !== undefined) {
    return userDataRootOverride;
  }
  const fromEnv = process.env.AGENTAPP_USER_DATA;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  // Only reached in a real Electron process, after app init.
  return app.getPath('userData');
}

/**
 * Create a directory (and parents) if absent, then return it. Directory creation is
 * lazy — it happens the first time a path is requested at runtime, never at import
 * time — so nothing touches the filesystem before the app is ready.
 */
function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- File paths (the parent dir is the userData root, created by Electron itself) ---

/** `<userData>/app.db` — the SQLite database file. */
export function dbPath(): string {
  return join(userDataRoot(), 'app.db');
}

/** `<userData>/settings.toml` — user-level settings file. */
export function settingsPath(): string {
  return join(userDataRoot(), 'settings.toml');
}

// --- Directory paths (created on first access) ---

/** `<userData>/logs/` — rolling log files (electron-log target). */
export function logsDir(): string {
  return ensureDir(join(userDataRoot(), 'logs'));
}

/** `<userData>/secrets/` — safeStorage ciphertext blobs, never plaintext. */
export function secretsDir(): string {
  return ensureDir(join(userDataRoot(), 'secrets'));
}

/** `<userData>/projects/<id>/` — root for a single project's on-disk state. */
export function projectDir(id: string): string {
  return ensureDir(join(userDataRoot(), 'projects', id));
}

/** `<userData>/projects/<id>/repo` — the base clone (default-branch checkout). */
export function repoDir(id: string): string {
  return ensureDir(join(projectDir(id), 'repo'));
}

/** `<userData>/projects/<id>/worktrees/` — parent dir holding per-workspace worktrees. */
export function worktreesDir(id: string): string {
  return ensureDir(join(projectDir(id), 'worktrees'));
}

/** `<userData>/projects/<id>/worktrees/<name>` — one workspace's git worktree. */
export function worktreeDir(id: string, name: string): string {
  return ensureDir(join(worktreesDir(id), name));
}
