// DiffService — computes a workspace's diff (worktree vs merge-base(HEAD,
// origin/<base>)), recomputed on debounced FS events + after each turn, and owns
// the inline diff-comment lifecycle (spec §5.3). Emits `diff:changed` when the
// status monitor observes a change. Implemented in Phase 4.
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
// filesystem read; git only ever runs through GitService or the shared gitExeca
// argument-array helper.

import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { AppError } from '@shared/errors';
import type { Attachment } from '@shared/harness';
import type { EventChannel, EventPayload } from '@shared/ipc';
import type { Workspace } from '@shared/models';
import type {
  CommitInfo,
  DiffComment,
  DiffCommentState,
  DiffMenuInfo,
  DiffQuery,
  FileDiff,
  NewDiffComment,
  SendToAgentResult,
} from '@shared/review';

import type { DiffCommentsRepo } from '../db/repos/comments';
import {
  gitExeca,
  parseUnifiedHunks,
  type GitDiff,
  type GitService,
  type GitStatus,
} from '../git';

// The inline-comment DTOs now live in the shared contract; re-export so callers
// (register.ts, tests) keep importing them from `../diff` as they did off the stub.
export type {
  DiffComment,
  NewDiffComment,
  DiffCommentState,
} from '@shared/review';

/** Disposes a diff change-monitor subscription (README §6.2 stream teardown). */
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
  /** Test seam for the status-monitor cadence. Production defaults to one second. */
  watchIntervalMs?: number;
}

/** One cached diff computation, keyed on the workspace's `(base, HEAD, status)` signature. */
interface DiffCacheEntry {
  key: string;
  value: GitDiff;
}

/** A live Git-status monitor entry for a workspace (idempotent per workspace). */
interface WatcherEntry {
  handle: DiffWatchHandle;
  lastUsedAt: number;
}

/** Debounce window coalescing editor save-storms into a single recompute + emit. */
const WATCH_INTERVAL_MS = 1_000;
/** Keep monitoring bounded when users visit many workspaces during one app session. */
const MAX_ACTIVE_WATCHERS = 4;

/**
 * Count the lines in a file's text content (used for an untracked file's `additions`
 * stat). An empty file is 0; a trailing newline does not count as an extra line.
 */
function countLines(content: string): number {
  if (content === '') return 0;
  const parts = content.split('\n').length;
  return content.endsWith('\n') ? parts - 1 : parts;
}

/** Build a minimal added-file hunk for content Git cannot diff itself (untracked files). */
function addedFileHunks(content: string): FileDiff['hunks'] {
  const lines =
    content === ''
      ? []
      : content
          .split('\n')
          .slice(0, content.endsWith('\n') ? -1 : undefined)
          .map((line) => `+${line}`);
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: lines.length > 0 ? 1 : 0,
      newLines: lines.length,
      lines,
    },
  ];
}

/**
 * Computes diffs and manages inline comments per workspace. One instance is shared
 * via `AppContext`. The service is otherwise stateless apart from a single-slot
 * per-workspace diff cache and its bounded Git-status monitors.
 */
export class DiffService {
  /** Per-workspace single-slot diff cache; invalidated on status change / turn end. */
  private readonly cache = new Map<string, DiffCacheEntry>();

  /** Per-workspace Git-status monitor (idempotent and bounded by LRU). */
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
   * cached under a `(base, HEAD sha, status signature)` key and the change monitor is
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
      // Ensure the monitor exists even on a cache hit (first hit may precede it).
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
      const res = await gitExeca(['-C', wt, 'show', `${base}:${relPath}`], {
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
      const res = await gitExeca(['-C', wt, 'diff', base, '--', relPath]);
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

    return this.commitsFromBase(wt, base);
  }

  /** Build the branch/scope menu from refs and status inside this workspace only. */
  async menu(
    workspaceId: string,
    requestedTargetRef?: string,
  ): Promise<DiffMenuInfo> {
    const { wt, workspace } = await this.resolveWorktree(workspaceId);
    const branches = await this.deps.git.listBranches(wt);
    let targetRef = requestedTargetRef;
    if (targetRef === undefined) {
      const upstream = await this.deps.git.upstreamBranch(wt);
      targetRef =
        upstream !== null && branches.includes(upstream)
          ? upstream
          : this.defaultTargetRef(workspace.baseBranch, branches);
    }
    this.assertTargetRef(targetRef, branches);
    this.watch(workspaceId);

    const [status, base, comparison] = await Promise.all([
      this.deps.git.status(wt),
      this.deps.git.mergeBase(wt, 'HEAD', targetRef),
      this.deps.git.headInfo(wt, targetRef),
    ]);
    const commits = await this.commitsFromBase(wt, base);

    return {
      currentBranch: status.branch ?? 'HEAD',
      targetRef,
      branches,
      commits,
      uncommittedFileCount: status.files.length,
      behind: status.behind,
      comparisonBehind: comparison.behind,
    };
  }

  /** Compute All, Uncommitted, or one allowlisted commit for the changes list. */
  async getDiffForQuery(query: DiffQuery): Promise<GitDiff> {
    const { wt } = await this.resolveWorktree(query.workspaceId);
    const branches = await this.deps.git.listBranches(wt);
    this.assertTargetRef(query.targetRef, branches);
    this.watch(query.workspaceId);

    if (query.scope.kind === 'uncommitted') {
      const [gitDiff, status] = await Promise.all([
        this.deps.git.diff(wt, 'HEAD'),
        this.deps.git.status(wt),
      ]);
      // Make the scope definition explicit: only paths currently reported by status
      // belong here. This excludes every already-committed target..HEAD change even if
      // another diff implementation starts returning a broader range in the future.
      const pendingPaths = new Set(status.files.map((file) => file.path));
      const pendingTracked = {
        ...gitDiff,
        files: gitDiff.files.filter((file) => pendingPaths.has(file.path)),
      };
      return this.surfaceUntracked(wt, pendingTracked, status);
    }

    const base = await this.deps.git.mergeBase(wt, 'HEAD', query.targetRef);
    if (query.scope.kind === 'all') {
      const [gitDiff, status] = await Promise.all([
        this.deps.git.diff(wt, base),
        this.deps.git.status(wt),
      ]);
      return this.surfaceUntracked(wt, gitDiff, status);
    }

    const commits = await this.commitsFromBase(wt, base);
    this.assertCommit(query.scope.sha, commits);
    return this.deps.git.diffBetween(
      wt,
      `${query.scope.sha}^`,
      query.scope.sha,
    );
  }

  /** Fetch file contents for the exact comparison represented by a Git menu query. */
  async fileDiffForQuery(query: DiffQuery, path: string): Promise<FileDiff> {
    const { wt } = await this.resolveWorktree(query.workspaceId);
    const { relPath, abs } = this.confine(wt, path);
    const gitDiff = await this.getDiffForQuery(query);
    const entry = gitDiff.files.find((file) => file.path === relPath);
    const oldPath = entry?.oldPath ?? relPath;
    const committedHead =
      query.scope.kind === 'commit' ? query.scope.sha : null;

    const oldContent = await this.readFileAtRef(wt, gitDiff.baseRef, oldPath);
    let newContent = '';
    if (committedHead) {
      newContent = await this.readFileAtRef(wt, committedHead, relPath);
    } else {
      try {
        newContent = await readFile(abs, 'utf8');
      } catch {
        newContent = '';
      }
    }

    const pathspecs = oldPath === relPath ? [relPath] : [oldPath, relPath];
    const args = ['-C', wt, 'diff', gitDiff.baseRef];
    if (committedHead) args.push(committedHead);
    args.push('--', ...pathspecs);
    let patch = '';
    try {
      const res = await gitExeca(args);
      patch = res.stdout;
    } catch {
      patch = '';
    }

    return {
      path: relPath,
      oldContent,
      newContent,
      hunks:
        query.scope.kind === 'uncommitted' &&
        entry?.change === 'added' &&
        oldContent === '' &&
        patch === ''
          ? addedFileHunks(newContent)
          : parseUnifiedHunks(patch),
    };
  }

  /** Parse commits in `<base>..HEAD`, newest first. */
  private async commitsFromBase(
    wt: string,
    base: string,
  ): Promise<CommitInfo[]> {
    // Field-separate with \x1f and record-separate with \x1e so subjects/authors may
    // contain any other whitespace without ambiguating the parse.
    const format = ['%H', '%h', '%s', '%an', '%ct'].join('%x1f');
    let stdout = '';
    try {
      const res = await gitExeca([
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
   * Start (or reuse) a bounded Git-status monitor for the workspace's worktree; emits
   * `diff:changed { workspaceId }` when the porcelain signature changes (spec §5.3).
   *
   * The public signature is synchronous (frozen), but resolving the worktree path is
   * async — so the entry is registered synchronously and polling begins once the
   * workspace resolves. Idempotent: a second call for the same workspace returns the
   * existing handle. `stop()` cancels the timer and drops the entry.
   */
  watch(workspaceId: string): DiffWatchHandle {
    const existing = this.watchers.get(workspaceId);
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now();
      return existing.handle;
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let previousSignature: string | null = null;
    const intervalMs = this.deps.watchIntervalMs ?? WATCH_INTERVAL_MS;

    const handle: DiffWatchHandle = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        this.watchers.delete(workspaceId);
      },
    };

    this.watchers.set(workspaceId, { handle, lastUsedAt: Date.now() });
    this.enforceWatcherLimit(workspaceId);

    // Recursive fs.watch allocates a persistent descriptor per directory and can exhaust
    // the process limit in large repositories. Poll Git's bounded porcelain status
    // instead. Self-scheduling after each result prevents overlapping Git processes.
    void this.resolveWorktree(workspaceId)
      .then(({ wt }) => {
        if (stopped) return;
        const poll = async (): Promise<void> => {
          if (stopped) return;
          try {
            const status = await this.deps.git.status(wt);
            const signature = await this.statusSignature(wt, status);
            if (previousSignature !== null && signature !== previousSignature) {
              this.invalidate(workspaceId);
              this.deps.emit('diff:changed', { workspaceId });
            }
            previousSignature = signature;
          } catch {
            // A temporarily unavailable checkout must not become an unhandled rejection.
            // The next bounded poll retries; archive/shutdown explicitly stops monitors.
          }
          if (!stopped) timer = setTimeout(() => void poll(), intervalMs);
        };
        void poll();
      })
      .catch(() => {
        /* worktree unavailable — monitor stays inert until stop() drops the entry. */
      });

    return handle;
  }

  /** Stop the least-recently-used monitor before the bounded set can grow. */
  private enforceWatcherLimit(currentWorkspaceId: string): void {
    if (this.watchers.size <= MAX_ACTIVE_WATCHERS) return;
    const oldest = [...this.watchers.entries()]
      .filter(([workspaceId]) => workspaceId !== currentWorkspaceId)
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0];
    oldest?.[1].handle.stop();
  }

  /**
   * Fingerprint porcelain state plus metadata for only Git-reported changed paths.
   * Porcelain alone stays identical while an already-dirty file is edited; lstat keeps
   * that case observable without following symlinks or traversing every repository file.
   */
  private async statusSignature(
    wt: string,
    status: GitStatus,
  ): Promise<string> {
    const files = await Promise.all(
      status.files.map(async (file) => {
        let metadata = 'missing';
        try {
          const { abs } = this.confine(wt, file.path);
          const info = await lstat(abs);
          metadata = `${info.size}:${info.mtimeMs}`;
        } catch {
          // Deleted paths and a concurrent rename legitimately have no current lstat.
        }
        return `${file.status}:${file.staged ? 1 : 0}:${file.path}:${metadata}`;
      }),
    );
    return [status.branch ?? '', status.ahead, status.behind, ...files].join(
      '|',
    );
  }

  /** Stop every workspace monitor (quit teardown). Safe to call repeatedly. */
  stopAll(): void {
    // Snapshot first — `stop()` mutates the map as it removes each entry.
    for (const entry of [...this.watchers.values()]) {
      entry.handle.stop();
    }
    this.watchers.clear();
  }

  /** Drop the cached diff for a workspace (status change / turn end). */
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

  /** Resolve creation-time base metadata to an exact ref from Git's allowlist. */
  private defaultTargetRef(baseBranch: string, branches: string[]): string {
    // A workspace created from a remote branch persists the full ref (for example
    // `origin/qa/149`). Preserve it exactly instead of accidentally comparing against
    // the owning project's default branch.
    if (baseBranch.startsWith('origin/') && branches.includes(baseBranch)) {
      return baseBranch;
    }

    const remote = `origin/${baseBranch}`;
    if (branches.includes(remote)) return remote;
    if (branches.includes(baseBranch)) return baseBranch;
    return branches[0] ?? baseBranch;
  }

  /** Only refs discovered from `for-each-ref` may reach a query git command. */
  private assertTargetRef(targetRef: string, branches: string[]): void {
    if (
      typeof targetRef !== 'string' ||
      targetRef === '' ||
      !branches.includes(targetRef)
    ) {
      throw new AppError('invalid_input', 'unknown target branch', {
        targetRef,
      });
    }
  }

  /** A single-commit scope must be a commit in the selected target..HEAD range. */
  private assertCommit(sha: string, commits: CommitInfo[]): void {
    if (!/^[0-9a-f]{40}$/i.test(sha) || !commits.some((c) => c.sha === sha)) {
      throw new AppError(
        'invalid_input',
        'commit is outside the selected range',
        {
          sha,
        },
      );
    }
  }

  /** Read one repo-relative file at a validated ref; absent files become empty. */
  private async readFileAtRef(
    wt: string,
    ref: string,
    relPath: string,
  ): Promise<string> {
    try {
      const res = await gitExeca(['-C', wt, 'show', `${ref}:${relPath}`], {
        stripFinalNewline: false,
      });
      return res.stdout;
    } catch {
      return '';
    }
  }

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
      try {
        return await this.deps.git.mergeBase(wt, 'HEAD', baseBranch);
      } catch {
        return 'HEAD';
      }
    }
  }

  /** `git rev-parse HEAD`, or `''` on an unborn branch (still a valid cache key). */
  private async headSha(wt: string): Promise<string> {
    try {
      const res = await gitExeca(['-C', wt, 'rev-parse', 'HEAD']);
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
