// The ONLY module allowed to hardcode on-disk locations (phase doc §3.2).
// Resolves everything relative to Electron's `userData` directory. Every export is a
// FUNCTION, never a module-level constant: `app.getPath('userData')` is only valid
// after the Electron `app` has initialized, so evaluating a path at import time (before
// app-ready) would throw or resolve to the wrong place. See spec §2.3 for the layout.

import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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

/** Convert a display name into a safe, readable managed-project directory base. */
export function projectDirectoryBaseName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return normalized || 'project';
}

/** Allocate a case-insensitively unique name without exceeding 63 characters. */
export function allocateProjectDirectoryName(
  projectName: string,
  existing: Iterable<string>,
): string {
  const taken = new Set(
    [...existing].map((name) => name.normalize('NFKC').toLowerCase()),
  );
  const base = projectDirectoryBaseName(projectName);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, 63 - tail.length).replace(/-+$/g, '')}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** `<managed-root>/projects/<project-name>/` — one project's app-owned state. */
export function projectDir(directoryName: string): string {
  return ensureDir(join(rootDirectory(), 'projects', directoryName));
}

/** Legacy pre-root-preference worktree path, used only to adopt interrupted creates. */
export function legacyWorktreePath(id: string, name: string): string {
  return join(userDataRoot(), 'projects', id, 'worktrees', name);
}

/** `<managed-root>/projects/<project-name>/repo` — the base clone. */
export function repoDir(directoryName: string): string {
  return ensureDir(join(projectDir(directoryName), 'repo'));
}

/** `<managed-root>/projects/<project-name>/worktrees/` — linked worktrees. */
export function worktreesDir(directoryName: string): string {
  return ensureDir(join(projectDir(directoryName), 'worktrees'));
}

/** `<managed-root>/projects/<project-name>/worktrees/<name>` — one worktree. */
export function worktreeDir(directoryName: string, name: string): string {
  return ensureDir(join(worktreesDir(directoryName), name));
}

/** `<managed-root>/projects/<project-name>/knowledge` — canonical OKF bundle. */
export function knowledgeDir(directoryName: string): string {
  return ensureDir(join(projectDir(directoryName), 'knowledge'));
}

/** `<managed-root>/projects/<project-name>/knowledge-proposals` — review state. */
export function knowledgeProposalsDir(directoryName: string): string {
  return ensureDir(join(projectDir(directoryName), 'knowledge-proposals'));
}

/** App-managed, project-scoped custom agent bundles. */
export function projectAgentsDir(projectId: string): string {
  return ensureDir(join(projectDir(projectId), 'agents'));
}

/** Private root for one meta run's broker socket and token file. */
export function metaRunControlDir(runId: string): string {
  return ensureDir(join(userDataRoot(), 'meta-runs', runId));
}

/** Immutable built-ins, resolved identically for source and packaged builds. */
export function builtinAgentsDir(options?: {
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
}): string {
  const packaged = options?.packaged ?? app.isPackaged;
  if (packaged) {
    return join(
      options?.resourcesPath ?? process.resourcesPath,
      'builtin-agents',
    );
  }
  const appPath = options?.appPath ?? app.getAppPath();
  const direct = join(appPath, 'resources', 'builtin-agents');
  if (options?.appPath !== undefined || existsSync(direct)) return direct;
  // A built entry launched directly by Playwright/Electron reports `out/main` as
  // appPath. Walk back to the checkout while keeping normal dev/package paths stable.
  return join(appPath, '..', '..', 'resources', 'builtin-agents');
}
