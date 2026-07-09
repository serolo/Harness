// Renderer-side diff store (Zustand) — per-workspace diff data: the file list, the
// selected file + its (lazily fetched) content, commit history for the commit filter,
// and the inline review comments. Mirrors `stores/chat.ts`'s per-workspace Record shape.
//
// DTO types come from the FROZEN shared contract (@shared/review); never redeclare them.

import { create } from 'zustand';
import type {
  CommitInfo,
  DiffComment,
  DiffSet,
  FileDiff,
} from '@shared/review';

export interface DiffState {
  /** The current `DiffSet` (file list + refs) per workspace. */
  diffSetByWorkspace: Record<string, DiffSet>;
  /** The selected file path per workspace (drives the `DiffView`). */
  selectedPathByWorkspace: Record<string, string | null>;
  /** Lazily-fetched per-file content, cached by path, per workspace. */
  fileDiffCacheByWorkspace: Record<string, Record<string, FileDiff>>;
  /** `base..HEAD` commit history per workspace, for the commit filter. */
  commitsByWorkspace: Record<string, CommitInfo[]>;
  /** The selected commit filter (a sha, or `null` for the full range) per workspace. */
  commitFilterByWorkspace: Record<string, string | null>;
  /** Inline review comments per workspace. */
  commentsByWorkspace: Record<string, DiffComment[]>;
  /**
   * Client-side-only flag: an "Agent review" turn was just kicked off, for annotation
   * styling in the transcript later (decision 2). Not persisted / not sent to main.
   */
  reviewPendingByWorkspace: Record<string, boolean>;

  /** Replace a workspace's `DiffSet` (from `diff:get`). */
  setDiffSet: (workspaceId: string, diffSet: DiffSet) => void;
  /** Select (or clear) the active file path for a workspace. */
  setSelectedPath: (workspaceId: string, path: string | null) => void;
  /** Cache a lazily-fetched `FileDiff` (from `diff:file`). */
  setFileDiff: (workspaceId: string, path: string, fileDiff: FileDiff) => void;
  /** Replace a workspace's commit history (from `diff:commits`). */
  setCommits: (workspaceId: string, commits: CommitInfo[]) => void;
  /** Set the selected commit filter (a sha, or `null` for the full range). */
  setCommitFilter: (workspaceId: string, sha: string | null) => void;
  /** Replace a workspace's comment list (from `comment:list`). */
  setComments: (workspaceId: string, comments: DiffComment[]) => void;
  /** Insert or update one comment (from `comment:create`). */
  upsertComment: (workspaceId: string, comment: DiffComment) => void;
  /** Mark one comment `resolved` in place (after `comment:resolve` succeeds). */
  markCommentResolved: (workspaceId: string, commentId: string) => void;
  /** Drop one comment from the list (after `comment:remove` succeeds). */
  removeComment: (workspaceId: string, commentId: string) => void;
  /** Set the review-pending annotation flag for a workspace. */
  setReviewPending: (workspaceId: string, pending: boolean) => void;
  /** Clear all of a workspace's diff state (e.g. on workspace archive). */
  reset: (workspaceId: string) => void;
}

export const useDiffStore = create<DiffState>((set) => ({
  diffSetByWorkspace: {},
  selectedPathByWorkspace: {},
  fileDiffCacheByWorkspace: {},
  commitsByWorkspace: {},
  commitFilterByWorkspace: {},
  commentsByWorkspace: {},
  reviewPendingByWorkspace: {},

  setDiffSet: (workspaceId, diffSet) =>
    set((state) => ({
      diffSetByWorkspace: {
        ...state.diffSetByWorkspace,
        [workspaceId]: diffSet,
      },
    })),

  setSelectedPath: (workspaceId, path) =>
    set((state) => ({
      selectedPathByWorkspace: {
        ...state.selectedPathByWorkspace,
        [workspaceId]: path,
      },
    })),

  setFileDiff: (workspaceId, path, fileDiff) =>
    set((state) => {
      const cache = state.fileDiffCacheByWorkspace[workspaceId] ?? {};
      return {
        fileDiffCacheByWorkspace: {
          ...state.fileDiffCacheByWorkspace,
          [workspaceId]: { ...cache, [path]: fileDiff },
        },
      };
    }),

  setCommits: (workspaceId, commits) =>
    set((state) => ({
      commitsByWorkspace: {
        ...state.commitsByWorkspace,
        [workspaceId]: commits,
      },
    })),

  setCommitFilter: (workspaceId, sha) =>
    set((state) => ({
      commitFilterByWorkspace: {
        ...state.commitFilterByWorkspace,
        [workspaceId]: sha,
      },
    })),

  setComments: (workspaceId, comments) =>
    set((state) => ({
      commentsByWorkspace: {
        ...state.commentsByWorkspace,
        [workspaceId]: comments,
      },
    })),

  upsertComment: (workspaceId, comment) =>
    set((state) => {
      const comments = state.commentsByWorkspace[workspaceId] ?? [];
      const idx = comments.findIndex((c) => c.id === comment.id);
      const next =
        idx === -1
          ? [...comments, comment]
          : comments.map((c) => (c.id === comment.id ? comment : c));
      return {
        commentsByWorkspace: {
          ...state.commentsByWorkspace,
          [workspaceId]: next,
        },
      };
    }),

  markCommentResolved: (workspaceId, commentId) =>
    set((state) => {
      const comments = state.commentsByWorkspace[workspaceId] ?? [];
      const next = comments.map((c) =>
        c.id === commentId ? { ...c, state: 'resolved' as const } : c,
      );
      return {
        commentsByWorkspace: {
          ...state.commentsByWorkspace,
          [workspaceId]: next,
        },
      };
    }),

  removeComment: (workspaceId, commentId) =>
    set((state) => {
      const comments = state.commentsByWorkspace[workspaceId] ?? [];
      return {
        commentsByWorkspace: {
          ...state.commentsByWorkspace,
          [workspaceId]: comments.filter((c) => c.id !== commentId),
        },
      };
    }),

  setReviewPending: (workspaceId, pending) =>
    set((state) => ({
      reviewPendingByWorkspace: {
        ...state.reviewPendingByWorkspace,
        [workspaceId]: pending,
      },
    })),

  reset: (workspaceId) =>
    set((state) => {
      const diffSetByWorkspace = { ...state.diffSetByWorkspace };
      const selectedPathByWorkspace = { ...state.selectedPathByWorkspace };
      const fileDiffCacheByWorkspace = { ...state.fileDiffCacheByWorkspace };
      const commitsByWorkspace = { ...state.commitsByWorkspace };
      const commitFilterByWorkspace = { ...state.commitFilterByWorkspace };
      const commentsByWorkspace = { ...state.commentsByWorkspace };
      const reviewPendingByWorkspace = { ...state.reviewPendingByWorkspace };
      delete diffSetByWorkspace[workspaceId];
      delete selectedPathByWorkspace[workspaceId];
      delete fileDiffCacheByWorkspace[workspaceId];
      delete commitsByWorkspace[workspaceId];
      delete commitFilterByWorkspace[workspaceId];
      delete commentsByWorkspace[workspaceId];
      delete reviewPendingByWorkspace[workspaceId];
      return {
        diffSetByWorkspace,
        selectedPathByWorkspace,
        fileDiffCacheByWorkspace,
        commitsByWorkspace,
        commitFilterByWorkspace,
        commentsByWorkspace,
        reviewPendingByWorkspace,
      };
    }),
}));
