// DiffService — computes a workspace's diff (worktree vs merge-base(HEAD,
// origin/<base>)), recomputed on debounced FS events + after each turn, and owns
// the inline diff-comment lifecycle (spec §5.3). Emits `diff:changed` when the
// watcher fires. Implemented in Phase 4.
//
// Diff shapes (`GitDiff`/`DiffFile`) are main-only, reused from GitService; the
// cross-boundary comment DTOs (`DiffComment`/`NewDiffComment`/`DiffCommentState`)
// live in `@shared/review` and are re-exported here so callers keep importing them
// from this module (the Phase-0 stub declared them locally). `DiffWatchHandle`
// stays local — it is a main-process teardown handle, never crosses the boundary.
//
// SECURITY: git + filesystem on user workspaces is a heightened-scrutiny path
// (.claude/rules/security.md). Every caller-supplied `path` is confined to the
// worktree root (traversal / absolute-escape rejected) BEFORE any `git show` /
// filesystem read; git only ever runs through GitService or argument-array execa.

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { execa } from 'execa';

import { AppError } from '@shared/errors';
import type { Attachment } from '@shared/harness';
import type { EventChannel, EventPayload } from '@shared/ipc';
import type { Workspace } from '@shared/models';
import type {
  CommitInfo,
  DiffComment,
  DiffCommentState,
  FileDiff,
  NewDiffComment,
  SendToAgentResult,
} from '@shared/review';

import type { DiffCommentsRepo } from '../db/repos/comments';
import { parseUnifiedHunks, type GitDiff, type GitService } from '../git';

// The inline-comment DTOs now live in the shared contract; re-export so callers
// (register.ts, tests) keep importing them from `../diff` as they did off the stub.
export type {
  DiffComment,
  NewDiffComment,
  DiffCommentState,
} from '@shared/review';

/** Disposes a diff watcher subscription (README §6.2 stream teardown). */
export interface DiffWatchHandle {
  stop(): void;
}

/**
 * Collaborators injected into {@link DiffService} (constructed in `src/main/index.ts`).
 * `git` is the shared GitService; `getWorkspace` resolves a workspace by id (null when
 * unknown); `emit` broadcasts a typed IPC event to open windows; `comments` is the
 * `diff_comments` repository backing the inline-comment lifecycle.
 */
export interface DiffServiceDeps {
  git: GitService;
  getWorkspace: (id: string) => Promise<Workspace | null>;
  emit: <K extends EventChannel>(event: K, payload: EventPayload<K>) => void;
  comments: DiffCommentsRepo;
}

/** One cached diff computation, keyed on the workspace's `(base, HEAD, status)` signature. */
interface DiffCacheEntry {
  key: string;
  value: GitDiff;
}

/** A live chokidar watcher entry for a workspace (idempotent per workspace). */
interface WatcherEntry {
  handle: DiffWatchHandle;
}

/** Debounce window coalescing editor save-storms into a single recompute + emit. */
const WATCH_DEBOUNCE_MS = 300;

/**
 * Directories never worth watching / diffing — matched as any path segment. chokidar
 * v4 dropped glob support, so this is a plain segment regex fed to `ignored` as a
 * {@link chokidarWatch} `MatchFunction`.
 */
const IGNORED_SEGMENT = /(^|[/\\])(\.git|node_modules|dist)([/\\]|$)/;

/** chokidar `ignored` predicate: skip `.git`, `node_modules`, `dist` at any depth. */
function isIgnoredPath(candidate: string): boolean {
  return IGNORED_SEGMENT.test(candidate);
}

/**
 * Count the lines in a file's text content (used for an untracked file's `additions`
 * stat). An empty file is 0; a trailing newline does not count as an extra line.
 */
function countLines(content: string): number {
  if (content === '') return 0;
  const parts = content.split('\n').length;
  return content.endsWith('\n') ? parts - 1 : parts;
}

/**
 * Computes diffs and manages inline comments per workspace. One instance is shared
 * via `AppContext`. The service is otherwise stateless apart from a single-slot
 * per-workspace diff cache and its FS watchers.
 */
export class DiffService {
  /** Per-workspace single-slot diff cache; invalidated on watcher fire / turn end. */
  private readonly cache = new Map<string, DiffCacheEntry>();

  /** Per-workspace FS watcher (idempotent: one watcher per workspace at a time). */
  private readonly watchers = new Map<string, WatcherEntry>();

  constructor(private readonly deps: DiffServiceDeps) {}

  /**
   * Compute the current diff for a workspace: worktree vs
   * `merge-base(HEAD, origin/<base>)` (spec §5.3), or vs an explicit `commitFilter`
   * ref when the viewer scopes the diff to a commit range.
   *
   * `git diff` only reports TRACKED changes, so untracked files are surfaced here
   * by folding each `status`-reported untracked path into an `added` {@link DiffFile}
   * (its `additions` = the file's line count; binary / unreadable → 0). The result is
   * cached under a `(base, HEAD sha, status signature)` key and the FS watcher is
   * lazily started (idempotent) so subsequent changes emit `diff:changed`.
   */
  async getDiff(workspaceId: string, commitFilter?: string): Promise<GitDiff> {
    const { wt, workspace } = await this.resolveWorktree(workspaceId);
    const base =
      commitFilter ??
      (await this.mergeBaseWithFallback(wt, workspace.baseBranch));

    // Status feeds both the cache signature and the untracked-file surfacing below.
    const status = await this.deps.git.status(wt);
    const head = await this.headSha(wt);
    const signature = status.files
      .map((f) => `${f.status}:${f.staged ? 1 : 0}:${f.path}`)
      .join('|');
    const key = `${base} ${head} ${signature}`;

    const cached = this.cache.get(workspaceId);
    if (cached !== undefined && cached.key === key) {
      // Ensure the watcher exists even on a cache hit (first hit may precede it).
      this.watch(workspaceId);
      return cached.value;
    }

    const gitDiff = await this.deps.git.diff(wt, base);
    const merged = await this.surfaceUntracked(wt, gitDiff, status);

    this.cache.set(workspaceId, { key, value: merged });
    this.watch(workspaceId); // lazy, idempotent
    return merged;
  }

  /**
   * Per-file old/new content + parsed hunks, fetched lazily by the viewer (spec §9).
   *
   * `path` is UNTRUSTED — it is validated and confined to the worktree root (traversal
   * and absolute-escape rejected) BEFORE any git/fs read. `oldContent` comes from
   * `git show <base>:<path>` (empty when the file did not exist at base); `newContent`
   * from the worktree file (empty when deleted); `hunks` from the per-file patch.
   */
  async fileDiff(workspaceId: string, path: string): Promise<FileDiff> {
    const { wt, workspace } = await this.resolveWorktree(workspaceId);
    const { relPath, abs } = this.confine(wt, path);
    const base = await this.mergeBaseWithFallback(wt, workspace.baseBranch);

    // Old side: the file's content at `base`. A new file (absent at base) makes
    // `git show` exit non-zero — that is expected, surface it as empty.
    let oldContent = '';
    try {
      // `stripFinalNewline: false` — execa strips a trailing newline by default, which
      // would desync `oldContent` (git show) from `newContent` (fs.readFile, verbatim)
      // and render a phantom "no newline at EOF" diff for any unchanged file tail.
      const res = await execa('git', ['-C', wt, 'show', `${base}:${relPath}`], {
        stripFinalNewline: false,
      });
      oldContent = res.stdout;
    } catch {
      oldContent = '';
    }

    // New side: the worktree file (empty when the file was deleted).
    let newContent = '';
    try {
      newContent = await readFile(abs, 'utf8');
    } catch {
      newContent = '';
    }

    // Hunks: the per-file unified patch (`git diff <base> -- <path>`), parsed with the
    // shared pure helper. A failure (e.g. path not in the diff) yields no hunks.
    let patch = '';
    try {
      const res = await execa('git', ['-C', wt, 'diff', base, '--', relPath]);
      patch = res.stdout;
    } catch {
      patch = '';
    }

    return {
      path: relPath,
      oldContent,
      newContent,
      hunks: parseUnifiedHunks(patch),
    };
  }

  /**
   * The commits in `base..HEAD` for the viewer's commit filter (`diff:commits`).
   * Empty array when there are none (or the log fails on an unborn branch).
   */
  async commits(workspaceId: string): Promise<CommitInfo[]> {
    const { wt, workspace } = await this.resolveWorktree(workspaceId);
    const base = await this.mergeBaseWithFallback(wt, workspace.baseBranch);

    // Field-separate with \x1f and record-separate with \x1e so subjects/authors may
    // contain any other whitespace without ambiguating the parse.
    const format = ['%H', '%h', '%s', '%an', '%ct'].join('%x1f');
    let stdout = '';
    try {
      const res = await execa('git', [
        '-C',
        wt,
        'log',
        `${base}..HEAD`,
        `--pretty=format:${format}%x1e`,
      ]);
      stdout = res.stdout;
    } catch {
      return [];
    }

    const commits: CommitInfo[] = [];
    for (const record of stdout.split('\x1e')) {
      const line = record.replace(/^\n/, '');
      if (line.trim() === '') continue;
      const parts = line.split('\x1f');
      if (parts.length < 5) continue;
      commits.push({
        sha: parts[0],
        shortSha: parts[1],
        subject: parts[2],
        author: parts[3],
        // `%ct` is the committer date in UNIX seconds; the DTO carries epoch millis.
        date: (parseInt(parts[4], 10) || 0) * 1000,
      });
    }
    return commits;
  }

  /**
   * Start (or reuse) a debounced FS watcher for the workspace's worktree; emits
   * `diff:changed { workspaceId }` after coalescing a burst of changes (spec §5.3).
   *
   * The public signature is synchronous (frozen), but resolving the worktree path is
   * async — so the entry is registered synchronously and chokidar is attached once the
   * workspace resolves. Idempotent: a second call for the same workspace returns the
   * existing handle. `stop()` closes the watcher and drops the entry.
   */
  watch(workspaceId: string): DiffWatchHandle {
    const existing = this.watchers.get(workspaceId);
    if (existing !== undefined) return existing.handle;

    let watcher: FSWatcher | null = null;
    let stopped = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const fire = (): void => {
      if (stopped) return;
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        if (stopped) return;
        // Recompute lazily next `getDiff`; notify the renderer to refetch.
        this.invalidate(workspaceId);
        this.deps.emit('diff:changed', { workspaceId });
      }, WATCH_DEBOUNCE_MS);
    };

    const handle: DiffWatchHandle = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (debounce !== null) {
          clearTimeout(debounce);
          debounce = null;
        }
        if (watcher !== null) void watcher.close();
        this.watchers.delete(workspaceId);
      },
    };

    this.watchers.set(workspaceId, { handle });

    // Resolve the worktree path asynchronously, then attach chokidar. If the workspace
    // is missing/archived (or `stop()` already ran) we leave the inert entry so repeat
    // `watch()` calls stay idempotent; `stop()` still removes it.
    void this.resolveWorktree(workspaceId)
      .then(({ wt }) => {
        if (stopped) return;
        watcher = chokidarWatch(wt, {
          ignored: isIgnoredPath,
          ignoreInitial: true,
        });
        watcher.on('all', fire);
      })
      .catch(() => {
        /* worktree unavailable — watcher stays inert until stop() drops the entry. */
      });

    return handle;
  }

  /** Stop every workspace watcher (quit teardown). Safe to call repeatedly. */
  stopAll(): void {
    // Snapshot first — `stop()` mutates the map as it removes each entry.
    for (const entry of [...this.watchers.values()]) {
      entry.handle.stop();
    }
    this.watchers.clear();
  }

  /** Drop the cached diff for a workspace (watcher fire / turn end). */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  // -------------------------------------------------------------------------
  // Inline comments (delegate persistence to the DiffCommentsRepo)
  // -------------------------------------------------------------------------

  /** List inline comments for a workspace, optionally filtered by state. */
  async listComments(
    workspaceId: string,
    state?: DiffCommentState,
  ): Promise<DiffComment[]> {
    return this.deps.comments.list(workspaceId, state);
  }

  /** Create an inline comment (starts in `open` state). */
  async addComment(comment: NewDiffComment): Promise<DiffComment> {
    return this.deps.comments.create(comment);
  }

  /** Transition a comment's state (open→sent when sent to the agent, →resolved). */
  async setCommentState(
    commentId: string,
    state: DiffCommentState,
  ): Promise<void> {
    return this.deps.comments.setState(commentId, state);
  }

  /** Delete an inline comment permanently. */
  async removeComment(commentId: string): Promise<void> {
    return this.deps.comments.remove(commentId);
  }

  /**
   * Build the `diff_comment` attachments for every `open` comment and mark those
   * comments `sent` (spec §5.3). The frozen `diff_comment` {@link Attachment} requires
   * a non-null line range + side + a non-empty `excerpt` string; a comment without a
   * resolvable range or excerpt is SKIPPED (left `open`) rather than emitting a
   * shape-violating attachment.
   */
  async buildSendToAgent(workspaceId: string): Promise<SendToAgentResult> {
    const open = await this.deps.comments.list(workspaceId, 'open');
    const attachments: Attachment[] = [];
    // Reuse one FileDiff per file across comments on the same file.
    const fileDiffCache = new Map<string, FileDiff | null>();

    for (const comment of open) {
      // Frozen shape needs a concrete range + side — skip file-level comments.
      if (
        comment.lineStart === null ||
        comment.lineEnd === null ||
        comment.side === null
      ) {
        continue;
      }

      let fileDiff = fileDiffCache.get(comment.filePath);
      if (fileDiff === undefined) {
        try {
          fileDiff = await this.fileDiff(workspaceId, comment.filePath);
        } catch {
          fileDiff = null;
        }
        fileDiffCache.set(comment.filePath, fileDiff);
      }
      if (fileDiff === null) continue;

      const excerpt = this.excerptFor(
        fileDiff,
        comment.lineStart,
        comment.lineEnd,
        comment.side,
      );
      // Never emit an empty/undefined excerpt — the frozen shape requires a string.
      if (excerpt === '') continue;

      attachments.push({
        type: 'diff_comment',
        file: comment.filePath,
        lineStart: comment.lineStart,
        lineEnd: comment.lineEnd,
        side: comment.side,
        excerpt,
        body: comment.body,
      });
      await this.deps.comments.setState(comment.id, 'sent');
    }

    return { attachments };
  }

  /**
   * Best-effort auto-resolve of `sent` comments whose anchored lines are no longer
   * part of the pending diff (spec §5.3).
   *
   * CONSERVATIVE HEURISTIC (ticket §8 — auto-resolve can mis-fire): we do NOT store the
   * file content at send-time, so we cannot detect an in-place edit precisely. The one
   * unambiguous "what you commented on is gone" signal is that the comment's line range
   * on its side is no longer covered by ANY hunk in the fresh diff (the region now
   * matches base — the change was incorporated or reverted). Only then do we flip
   * `sent`→`resolved`. This deliberately prefers FALSE NEGATIVES (a still-changing
   * region stays `sent`); users can re-open. A file we cannot diff is left untouched.
   */
  async reconcileComments(workspaceId: string): Promise<void> {
    const sent = await this.deps.comments.list(workspaceId, 'sent');
    const fileDiffCache = new Map<string, FileDiff | null>();

    for (const comment of sent) {
      if (
        comment.lineStart === null ||
        comment.lineEnd === null ||
        comment.side === null
      ) {
        continue;
      }

      let fileDiff = fileDiffCache.get(comment.filePath);
      if (fileDiff === undefined) {
        try {
          fileDiff = await this.fileDiff(workspaceId, comment.filePath);
        } catch {
          fileDiff = null;
        }
        fileDiffCache.set(comment.filePath, fileDiff);
      }
      if (fileDiff === null) continue; // cannot evaluate → leave as-is (conservative).

      const stillPending = this.rangeCoveredByHunks(
        fileDiff.hunks,
        comment.lineStart,
        comment.lineEnd,
        comment.side,
      );
      if (!stillPending) {
        await this.deps.comments.setState(comment.id, 'resolved');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Resolve a workspace to its worktree path, mirroring register.ts error codes. */
  private async resolveWorktree(
    workspaceId: string,
  ): Promise<{ wt: string; workspace: Workspace }> {
    const workspace = await this.deps.getWorkspace(workspaceId);
    if (workspace === null) {
      throw new AppError('not_found', 'workspace not found', { workspaceId });
    }
    if (!workspace.worktreePath) {
      throw new AppError('conflict', 'workspace has no worktree (archived?)', {
        workspaceId,
      });
    }
    return { wt: workspace.worktreePath, workspace };
  }

  /**
   * `merge-base(HEAD, origin/<base>)`, falling back to the local `<base>` branch when
   * there is no `origin` remote (e.g. a purely local repo, as in the test harness).
   */
  private async mergeBaseWithFallback(
    wt: string,
    baseBranch: string,
  ): Promise<string> {
    try {
      return await this.deps.git.mergeBase(wt, 'HEAD', `origin/${baseBranch}`);
    } catch {
      return await this.deps.git.mergeBase(wt, 'HEAD', baseBranch);
    }
  }

  /** `git rev-parse HEAD`, or `''` on an unborn branch (still a valid cache key). */
  private async headSha(wt: string): Promise<string> {
    try {
      const res = await execa('git', ['-C', wt, 'rev-parse', 'HEAD']);
      return res.stdout.trim();
    } catch {
      return '';
    }
  }

  /**
   * Append an `added` {@link DiffFile} for every untracked file `git diff` omitted.
   * `additions` = the file's line count (binary — NUL byte — or unreadable → 0). The
   * path is confined defensively even though it originates from trusted git output.
   */
  private async surfaceUntracked(
    wt: string,
    gitDiff: GitDiff,
    status: Awaited<ReturnType<GitService['status']>>,
  ): Promise<GitDiff> {
    const known = new Set(gitDiff.files.map((f) => f.path));
    const extra: GitDiff['files'] = [];

    for (const entry of status.files) {
      if (entry.status !== 'untracked' || known.has(entry.path)) continue;

      let additions = 0;
      try {
        const { abs } = this.confine(wt, entry.path);
        const content = await readFile(abs, 'utf8');
        additions = content.includes('\u0000') ? 0 : countLines(content);
      } catch {
        // Binary, unreadable, or an unexpected path — count nothing rather than fail.
        additions = 0;
      }

      extra.push({
        path: entry.path,
        oldPath: null,
        change: 'added',
        additions,
        deletions: 0,
      });
    }

    if (extra.length === 0) return gitDiff;
    return { ...gitDiff, files: [...gitDiff.files, ...extra] };
  }

  /**
   * Validate + confine an UNTRUSTED path to the worktree root. Rejects empty, absolute,
   * and `..`-escaping paths (path traversal) BEFORE any git/fs access. Returns the
   * worktree-relative path (POSIX separators, for git pathspecs) and its absolute path.
   */
  private confine(
    wt: string,
    inputPath: string,
  ): { relPath: string; abs: string } {
    if (typeof inputPath !== 'string' || inputPath.trim() === '') {
      throw new AppError(
        'invalid_input',
        'file path must be a non-empty string',
        {},
      );
    }
    if (isAbsolute(inputPath)) {
      throw new AppError(
        'invalid_input',
        `absolute path not allowed: ${inputPath}`,
        {
          path: inputPath,
        },
      );
    }

    const root = resolve(wt);
    const abs = resolve(root, inputPath);
    // A resolved path must be the root itself or strictly inside it.
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new AppError(
        'invalid_input',
        `path escapes worktree root: ${inputPath}`,
        {
          path: inputPath,
        },
      );
    }

    const rel = relative(root, abs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new AppError(
        'invalid_input',
        `path escapes worktree root: ${inputPath}`,
        {
          path: inputPath,
        },
      );
    }

    // git pathspecs want POSIX separators regardless of host OS.
    return { relPath: rel.split(sep).join('/'), abs };
  }

  /**
   * Resolve the excerpt text for a comment's line range. Prefers the actual hunk lines
   * (what the reviewer saw in the diff); falls back to a slice of the file content on
   * the relevant side. Returns `''` when neither yields text — the caller then skips
   * the comment rather than emitting an empty excerpt.
   */
  private excerptFor(
    fileDiff: FileDiff,
    lineStart: number,
    lineEnd: number,
    side: 'old' | 'new',
  ): string {
    const fromHunks = this.excerptFromHunks(
      fileDiff.hunks,
      lineStart,
      lineEnd,
      side,
    );
    if (fromHunks.trim() !== '') return fromHunks;

    // Fallback: slice the side's full content by 1-based inclusive line numbers.
    const source = side === 'old' ? fileDiff.oldContent : fileDiff.newContent;
    if (source === '') return '';
    const lines = source.split('\n');
    const start = Math.max(1, lineStart);
    const end = Math.max(start, lineEnd);
    const text = lines.slice(start - 1, end).join('\n');
    return text.trim() === '' ? '' : text;
  }

  /**
   * Pull the lines within `[lineStart, lineEnd]` (1-based, inclusive) on `side` out of
   * the parsed hunks, tracking each side's running line number. Context lines count on
   * both sides; `+` advances only the new side, `-` only the old side; the git
   * "\ No newline" marker is skipped.
   */
  private excerptFromHunks(
    hunks: FileDiff['hunks'],
    lineStart: number,
    lineEnd: number,
    side: 'old' | 'new',
  ): string {
    const collected: string[] = [];

    for (const hunk of hunks) {
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      for (const raw of hunk.lines) {
        const marker = raw.length > 0 ? raw[0] : ' ';
        if (marker === '\\') continue; // "\ No newline at end of file"
        const text = raw.slice(1);

        if (marker === '+') {
          if (side === 'new' && newNo >= lineStart && newNo <= lineEnd) {
            collected.push(text);
          }
          newNo += 1;
        } else if (marker === '-') {
          if (side === 'old' && oldNo >= lineStart && oldNo <= lineEnd) {
            collected.push(text);
          }
          oldNo += 1;
        } else {
          // Context line: present on both sides.
          const no = side === 'new' ? newNo : oldNo;
          if (no >= lineStart && no <= lineEnd) collected.push(text);
          oldNo += 1;
          newNo += 1;
        }
      }
    }

    return collected.join('\n');
  }

  /**
   * True when some hunk's range on `side` intersects `[lineStart, lineEnd]` — i.e. the
   * commented region is still part of the pending diff. Used by the conservative
   * reconcile heuristic (a comment resolves only when this becomes false).
   */
  private rangeCoveredByHunks(
    hunks: FileDiff['hunks'],
    lineStart: number,
    lineEnd: number,
    side: 'old' | 'new',
  ): boolean {
    for (const hunk of hunks) {
      const start = side === 'new' ? hunk.newStart : hunk.oldStart;
      const len = side === 'new' ? hunk.newLines : hunk.oldLines;
      const end = start + Math.max(len, 1) - 1;
      // Half-open-safe inclusive intersection test.
      if (lineStart <= end && lineEnd >= start) return true;
    }
    return false;
  }
}
