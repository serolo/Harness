// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
// Phase 4 diff-review + checkpoint DTOs — the cross-boundary shapes for the diff
// viewer, inline comments, checkpoints, and todos (spec §3 / §5.3 / §5.4). Import-
// safe from both main and renderer: types + pure re-exports only, no `electron`,
// no Node-only (`fs`/`path`/…), no DOM-only imports.
//
// `DiffComment`/`Checkpoint` here are byte-identical (field names + types) to the
// Phase-0 stub declarations in `src/main/diff/index.ts` / `src/main/checkpoint/index.ts`
// — those modules re-export from here rather than redeclaring (Task 3). `GitDiff`/
// `DiffFile` stay main-only; the IPC handler maps `GitDiff` → `DiffSet` (Task 9).

import type { Attachment } from './harness';

/**
 * Lightweight diff summary for `diff:get`: files + refs, NO patch content — Monaco
 * fetches per-file old/new content lazily via `diff:file` (spec §9, keeps the list
 * payload small for monorepos).
 */
export interface DiffSet {
  baseRef: string;
  headRef: string;
  files: DiffFileEntry[];
}

/** One file's change summary within a `DiffSet` (no patch — see `DiffSet`). */
export interface DiffFileEntry {
  path: string;
  oldPath: string | null;
  change: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

/** Per-file old/new content + parsed hunks, fetched lazily via `diff:file`. */
export interface FileDiff {
  path: string;
  oldContent: string;
  newContent: string;
  hunks: DiffHunk[];
}

/** One parsed unified-diff hunk (spec §5.3 hunk-parse helper). */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Lifecycle of an inline diff comment (spec §3 `diff_comments.state`, §5.3). */
export type DiffCommentState = 'open' | 'sent' | 'resolved';

/**
 * An inline comment anchored to a diff line range (spec §5.3). Byte-identical to
 * `src/main/diff/index.ts`'s `DiffComment` — that module re-exports this type.
 */
export interface DiffComment {
  id: string;
  workspaceId: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  /** Which side of the diff the range refers to. */
  side: 'old' | 'new' | null;
  body: string;
  state: DiffCommentState;
  createdAt: number;
}

/** Input for creating a new inline comment (id/state/timestamp assigned in main). */
export interface NewDiffComment {
  workspaceId: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  side: 'old' | 'new' | null;
  body: string;
}

/** One commit in `base..HEAD`, for the diff viewer's commit filter (`diff:commits`). */
export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: number;
}

/**
 * A recorded checkpoint (spec §3 `checkpoints` table DTO). Byte-identical to
 * `src/main/checkpoint/index.ts`'s `Checkpoint` — that module re-exports this type.
 */
export interface Checkpoint {
  id: string;
  workspaceId: string;
  turnId: string;
  /** `refs/checkpoints/<workspace>/<turn-idx>`. */
  refName: string;
  /** The commit-tree SHA the ref points at. */
  sha: string;
  createdAt: number;
}

/** Input for creating a user-authored todo (`todo:create`). */
export interface TodoInput {
  workspaceId: string;
  body: string;
}

/**
 * Result of `comment:sendToAgent`: the built `diff_comment` attachments (frozen
 * shape, `@shared/harness`), ready to feed into the renderer's `sendTurn`.
 */
export interface SendToAgentResult {
  attachments: Attachment[];
}

/** Result of `review:run`: the composed review prompt, ready to feed into `sendTurn`. */
export interface ReviewPrompt {
  prompt: string;
}

// --- Git changes menu (APPEND-ONLY) -----------------------------------------

/** Which slice of the target-branch comparison the Git changes panel displays. */
export type DiffScope =
  { kind: 'all' } | { kind: 'uncommitted' } | { kind: 'commit'; sha: string };

/** A fully specified, workspace-confined Git comparison request. */
export interface DiffQuery {
  workspaceId: string;
  targetRef: string;
  scope: DiffScope;
}

/** Data needed to render the target-branch and change-scope menu. */
export interface DiffMenuInfo {
  currentBranch: string;
  targetRef: string;
  branches: string[];
  commits: CommitInfo[];
  uncommittedFileCount: number;
}
