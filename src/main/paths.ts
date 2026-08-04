// The ONLY module allowed to hardcode on-disk locations (phase doc §3.2).
// Resolves everything relative to Electron's `userData` directory. Every export is a
// FUNCTION, never a module-level constant: `app.getPath('userData')` is only valid
// after the Electron `app` has initialized, so evaluating a path at import time (before
// app-ready) would throw or resolve to the wrong place. See spec §2.3 for the layout.

import { isAbsolute, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const ROOT_DIRECTORY_FILE = 'root-directory.json';

/** Default location for repositories, worktrees, and project-owned files. */
export function defaultRootDirectory(): string {
  // Keep path tests and isolated dev instances inside their explicit data root.
  if (
    userDataRootOverride !== undefined ||
    (process.env.AGENTAPP_USER_DATA ?? '') !== ''
  ) {
    return join(userDataRoot(), 'harness');
  }
  return join(app.getPath('home'), 'harness');
}

/** Current managed-project root, falling back safely when the preference is absent. */
export function rootDirectory(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(join(userDataRoot(), ROOT_DIRECTORY_FILE), 'utf8'),
    ) as { path?: unknown };
    if (typeof parsed.path === 'string' && isAbsolute(parsed.path)) {
      return ensureDir(parsed.path);
    }
  } catch {
    // Missing or malformed preferences use the documented default.
  }
  return ensureDir(defaultRootDirectory());
}

/** Validate and persist the managed-project root. Existing files are never moved. */
export function setRootDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error('Root directory must be an absolute path.');
  }
  const normalized = resolve(path);
  ensureDir(normalized);
  writeFileSync(
    join(userDataRoot(), ROOT_DIRECTORY_FILE),
    `${JSON.stringify({ path: normalized }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return normalized;
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

/** `<userData>/onboarding.json` — durable onboarding acknowledgement state. */
export function onboardingStatePath(): string {
  return join(userDataRoot(), 'onboarding.json');
}

/** `<userData>/pricing-catalog.json` — validated last-known-good token pricing. */
export function pricingCatalogPath(): string {
  return join(userDataRoot(), 'pricing-catalog.json');
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

/** `<userData>/tools/bin/` — verified app-managed helper executables. */
export function toolsBinDir(): string {
  return ensureDir(join(userDataRoot(), 'tools', 'bin'));
}

/** `<userData>/tools/` — root for app-managed helper distributions. */
export function toolsDir(): string {
  return ensureDir(join(userDataRoot(), 'tools'));
}

/** App-managed GitHub CLI executable installed during onboarding when needed. */
export function githubCliPath(): string {
  return join(toolsBinDir(), 'gh');
}

/** App-managed Claude Code native executable. */
export function claudeCliPath(): string {
  return join(toolsBinDir(), 'claude');
}

/** App-managed Codex executable inside its required vendor resource layout. */
export function codexCliPath(arch: string = process.arch): string {
  const target =
    arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return join(codexInstallDir(), 'package', 'vendor', target, 'bin', 'codex');
}

/** Root of the app-managed Codex package, including companion vendor resources. */
export function codexInstallDir(): string {
  return join(toolsDir(), 'codex', 'current');
}

/** `<userData>/projects/<id>/` — root for a single project's on-disk state. */
export function projectDir(id: string): string {
  return ensureDir(join(rootDirectory(), 'projects', id));
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

/** `<userData>/projects/<id>/knowledge` — canonical OKF v0.1 Git bundle. */
export function knowledgeDir(id: string): string {
  return ensureDir(join(projectDir(id), 'knowledge'));
}

/** `<userData>/projects/<id>/knowledge-proposals` — isolated review proposals. */
export function knowledgeProposalsDir(id: string): string {
  return ensureDir(join(projectDir(id), 'knowledge-proposals'));
}
