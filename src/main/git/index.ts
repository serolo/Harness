// GitService — worktree lifecycle + diff/refs over the system `git` binary
// (README §2: execa/simple-git wrapper). Phase 0 STUB: every method has a real,
// thought-through signature (params + return type) that later phases build
// against — a wrong signature here is a contract break — but the body throws
// `not implemented`. Implemented in Phase 1 (worktrees) + Phase 4 (diff/checkpoints).
//
// All operations shell out to `git -C <cwd> ...`; execa v9 (ESM-only) is used
// for fine-grained control over `--progress` stderr streaming.

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { execa } from 'execa';

import { AppError } from '@shared/errors';

// ---------------------------------------------------------------------------
// Existing Phase-0 interfaces (frozen — DO NOT modify)
// ---------------------------------------------------------------------------

/** One entry in a `git status --porcelain` result, normalized. */
export interface GitStatusEntry {
  /** Repo-relative path. For renames, the destination path. */
  path: string;
  /** Working-tree change vs the index/HEAD. */
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  /** Whether the change is staged (in the index). */
  staged: boolean;
}

/** Working-tree status for a worktree (spec §5.5 "Git" check row). */
export interface GitStatus {
  /** Current branch name, or `null` in detached-HEAD state. */
  branch: string | null;
  /** Per-file changes. */
  files: GitStatusEntry[];
  /** True when there are no tracked or untracked changes. */
  clean: boolean;
  /** Commits ahead of the upstream/base ref. */
  ahead: number;
  /** Commits behind the upstream/base ref. */
  behind: number;
}

/** A single changed file within a diff, with per-file line stats (spec §5.3). */
export interface DiffFile {
  /** Repo-relative path (destination path for renames). */
  path: string;
  /** Prior path when the file was renamed, else `null`. */
  oldPath: string | null;
  /** Change kind driving the file-tree badge. */
  change: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Lines added / removed for the per-file stat badge. */
  additions: number;
  deletions: number;
}

/** A computed diff: the file list plus the raw unified patch (spec §5.3). */
export interface GitDiff {
  /** The two endpoints the diff was computed between. */
  baseRef: string;
  headRef: string;
  /** Changed files with stats. */
  files: DiffFile[];
  /** The raw unified-diff patch text (fed to Monaco/Shiki in the renderer). */
  patch: string;
}

// ---------------------------------------------------------------------------
// Phase-1 new exported types
// ---------------------------------------------------------------------------

/**
 * A single progress event emitted while `git clone --progress` is running.
 * The `percent` is parsed from git's human-readable stderr lines.
 */
export type CloneProgress = {
  phase: 'counting' | 'compressing' | 'receiving' | 'resolving';
  percent: number;
};

/** Metadata about an opened git repository. */
export interface RepoInfo {
  /** The `origin` remote URL, or empty string when no remote is configured. */
  originUrl: string;
  /** The default branch (e.g. `main` or `master`). */
  defaultBranch: string;
}

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeInfo {
  /** Absolute path of the worktree on disk. */
  path: string;
  /** Short branch name, or `null` when the worktree is in detached-HEAD state. */
  branch: string | null;
  /** The SHA1 of the HEAD commit in this worktree. */
  head: string;
}

/** HEAD state for a worktree, optionally with ahead/behind vs a base ref. */
export interface HeadInfo {
  /** The full SHA1 of HEAD. */
  sha: string;
  /** Short branch name, or `null` when in detached-HEAD state. */
  branch: string | null;
  /** Commits in HEAD that are NOT in `baseRef` (0 when no baseRef was given). */
  ahead: number;
  /** Commits in `baseRef` that are NOT in HEAD (0 when no baseRef was given). */
  behind: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a human-readable git progress label (as it appears in stderr) to the
 * {@link CloneProgress} `phase` discriminant.
 */
const PROGRESS_PHASE_MAP: Record<string, CloneProgress['phase'] | undefined> = {
  'Counting objects': 'counting',
  'Compressing objects': 'compressing',
  'Receiving objects': 'receiving',
  'Resolving deltas': 'resolving',
};

/**
 * Parse all `\r`- or `\n`-delimited lines from a chunk of git progress stderr
 * output and return the `CloneProgress` events found therein.
 *
 * Git uses carriage-return (`\r`) to overwrite the current terminal line while
 * work is ongoing, then `\n` when it moves to the next phase.  We split on
 * both so we capture every intermediate update.
 */
function parseCloneProgressChunk(chunk: string): CloneProgress[] {
  // Split on \r and/or \n so we handle in-place-update lines correctly.
  const lines = chunk.split(/[\r\n]/);
  const events: CloneProgress[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // git progress lines look like:
    //   "Counting objects:  42% (123/456)"
    //   "Receiving objects: 100% (456/456), done."
    const match = /^([A-Za-z ]+?):\s+(\d+)%/.exec(trimmed);
    if (match === null) continue;

    const label = match[1].trim();
    const percent = parseInt(match[2], 10);
    const phase = PROGRESS_PHASE_MAP[label];

    if (phase !== undefined && !isNaN(percent)) {
      events.push({ phase, percent });
    }
  }

  return events;
}

/**
 * Normalize any thrown value from an execa call into an {@link AppError} with
 * code `'git'`.  The helper is reused by every method that shells out via execa
 * so error formatting is consistent across the service.
 *
 * Special-cases:
 *   - `ENOENT` → git binary not found on PATH.
 *   - Any other execa failure → wrap `.stderr` + `.command`.
 *   - Already-AppError → re-throw unchanged.
 */
function toGitError(e: unknown, fallbackCmd: string): AppError {
  if (e instanceof AppError) {
    return e;
  }

  // ENOENT: the `git` binary is not on PATH (or path typo in the call site).
  const code = (e as { code?: string }).code;
  if (code === 'ENOENT') {
    return new AppError('git', 'git executable not found on PATH', {
      cmd: fallbackCmd,
    });
  }

  // execa failure: it exposes `.stderr`, `.shortMessage`, and `.command`.
  const asExeca = e as {
    stderr?: string;
    shortMessage?: string;
    command?: string;
  };

  const message =
    asExeca.shortMessage ?? (e instanceof Error ? e.message : 'git error');
  const stderr = asExeca.stderr ?? '';
  const cmd = asExeca.command ?? fallbackCmd;

  return new AppError('git', message, { stderr, cmd });
}

// ---------------------------------------------------------------------------
// Phase-4 diff parsing helpers
// ---------------------------------------------------------------------------

/**
 * A single hunk parsed from a unified-diff patch. Reused by the DiffService
 * (`src/main/diff`) to build per-file hunk views — kept pure and exported so
 * it can be imported without an execa round-trip.
 */
export interface UnifiedHunk {
  /** 1-based start line of the hunk on the OLD side. */
  oldStart: number;
  /** Number of lines the hunk spans on the OLD side. */
  oldLines: number;
  /** 1-based start line of the hunk on the NEW side. */
  newStart: number;
  /** Number of lines the hunk spans on the NEW side. */
  newLines: number;
  /** The raw body lines of the hunk (context / `+` / `-`), header excluded. */
  lines: string[];
}

/**
 * Parse the hunks from a unified-diff patch (as produced by `git diff`).
 *
 * Walks `@@ -oldStart,oldLines +newStart,newLines @@` headers; the line counts
 * are optional in the git format (a missing count means `1`). Body lines are
 * accumulated until the next hunk header or the next file's `diff --git` /
 * `index ` / `--- ` / `+++ ` framing lines. Pure and side-effect free.
 */
export function parseUnifiedHunks(patch: string): UnifiedHunk[] {
  const hunks: UnifiedHunk[] = [];
  let current: UnifiedHunk | null = null;

  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);

    if (header !== null) {
      // Start of a new hunk — flush the previous one first.
      if (current !== null) hunks.push(current);
      current = {
        oldStart: parseInt(header[1], 10),
        oldLines: header[2] === undefined ? 1 : parseInt(header[2], 10),
        newStart: parseInt(header[3], 10),
        newLines: header[4] === undefined ? 1 : parseInt(header[4], 10),
        lines: [],
      };
      continue;
    }

    if (current === null) continue;

    // A new file's framing lines close the current hunk; the git "\ No newline
    // at end of file" marker and real body lines belong to the hunk.
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      hunks.push(current);
      current = null;
      continue;
    }

    current.lines.push(line);
  }

  if (current !== null) hunks.push(current);
  return hunks;
}

/** One parsed `--name-status -z` entry (change kind + old/new paths). */
interface NameStatusEntry {
  /** First char of the raw status column: A/M/D/R/C/T. */
  code: string;
  /** Source path for renames/copies, else `null`. */
  oldPath: string | null;
  /** Destination (current) path. */
  newPath: string;
}

/**
 * Parse `git diff --name-status -z` output into typed entries.
 *
 * The `-z` form NUL-terminates every field; rename/copy records emit the status
 * token followed by TWO path tokens (old, new), all other records emit the
 * status token followed by ONE path token. Parsing the raw NUL stream avoids
 * the ambiguous ` => ` / brace substitution of the non-`-z` rename format.
 */
function parseNameStatusZ(out: string): NameStatusEntry[] {
  const tokens = out.split('\0');
  const entries: NameStatusEntry[] = [];
  let i = 0;

  while (i < tokens.length) {
    const status = tokens[i];
    // Trailing empty token after the final NUL, or stray blanks.
    if (status === undefined || status === '') {
      i += 1;
      continue;
    }

    const code = status[0];
    if (code === 'R' || code === 'C') {
      // Rename/copy: <status>\0<old>\0<new>
      entries.push({
        code,
        oldPath: tokens[i + 1] ?? null,
        newPath: tokens[i + 2] ?? '',
      });
      i += 3;
    } else {
      // Add/modify/delete/type-change: <status>\0<path>
      entries.push({ code, oldPath: null, newPath: tokens[i + 1] ?? '' });
      i += 2;
    }
  }

  return entries;
}

/** Per-file line stats from `git diff --numstat`. */
interface NumstatEntry {
  additions: number;
  deletions: number;
}

/**
 * Parse `git diff --numstat -z` output into a map keyed by the (destination)
 * path. Binary files report `-` for both counts → normalized to 0. Rename/copy
 * records carry an empty path field followed by the old + new path tokens; we
 * key the stats on the NEW path so they merge with the name-status entries.
 */
function parseNumstatZ(out: string): Map<string, NumstatEntry> {
  const tokens = out.split('\0');
  const map = new Map<string, NumstatEntry>();
  let i = 0;

  while (i < tokens.length) {
    const chunk = tokens[i];
    if (chunk === undefined || chunk === '') {
      i += 1;
      continue;
    }

    // A stats chunk is "<add>\t<del>\t<path?>" — the path is present for normal
    // records and empty for renames (the paths follow as separate tokens).
    const parts = chunk.split('\t');
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
    const pathField = parts[2] ?? '';

    if (pathField === '') {
      // Rename/copy: the old + new paths are the next two tokens.
      const newPath = tokens[i + 2] ?? '';
      if (newPath !== '') map.set(newPath, { additions, deletions });
      i += 3;
    } else {
      map.set(pathField, { additions, deletions });
      i += 1;
    }
  }

  return map;
}

/** Map a git name-status letter to the frozen {@link DiffFile.change} union. */
function mapDiffChange(code: string): DiffFile['change'] {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    // Copies create a new path (no `copied` in the frozen union) and type
    // changes are content changes — fold both into the nearest kind.
    case 'C':
      return 'added';
    default:
      // 'M', 'T', and any unexpected letter → treat as a content modification.
      return 'modified';
  }
}

/** Parsed fields from a `git status --porcelain=v1 -b` header line. */
interface StatusHeader {
  branch: string | null;
  ahead: number;
  behind: number;
}

/**
 * Parse the `## ...` branch header emitted by `git status --porcelain=v1 -b`.
 *
 * Handled forms:
 *   - `## main...origin/main [ahead 1, behind 2]` → branch `main`, ahead/behind
 *   - `## main...origin/main`                     → branch `main`, 0/0
 *   - `## main`                                    → branch `main`, no upstream
 *   - `## HEAD (no branch)`                        → detached → `null`
 *   - `## No commits yet on main`                  → unborn branch `main`
 */
function parseStatusHeader(header: string): StatusHeader {
  const body = header.replace(/^## /, '');

  // Ahead/behind live in a trailing `[ahead N, behind M]` bracket.
  let ahead = 0;
  let behind = 0;
  const bracket = /\[([^\]]+)\]\s*$/.exec(body);
  if (bracket !== null) {
    const a = /ahead (\d+)/.exec(bracket[1]);
    const b = /behind (\d+)/.exec(bracket[1]);
    if (a !== null) ahead = parseInt(a[1], 10);
    if (b !== null) behind = parseInt(b[1], 10);
  }

  // The branch portion precedes the bracket and any `...upstream` suffix.
  const branchPart = body.replace(/\s*\[[^\]]+\]\s*$/, '').trim();

  if (branchPart.startsWith('HEAD (no branch)')) {
    return { branch: null, ahead, behind };
  }

  const unborn = /^No commits yet on (.+)$/.exec(branchPart);
  if (unborn !== null) {
    return { branch: unborn[1].trim(), ahead, behind };
  }

  const dots = branchPart.indexOf('...');
  const branch = dots >= 0 ? branchPart.slice(0, dots) : branchPart;
  return { branch, ahead, behind };
}

/** Map a porcelain-v1 XY status pair to the frozen {@link GitStatusEntry}. */
function mapPorcelainStatus(x: string, y: string): GitStatusEntry['status'] {
  // Prefer the index (staged) column when it carries the change; otherwise use
  // the worktree column. Untracked (`??`) is handled by the caller.
  const primary = x !== ' ' ? x : y;
  switch (primary) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      // 'M', 'T', 'U' (unmerged), and anything unexpected → modified.
      return 'modified';
  }
}

// ---------------------------------------------------------------------------
// GitService
// ---------------------------------------------------------------------------

/**
 * Thin typed wrapper over the system `git` binary. One instance is shared via
 * `AppContext`; every method targets an explicit repo/worktree path (the service
 * is stateless — it never assumes a "current" directory).
 *
 * All git I/O uses `execa` v9 (ESM-only) for fine-grained control over the
 * `--progress` stderr stream.  Every failure from execa is normalized into an
 * {@link AppError} with code `'git'` via the private {@link toGitError} helper.
 *
 * Phase-1 implements: clone, open, defaultBranch, fetch, branchExists,
 * addWorktree, removeWorktree, worktreeList, headInfo, mergeBase.
 *
 * Phase-4 implements: status, diff, commitTree, updateRef, resetHard.
 */
export class GitService {
  // -------------------------------------------------------------------------
  // Phase 1 — worktree / ref lifecycle
  // -------------------------------------------------------------------------

  /**
   * Clone a repository into `destPath` with optional live progress reporting.
   *
   * Spawns `git clone --progress <originUrl> <destPath>` and attaches a `data`
   * listener to the child process's stderr stream.  Git writes its
   * human-readable progress output (e.g. `Receiving objects:  99% …`) to stderr
   * with carriage-return (`\r`) separators; those lines are parsed into
   * {@link CloneProgress} events and forwarded to `onProgress` as they arrive.
   *
   * Auth is handled entirely by the user's credential helper / SSH agent — no
   * token handling here (Phase 5).
   *
   * @returns the absolute path of the created clone (`destPath`).
   */
  async clone(
    originUrl: string,
    destPath: string,
    onProgress?: (p: CloneProgress) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const args = ['clone', '--progress', originUrl, destPath];

    try {
      // Spawn the clone process.  We must NOT use `await execa(...)` as a
      // one-liner because we need to attach a stderr listener BEFORE awaiting
      // the process exit.  execa v9 returns the child-process object directly
      // when called without await — we attach the listener then await.
      const cp = execa('git', args, { cancelSignal: opts.signal });

      if (onProgress !== undefined) {
        cp.stderr?.on('data', (buf: Buffer | string) => {
          const chunk = typeof buf === 'string' ? buf : buf.toString('utf8');
          const events = parseCloneProgressChunk(chunk);
          for (const event of events) {
            onProgress(event);
          }
        });
      }

      await cp;
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }

    return destPath;
  }

  /**
   * Validate that `repoPath` is a git repository and return its origin URL
   * plus default branch.
   *
   * - Origin URL: `git remote get-url origin` (tolerates "no remote" → `''`).
   * - Default branch: resolved via {@link defaultBranch}.
   */
  async open(repoPath: string): Promise<RepoInfo> {
    // Confirm it is actually a git repository.
    try {
      await execa('git', ['-C', repoPath, 'rev-parse', '--git-dir']);
    } catch (e) {
      throw toGitError(e, `git -C ${repoPath} rev-parse --git-dir`);
    }

    // Read the origin URL, tolerating "no such remote" gracefully.
    let originUrl = '';
    try {
      const result = await execa('git', [
        '-C',
        repoPath,
        'remote',
        'get-url',
        'origin',
      ]);
      originUrl = result.stdout.trim();
    } catch (e) {
      // `git remote get-url origin` exits non-zero when there is no remote;
      // that is an expected condition — surface as empty string.
      const asExeca = e as { exitCode?: number; code?: string };
      if (asExeca.code === 'ENOENT') {
        // Git itself not found — escalate.
        throw toGitError(e, `git -C ${repoPath} remote get-url origin`);
      }
      // Non-zero exit = no remote configured; keep originUrl as ''.
    }

    const branch = await this.defaultBranch(repoPath);

    return { originUrl, defaultBranch: branch };
  }

  /**
   * Resolve the default branch for `repoPath` using a three-level fallback:
   *
   * 1. `git symbolic-ref --short refs/remotes/origin/HEAD` — fastest; set
   *    automatically by `git clone` and `git remote set-head origin --auto`.
   *    The returned value is like `origin/main`; we strip the `origin/` prefix.
   * 2. `git remote show origin` — parses the `HEAD branch:` line.  Works even
   *    when the local `origin/HEAD` symref was never set, but is slower (makes
   *    a network call to the remote).
   * 3. `git rev-parse --abbrev-ref HEAD` — last resort for fully local repos
   *    with no remote at all; returns the current local branch.
   */
  async defaultBranch(repoPath: string): Promise<string> {
    // Attempt 1: fast local symref lookup.
    try {
      const result = await execa('git', [
        '-C',
        repoPath,
        'symbolic-ref',
        '--short',
        'refs/remotes/origin/HEAD',
      ]);
      const raw = result.stdout.trim();
      // Strip the leading "origin/" prefix if present (e.g. "origin/main" → "main").
      return raw.startsWith('origin/') ? raw.slice('origin/'.length) : raw;
    } catch {
      // Non-zero exit means the symref is not set — fall through to attempt 2.
    }

    // Attempt 2: query the remote (may involve a network round-trip). Bounded by a
    // timeout so an unreachable/slow remote cannot hang the IPC handler — on timeout
    // we fall through to the local-HEAD attempt below.
    try {
      const result = await execa(
        'git',
        ['-C', repoPath, 'remote', 'show', 'origin'],
        { timeout: 5000 },
      );
      const lines = result.stdout.split('\n');
      for (const line of lines) {
        // The relevant line looks like:  "  HEAD branch: main"
        const match = /^\s*HEAD branch:\s+(.+)$/.exec(line);
        if (match !== null) {
          return match[1].trim();
        }
      }
    } catch {
      // No remote, or remote is unreachable — fall through to attempt 3.
    }

    // Attempt 3: local HEAD (works for bare / no-remote repos).
    try {
      const result = await execa('git', [
        '-C',
        repoPath,
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]);
      return result.stdout.trim();
    } catch (e) {
      throw toGitError(e, `git -C ${repoPath} rev-parse --abbrev-ref HEAD`);
    }
  }

  /**
   * Refresh remote refs from `origin`.
   * `git -C <repoPath> fetch origin --prune`
   */
  async fetch(repoPath: string): Promise<void> {
    const args = ['-C', repoPath, 'fetch', 'origin', '--prune'];
    try {
      await execa('git', args);
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }
  }

  /**
   * List local heads and origin-tracking refs that can be used as base refs.
   *
   * Values are returned in the exact short ref form git accepts (`main`,
   * `feature/x`, `origin/main`, ...). `origin/HEAD` is excluded because it is a
   * symbolic convenience ref, not a branch the user should choose directly.
   */
  async listBranches(repoPath: string): Promise<string[]> {
    const args = [
      '-C',
      repoPath,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
      'refs/remotes/origin',
    ];
    try {
      const result = await execa('git', args);
      const seen = new Set<string>();
      for (const line of result.stdout.split('\n')) {
        const branch = line.trim();
        if (branch === '' || branch === 'origin/HEAD') continue;
        seen.add(branch);
      }
      return [...seen].sort((a, b) => a.localeCompare(b));
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }
  }

  /**
   * Fetch a pull request's head into a local branch (spec §5.6 create-from-PR).
   *
   * Runs `git -C <repoPath> fetch origin pull/<prNumber>/head:<localBranch>`. GitHub
   * exposes every PR's tip commit under the `pull/<n>/head` ref on the origin remote,
   * so after this fetch a worktree can be created directly from `<localBranch>`
   * (checkout, not `-b`) instead of branching off a base ref.
   *
   * SAME-REPO-FIRST assumption (v1): the PR head is fetched from `origin`, which
   * resolves for a PR opened from a branch of the origin repository. A PR opened from
   * a fork lives in the fork's repo and would need that remote/clone; that is out of
   * scope for v1 (the caller documents the same assumption).
   *
   * `prNumber` is validated to be a positive integer; `localBranch` is app-derived
   * (never raw user input). Both are combined into a single argv refspec element and
   * passed to `execa` as an argument array — never interpolated into a shell string.
   */
  async fetchPullRequestHead(
    repoPath: string,
    prNumber: number,
    localBranch: string,
  ): Promise<void> {
    // Defensive: the refspec embeds prNumber, so reject anything but a positive int
    // before it can shape the ref (the caller derives it from an untrusted source_ref).
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new AppError('git', `invalid pull request number: ${prNumber}`, {
        prNumber,
      });
    }

    const refspec = `pull/${prNumber}/head:${localBranch}`;
    const args = ['-C', repoPath, 'fetch', 'origin', refspec];
    try {
      await execa('git', args);
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }
  }

  /**
   * Check whether a local branch exists in `repoPath`.
   *
   * Uses `git show-ref --verify --quiet refs/heads/<name>`:
   *   - exit 0 → branch exists → `true`
   *   - non-zero → branch absent → `false`
   *
   * The non-zero exit for a missing branch is entirely normal and is NOT
   * wrapped into an `AppError`.  Only hard failures such as git-not-on-PATH
   * (ENOENT) propagate as errors.
   */
  async branchExists(repoPath: string, name: string): Promise<boolean> {
    const args = [
      '-C',
      repoPath,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${name}`,
    ];
    try {
      await execa('git', args);
      return true;
    } catch (e) {
      // ENOENT = git binary not found — that IS an error.
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT') {
        throw toGitError(e, `git ${args.join(' ')}`);
      }
      // Any other non-zero exit: branch simply does not exist.
      return false;
    }
  }

  /**
   * Add a git worktree at `worktreePath`.
   *
   * When `createBranch` is `true`, passes `-b <branch> <baseRef>` so that a
   * new branch is created off `baseRef`.  When `false`, checks out the
   * already-existing `branch` directly.
   *
   * The caller determines `createBranch` via {@link branchExists} to avoid
   * clobbering an existing branch.
   *
   * @param repoPath     - Absolute path to the bare/main repo clone.
   * @param worktreePath - Absolute destination path for the new worktree.
   * @param branch       - Branch name to create or check out.
   * @param baseRef      - The ref to branch from when `createBranch` is true.
   * @param createBranch - When `true`, passes `-b`; when `false`, checks out.
   */
  async addWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
    createBranch: boolean,
  ): Promise<void> {
    const args = createBranch
      ? ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branch, baseRef]
      : ['-C', repoPath, 'worktree', 'add', worktreePath, branch];

    try {
      await execa('git', args);
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }
  }

  /**
   * Remove a git worktree.
   * `git -C <repoPath> worktree remove [--force] <worktreePath>`
   *
   * @param force - Pass `--force` to remove a worktree that has local changes
   *                or is locked.  Should be used for archiving (phase doc §8).
   */
  async removeWorktree(
    repoPath: string,
    worktreePath: string,
    force?: boolean,
  ): Promise<void> {
    const args = [
      '-C',
      repoPath,
      'worktree',
      'remove',
      ...(force === true ? ['--force'] : []),
      worktreePath,
    ];

    try {
      await execa('git', args);
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }
  }

  /**
   * List all worktrees for `repoPath` by parsing `git worktree list --porcelain`.
   *
   * The porcelain format emits blank-line-delimited stanzas, each of the form:
   * ```
   * worktree /abs/path
   * HEAD <sha>
   * branch refs/heads/<name>   ← or the literal word "detached"
   * ```
   * We map each stanza to a {@link WorktreeInfo}.
   */
  async worktreeList(repoPath: string): Promise<WorktreeInfo[]> {
    const args = ['-C', repoPath, 'worktree', 'list', '--porcelain'];
    let stdout: string;
    try {
      const result = await execa('git', args);
      stdout = result.stdout;
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }

    const worktrees: WorktreeInfo[] = [];
    // Each worktree is separated by a blank line.
    const blocks = stdout.split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length === 0 || lines[0] === '') continue;

      let path = '';
      let head = '';
      let branch: string | null = null;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          path = line.slice('worktree '.length).trim();
        } else if (line.startsWith('HEAD ')) {
          head = line.slice('HEAD '.length).trim();
        } else if (line.startsWith('branch ')) {
          // "branch refs/heads/<name>" — strip the prefix.
          const ref = line.slice('branch '.length).trim();
          branch = ref.startsWith('refs/heads/')
            ? ref.slice('refs/heads/'.length)
            : ref;
        } else if (line.trim() === 'detached') {
          branch = null;
        }
      }

      if (path !== '' && head !== '') {
        worktrees.push({ path, head, branch });
      }
    }

    return worktrees;
  }

  /**
   * Retrieve HEAD state for a worktree, optionally with ahead/behind counts
   * relative to a `baseRef`.
   *
   * - sha    : `git rev-parse HEAD`
   * - branch : `git rev-parse --abbrev-ref HEAD` (the literal `HEAD` → detached → null)
   * - ahead/behind : `git rev-list --left-right --count <baseRef>...HEAD`
   *                  left count = commits only in baseRef = behind
   *                  right count = commits only in HEAD = ahead
   *   When `baseRef` is omitted, both are 0.
   */
  async headInfo(worktreePath: string, baseRef?: string): Promise<HeadInfo> {
    // SHA
    let sha: string;
    try {
      const result = await execa('git', [
        '-C',
        worktreePath,
        'rev-parse',
        'HEAD',
      ]);
      sha = result.stdout.trim();
    } catch (e) {
      throw toGitError(e, `git -C ${worktreePath} rev-parse HEAD`);
    }

    // Branch
    let branch: string | null;
    try {
      const result = await execa('git', [
        '-C',
        worktreePath,
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]);
      const raw = result.stdout.trim();
      // git outputs the literal string "HEAD" when in detached-HEAD state.
      branch = raw === 'HEAD' ? null : raw;
    } catch (e) {
      throw toGitError(e, `git -C ${worktreePath} rev-parse --abbrev-ref HEAD`);
    }

    // Ahead / behind
    let ahead = 0;
    let behind = 0;

    if (baseRef !== undefined) {
      const args = [
        '-C',
        worktreePath,
        'rev-list',
        '--left-right',
        '--count',
        `${baseRef}...HEAD`,
      ];
      try {
        const result = await execa('git', args);
        // Output: "<behind>\t<ahead>"
        const parts = result.stdout.trim().split('\t');
        if (parts.length === 2) {
          behind = parseInt(parts[0], 10);
          ahead = parseInt(parts[1], 10);
        }
      } catch (e) {
        throw toGitError(e, `git ${args.join(' ')}`);
      }
    }

    return { sha, branch, ahead, behind };
  }

  /**
   * Find the common ancestor of two refs.
   * `git -C <worktreePath> merge-base <a> <b>`
   *
   * @returns the trimmed SHA1 of the merge-base commit.
   */
  async mergeBase(worktreePath: string, a: string, b: string): Promise<string> {
    const args = ['-C', worktreePath, 'merge-base', a, b];
    try {
      const result = await execa('git', args);
      return result.stdout.trim();
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 4 — diff + checkpoint plumbing
  // -------------------------------------------------------------------------

  /**
   * Normalized `git status` for a worktree (spec §5.5).
   *
   * Runs `git status --porcelain=v1 -b`: the leading `## ...` header carries the
   * branch (or detached-HEAD) plus the `[ahead N, behind M]` counts vs the
   * upstream (absent → 0/0), and each subsequent `XY <path>` line is normalized
   * into a {@link GitStatusEntry}. `clean` is derived from the file count.
   */
  async status(worktreePath: string): Promise<GitStatus> {
    const args = ['-C', worktreePath, 'status', '--porcelain=v1', '-b'];
    let stdout: string;
    try {
      const result = await execa('git', args);
      stdout = result.stdout;
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }

    // Split on newlines only (paths may contain other whitespace but not \n in
    // the non-`-z` porcelain form, which quotes such names).
    const lines = stdout.split('\n');

    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    const files: GitStatusEntry[] = [];

    for (const line of lines) {
      if (line === '') continue;

      if (line.startsWith('## ')) {
        const parsed = parseStatusHeader(line);
        branch = parsed.branch;
        ahead = parsed.ahead;
        behind = parsed.behind;
        continue;
      }

      // Every entry line is "XY <path>" (a two-char status then a space).
      const code = line.slice(0, 2);
      const rest = line.slice(3);

      if (code === '??') {
        files.push({ path: rest, status: 'untracked', staged: false });
        continue;
      }

      const x = code[0];
      const y = code[1];
      const staged = x !== ' ' && x !== '?';

      // Renames/copies render as "old -> new"; the destination is the path.
      let path = rest;
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
        const arrow = rest.indexOf(' -> ');
        if (arrow >= 0) path = rest.slice(arrow + ' -> '.length);
      }

      files.push({ path, status: mapPorcelainStatus(x, y), staged });
    }

    return { branch, files, clean: files.length === 0, ahead, behind };
  }

  /**
   * Diff the worktree against `baseRef` (spec §5.3 — typically the merge-base of
   * HEAD and `origin/<base>`; the caller resolves that via {@link mergeBase}).
   *
   * A bare `git diff <baseRef>` compares the `baseRef` tree to the WORKING TREE,
   * so uncommitted changes are included (intentional — this is NOT `base..HEAD`).
   * The file list is built from `--name-status -z` (change kind + rename paths)
   * merged with `--numstat -z` (per-file line counts); `patch` is the raw
   * unified diff. `headRef` is reported as the literal `'HEAD'`.
   */
  async diff(worktreePath: string, baseRef: string): Promise<GitDiff> {
    const nameStatusArgs = [
      '-C',
      worktreePath,
      'diff',
      '--name-status',
      '-z',
      baseRef,
    ];
    const numstatArgs = [
      '-C',
      worktreePath,
      'diff',
      '--numstat',
      '-z',
      baseRef,
    ];
    const patchArgs = ['-C', worktreePath, 'diff', baseRef];

    let nameStatusOut: string;
    let numstatOut: string;
    let patch: string;
    try {
      // Independent read-only queries — run them concurrently.
      const [nameStatus, numstat, patchResult] = await Promise.all([
        execa('git', nameStatusArgs),
        execa('git', numstatArgs),
        execa('git', patchArgs),
      ]);
      nameStatusOut = nameStatus.stdout;
      numstatOut = numstat.stdout;
      patch = patchResult.stdout;
    } catch (e) {
      throw toGitError(e, `git -C ${worktreePath} diff ${baseRef}`);
    }

    const stats = parseNumstatZ(numstatOut);
    const files: DiffFile[] = parseNameStatusZ(nameStatusOut).map((entry) => {
      const stat = stats.get(entry.newPath);
      return {
        path: entry.newPath,
        oldPath: entry.oldPath,
        change: mapDiffChange(entry.code),
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
      };
    });

    return { baseRef, headRef: 'HEAD', files, patch };
  }

  /**
   * Snapshot the worktree WITHOUT touching branch history (spec §5.4 checkpoints):
   * stage everything into a SCRATCH index, then `git commit-tree` a tree object.
   *
   * The real `.git/index` is never touched — a per-call temp file is used via
   * `GIT_INDEX_FILE` (set in the execa `env`, never process-wide). The commit is
   * created with a stable app identity and, when `parents` is given, threaded to
   * those parent commits (one `-p <sha>` each) so checkpoints form a chain.
   *
   * @returns the created commit SHA (stored under `refs/checkpoints/...`).
   */
  async commitTree(
    worktreePath: string,
    message: string,
    parents?: string[],
  ): Promise<string> {
    // Per-call scratch index so the user's real index is never mutated.
    const tmpIndex = join(tmpdir(), `harness-idx-${randomUUID()}`);
    const indexEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    try {
      // Seed the scratch index from HEAD, then stage all worktree changes into
      // it (adds, mods, and deletions) — the real index is untouched.
      await execa('git', ['-C', worktreePath, 'read-tree', 'HEAD'], {
        env: indexEnv,
      });
      await execa('git', ['-C', worktreePath, 'add', '-A'], { env: indexEnv });

      const treeResult = await execa(
        'git',
        ['-C', worktreePath, 'write-tree'],
        { env: indexEnv },
      );
      const tree = treeResult.stdout.trim();

      // Build the commit object directly (no branch/HEAD update).
      const commitArgs = ['-C', worktreePath, 'commit-tree', tree];
      for (const parent of parents ?? []) {
        commitArgs.push('-p', parent);
      }
      commitArgs.push('-m', message);

      // commit-tree needs an author/committer identity; use a stable app one so
      // checkpoints don't depend on the user's git config.
      const commitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'harness',
        GIT_AUTHOR_EMAIL: 'harness@localhost',
        GIT_COMMITTER_NAME: 'harness',
        GIT_COMMITTER_EMAIL: 'harness@localhost',
      };
      const commitResult = await execa('git', commitArgs, { env: commitEnv });
      return commitResult.stdout.trim();
    } catch (e) {
      throw toGitError(e, `git -C ${worktreePath} commit-tree`);
    } finally {
      // Best-effort cleanup of the scratch index (ignore-missing).
      await rm(tmpIndex, { force: true });
    }
  }

  /**
   * Point a ref (e.g. `refs/checkpoints/<ws>/<idx>`) at a commit SHA.
   *
   * `refName` is validated to live under `refs/` before acting — this method
   * must never be coaxed into moving a branch head or an arbitrary symbolic
   * name; checkpoints only ever write `refs/checkpoints/*`.
   */
  async updateRef(
    worktreePath: string,
    refName: string,
    sha: string,
  ): Promise<void> {
    if (!refName.startsWith('refs/')) {
      throw new AppError('git', `refusing to update non-ref name: ${refName}`, {
        refName,
      });
    }

    const args = ['-C', worktreePath, 'update-ref', refName, sha];
    try {
      await execa('git', args);
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }
  }

  /**
   * Restore the worktree files to a ref (spec §5.4 revert). Destructive — the
   * caller is responsible for the confirm + auto-backup checkpoint first.
   *
   * Deliberately does NOT move the branch/HEAD and NEVER runs `git clean`:
   *   1. Read `ref`'s tree into a SCRATCH index and `checkout-index -a -f` it,
   *      restoring every tracked file (and re-creating files deleted since `ref`)
   *      WITHOUT updating HEAD or the real index.
   *   2. `checkout-index` cannot remove files that exist now but not in `ref`, so
   *      delete each such path explicitly. Tracked additions come from
   *      `git diff --name-status` (`ref`→HEAD and `ref`→worktree, status `A`);
   *      UNtracked files created after the checkpoint come from `git ls-files
   *      --others` (NOT `git clean` — that is hook-blocked) minus the paths present
   *      in `ref`'s tree (which `checkout-index` restores). Every path is resolved
   *      against and confined to the worktree root before `fs.rm` (no traversal).
   */
  async resetHard(worktreePath: string, ref: string): Promise<void> {
    const tmpIndex = join(tmpdir(), `harness-idx-${randomUUID()}`);
    const indexEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const root = resolve(worktreePath);

    try {
      // Determine which paths exist now but are absent from `ref` BEFORE we mutate
      // the worktree. Status 'A' vs `ref` means "added since ref" → must be deleted.
      //   - ref→HEAD  : files committed after the checkpoint.
      //   - ref→(worktree): tracked files added but not yet committed.
      const toDelete = new Set<string>();
      for (const range of [[ref, 'HEAD'], [ref]]) {
        const args = [
          '-C',
          worktreePath,
          'diff',
          '--name-status',
          '-z',
          ...range,
        ];
        const result = await execa('git', args);
        for (const entry of parseNameStatusZ(result.stdout)) {
          if (entry.code === 'A' && entry.newPath !== '') {
            toDelete.add(entry.newPath);
          }
        }
      }

      // Untracked files created after the checkpoint are invisible to `git diff`
      // (which only reports tracked changes), so enumerate them via `ls-files --others`
      // — NOT `git clean`, which the security-guard hook hard-blocks. A file that IS in
      // `ref`'s tree is restored by `checkout-index` below (keep it); only paths absent
      // from `ref`'s tree were genuinely created after the checkpoint → delete them.
      const refTree = new Set<string>();
      const lsTree = await execa('git', [
        '-C',
        worktreePath,
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        ref,
      ]);
      for (const p of lsTree.stdout.split('\0')) {
        if (p !== '') refTree.add(p);
      }
      const others = await execa('git', [
        '-C',
        worktreePath,
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ]);
      for (const p of others.stdout.split('\0')) {
        if (p !== '' && !refTree.has(p)) toDelete.add(p);
      }

      // Restore tracked files to the `ref` tree without moving HEAD/branch.
      await execa('git', ['-C', worktreePath, 'read-tree', ref], {
        env: indexEnv,
      });
      await execa('git', ['-C', worktreePath, 'checkout-index', '-a', '-f'], {
        env: indexEnv,
      });

      // Remove the files added after `ref`, each confined to the worktree root.
      for (const relPath of toDelete) {
        const abs = resolve(worktreePath, relPath);
        if (abs !== root && !abs.startsWith(root + sep)) {
          // A resolved path escaping the worktree root is never expected from
          // git output — refuse rather than delete outside the workspace.
          throw new AppError(
            'git',
            `refusing to delete path outside worktree: ${relPath}`,
            { path: relPath },
          );
        }
        await rm(abs, { force: true });
      }
    } catch (e) {
      throw toGitError(e, `git -C ${worktreePath} resetHard ${ref}`);
    } finally {
      await rm(tmpIndex, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // Phase 5 — commit + push (branch publishing)
  // -------------------------------------------------------------------------

  /**
   * Stage every change and commit the worktree onto the current branch
   * (spec §5.6 "publish"): `git add -A` then `git commit -m <message>`.
   *
   * Unlike {@link commitTree} (which builds a detached checkpoint object without
   * moving HEAD), this DOES advance the branch head. It reuses the SAME stable
   * app committer/author identity as {@link commitTree} so the commit never
   * depends on the user's local `git config user.*` being set.
   *
   * No-op-safe: when nothing is staged (a clean working tree), `git commit`
   * would exit non-zero with "nothing to commit". We detect the empty index up
   * front via `git status --porcelain` and surface a clear, typed {@link AppError}
   * (code `'git'`) rather than leaking an opaque commit failure to the caller.
   *
   * `message` is untrusted input: it is passed as a single argv element to
   * `git commit -m`, never interpolated into a shell string.
   *
   * @returns the new HEAD commit SHA created by the commit.
   */
  async commit(
    worktreePath: string,
    message: string,
  ): Promise<{ sha: string }> {
    // Stage every change (adds, modifications, and deletions) into the index.
    const addArgs = ['-C', worktreePath, 'add', '-A'];
    try {
      await execa('git', addArgs);
    } catch (e) {
      throw toGitError(e, `git ${addArgs.join(' ')}`);
    }

    // No-op guard: an empty porcelain status after `add -A` means there is
    // nothing to commit. Surface a typed git error instead of the raw non-zero
    // exit `git commit` would produce.
    const statusArgs = ['-C', worktreePath, 'status', '--porcelain'];
    let statusOut: string;
    try {
      const result = await execa('git', statusArgs);
      statusOut = result.stdout;
    } catch (e) {
      throw toGitError(e, `git ${statusArgs.join(' ')}`);
    }
    if (statusOut.trim() === '') {
      throw new AppError('git', 'nothing to commit (working tree clean)', {
        cmd: `git -C ${worktreePath} commit`,
      });
    }

    // Commit with the same stable app identity as commitTree so the branch
    // advance never depends on the user's git config. The message is passed as
    // a single argv element — never shell-interpolated.
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'harness',
      GIT_AUTHOR_EMAIL: 'harness@localhost',
      GIT_COMMITTER_NAME: 'harness',
      GIT_COMMITTER_EMAIL: 'harness@localhost',
    };
    const commitArgs = ['-C', worktreePath, 'commit', '-m', message];
    try {
      await execa('git', commitArgs, { env: commitEnv });
    } catch (e) {
      // Include the fixed command shape only (not the message) in the fallback.
      throw toGitError(e, `git -C ${worktreePath} commit -m <message>`);
    }

    // Report the new HEAD the commit produced.
    const shaArgs = ['-C', worktreePath, 'rev-parse', 'HEAD'];
    try {
      const result = await execa('git', shaArgs);
      return { sha: result.stdout.trim() };
    } catch (e) {
      throw toGitError(e, `git ${shaArgs.join(' ')}`);
    }
  }

  /**
   * Publish a single branch to a remote (spec §5.6):
   * `git -C <worktreePath> push [-u] <remote> <branch>`.
   *
   * HARD REQUIREMENT — this pushes ONLY the named branch ref. We deliberately
   * NEVER pass `--all`, `--tags`, or `--mirror`: app-local refs such as
   * `refs/checkpoints/*` must stay on the user's disk and must never be
   * published to the remote. `remote` and `branch` are untrusted and are passed
   * as separate argv elements, never shell-interpolated.
   *
   * Authentication is delegated entirely to the user's git credential helper /
   * SSH agent — no token is ever embedded into the remote URL here.
   *
   * @param opts.setUpstream - when `true`, pass `-u` so the branch is configured
   *                           to track `<remote>/<branch>` after the first push.
   */
  async push(
    worktreePath: string,
    remote: string,
    branch: string,
    opts?: { setUpstream?: boolean },
  ): Promise<void> {
    const args = ['-C', worktreePath, 'push'];
    if (opts?.setUpstream === true) args.push('-u');
    // Fully-qualified single-branch refspec only — no --all/--tags/--mirror, so local
    // refs/checkpoints/* stay local. The `refs/heads/<branch>:refs/heads/<branch>` form
    // also hardens against argument-injection: the positional token begins with
    // `refs/heads/`, so a branch name that starts with `-` can never be parsed as an option.
    args.push(remote, `refs/heads/${branch}:refs/heads/${branch}`);

    try {
      await execa('git', args);
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }
  }

  /**
   * Whether the current branch has a configured upstream tracking ref.
   *
   * Uses `git rev-parse --abbrev-ref --symbolic-full-name @{u}`:
   *   - exit 0 → an upstream is configured → `true`
   *   - non-zero → no upstream (never pushed / no tracking branch) → `false`
   *
   * Mirrors {@link branchExists}: the non-zero exit for "no upstream" is a
   * normal condition and is NOT wrapped; only a missing git binary (ENOENT)
   * propagates as an {@link AppError}.
   */
  async hasUpstream(worktreePath: string): Promise<boolean> {
    const args = [
      '-C',
      worktreePath,
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ];
    try {
      await execa('git', args);
      return true;
    } catch (e) {
      // ENOENT = git binary not found — that IS an error.
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT') {
        throw toGitError(e, `git ${args.join(' ')}`);
      }
      // Any other non-zero exit: no upstream configured for this branch.
      return false;
    }
  }

  /**
   * The current branch name for a worktree.
   * `git -C <worktreePath> rev-parse --abbrev-ref HEAD`.
   *
   * Returns the literal `'HEAD'` in detached-HEAD state (git's own output),
   * matching the raw form used by {@link headInfo} before it normalizes to
   * `null`; callers that need detached detection should compare against `'HEAD'`.
   */
  async currentBranch(worktreePath: string): Promise<string> {
    const args = ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'];
    try {
      const result = await execa('git', args);
      return result.stdout.trim();
    } catch (e) {
      throw toGitError(e, `git ${args.join(' ')}`);
    }
  }
}
