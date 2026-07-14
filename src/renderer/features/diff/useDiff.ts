// useDiff — the diff feature's data hook. Bridges the FROZEN Phase-4 IPC channels
// (`diff:*`, `comment:*`, `review:run`) to the Zustand diff store: fetch the diff set +
// commit history + open comments on mount / workspace change, subscribe `diff:changed`
// to refetch, lazily fetch per-file content, and drive comment CRUD. All main access
// funnels through `@renderer/ipc` (README §10) — never `window.api`/`ipcRenderer`
// directly.
//
// "Send to agent" / "Agent review" reuse the chat feature's `useChat(workspaceId)` —
// they call the Phase-4 command, then feed the result into `sendTurn` so the reply
// streams into the SAME shared chat transcript the ChatPanel renders (mirrors the
// plan's "reuse useChat" instruction rather than re-implementing turn streaming here).

import { useCallback, useEffect, useState } from 'react';
import type {
  DiffComment,
  DiffMenuInfo,
  DiffScope,
  DiffSet,
  FileDiff,
  NewDiffComment,
} from '@shared/review';
import { invoke, onEvent } from '@renderer/ipc';
import { useDiffStore } from '@renderer/stores/diff';
import { useChat } from '@renderer/features/chat/useChat';

/** Stable empty references so store selectors don't loop on `?? []`. */
const EMPTY_COMMENTS: readonly DiffComment[] = [];

export interface UseDiff {
  diffSet: DiffSet | null;
  /** True while the initial `diff:get` for this workspace hasn't resolved yet. */
  loadingDiff: boolean;
  selectedPath: string | null;
  selectFile: (path: string | null) => void;
  fileDiff: FileDiff | null;
  /** True while the selected file's `diff:file` fetch is in flight / not yet cached. */
  loadingFileDiff: boolean;
  menuInfo: DiffMenuInfo | null;
  scope: DiffScope;
  setTargetRef: (targetRef: string) => Promise<void>;
  setScope: (scope: DiffScope) => void;
  comments: DiffComment[];
  openComments: DiffComment[];
  createComment: (input: Omit<NewDiffComment, 'workspaceId'>) => Promise<void>;
  resolveComment: (commentId: string) => Promise<void>;
  removeComment: (commentId: string) => Promise<void>;
  /** `comment:sendToAgent` → feed the returned attachments into `useChat().sendTurn`. */
  sendCommentsToAgent: () => Promise<void>;
  /** `review:run` → feed the composed prompt into `useChat().sendTurn`. */
  runReview: () => Promise<void>;
  /** Client-side "the last kicked-off turn was an agent review" annotation flag. */
  isReviewPending: boolean;
}

/**
 * Diff state + actions for one workspace. Hydrates the diff set / commits / comments on
 * mount / workspace change, subscribes `diff:changed` to refetch (unsubscribed on
 * cleanup — no listener leak), and lazily fetches the selected file's content.
 */
export function useDiff(workspaceId: string | null): UseDiff {
  const [menuInfo, setMenuInfo] = useState<DiffMenuInfo | null>(null);
  const [scope, setScopeState] = useState<DiffScope>({ kind: 'all' });
  const diffSet = useDiffStore((s) =>
    workspaceId ? (s.diffSetByWorkspace[workspaceId] ?? null) : null,
  );
  const selectedPath = useDiffStore((s) =>
    workspaceId ? (s.selectedPathByWorkspace[workspaceId] ?? null) : null,
  );
  const fileDiffCache = useDiffStore((s) =>
    workspaceId ? s.fileDiffCacheByWorkspace[workspaceId] : undefined,
  );
  const comments = useDiffStore((s) =>
    workspaceId
      ? (s.commentsByWorkspace[workspaceId] ?? EMPTY_COMMENTS)
      : EMPTY_COMMENTS,
  ) as DiffComment[];
  const isReviewPending = useDiffStore((s) =>
    workspaceId ? (s.reviewPendingByWorkspace[workspaceId] ?? false) : false,
  );

  const setDiffSet = useDiffStore((s) => s.setDiffSet);
  const setSelectedPathAction = useDiffStore((s) => s.setSelectedPath);
  const setFileDiffAction = useDiffStore((s) => s.setFileDiff);
  const clearFileDiffs = useDiffStore((s) => s.clearFileDiffs);
  const setComments = useDiffStore((s) => s.setComments);
  const upsertComment = useDiffStore((s) => s.upsertComment);
  const markCommentResolved = useDiffStore((s) => s.markCommentResolved);
  const removeCommentAction = useDiffStore((s) => s.removeComment);
  const setReviewPending = useDiffStore((s) => s.setReviewPending);

  const { sendTurn } = useChat(workspaceId);

  // Hydrate menu metadata + comments on mount. Older main processes that do not expose
  // the appended menu channel safely fall back to the frozen default diff command.
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    setMenuInfo(null);
    setScopeState({ kind: 'all' });

    void invoke('diff:menu', { workspaceId })
      .then((res) => {
        if (typeof res?.targetRef !== 'string') {
          throw new Error('diff:menu unavailable');
        }
        if (active) setMenuInfo(res);
      })
      .catch(() =>
        invoke('diff:get', { workspaceId })
          .then((res) => {
            if (active) setDiffSet(workspaceId, res);
          })
          .catch(() => {
            /* surfaced via the empty-state UI */
          }),
      );
    void invoke('comment:list', { workspaceId })
      .then((res) => {
        if (active) setComments(workspaceId, res);
      })
      .catch(() => {
        /* comment rail just stays empty */
      });

    return () => {
      active = false;
    };
  }, [workspaceId, setDiffSet, setComments]);

  // The selected target/scope is a complete comparison query. Re-run it whenever a
  // menu choice changes and whenever the workspace watcher reports new filesystem data.
  useEffect(() => {
    if (!workspaceId || !menuInfo) return;
    let active = true;
    const load = (): void => {
      void invoke('diff:query', {
        workspaceId,
        targetRef: menuInfo.targetRef,
        scope,
      })
        .then((res) => {
          if (active) setDiffSet(workspaceId, res);
        })
        .catch(() => {
          /* retain the last successful list */
        });
    };
    load();
    const unsubscribe = onEvent('diff:changed', (payload) => {
      if (payload.workspaceId !== workspaceId) return;
      load();
      void invoke('diff:menu', {
        workspaceId,
        targetRef: menuInfo.targetRef,
      })
        .then((res) => {
          if (active) setMenuInfo(res);
        })
        .catch(() => {
          /* Counts can stay stale until the next successful watcher refresh. */
        });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspaceId, menuInfo?.targetRef, scope, setDiffSet]);

  // Lazily fetch the selected file's old/new content + hunks (skip if already cached).
  useEffect(() => {
    if (!workspaceId || !selectedPath) return;
    if (fileDiffCache?.[selectedPath]) return;
    let active = true;
    const request = menuInfo
      ? invoke('diff:fileQuery', {
          workspaceId,
          targetRef: menuInfo.targetRef,
          scope,
          path: selectedPath,
        })
      : invoke('diff:file', { workspaceId, path: selectedPath });
    void request
      .then((res) => {
        if (active) setFileDiffAction(workspaceId, selectedPath, res);
      })
      .catch(() => {
        /* DiffView's loading guard just keeps showing "Loading…" */
      });
    return () => {
      active = false;
    };
  }, [
    workspaceId,
    selectedPath,
    fileDiffCache,
    menuInfo?.targetRef,
    scope,
    setFileDiffAction,
  ]);

  const selectFile = useCallback(
    (path: string | null) => {
      if (!workspaceId) return;
      setSelectedPathAction(workspaceId, path);
    },
    [workspaceId, setSelectedPathAction],
  );

  const setTargetRef = useCallback(
    async (targetRef: string): Promise<void> => {
      if (!workspaceId) return;
      const next = await invoke('diff:menu', { workspaceId, targetRef });
      clearFileDiffs(workspaceId);
      setSelectedPathAction(workspaceId, null);
      setScopeState({ kind: 'all' });
      setMenuInfo(next);
    },
    [workspaceId, clearFileDiffs, setSelectedPathAction],
  );

  const setScope = useCallback(
    (nextScope: DiffScope): void => {
      if (!workspaceId) return;
      clearFileDiffs(workspaceId);
      setSelectedPathAction(workspaceId, null);
      setScopeState(nextScope);
    },
    [workspaceId, clearFileDiffs, setSelectedPathAction],
  );

  const createComment = useCallback(
    async (input: Omit<NewDiffComment, 'workspaceId'>): Promise<void> => {
      if (!workspaceId) return;
      const comment = await invoke('comment:create', { workspaceId, ...input });
      upsertComment(workspaceId, comment);
    },
    [workspaceId, upsertComment],
  );

  const resolveComment = useCallback(
    async (commentId: string): Promise<void> => {
      await invoke('comment:resolve', { commentId });
      if (workspaceId) markCommentResolved(workspaceId, commentId);
    },
    [workspaceId, markCommentResolved],
  );

  const removeComment = useCallback(
    async (commentId: string): Promise<void> => {
      await invoke('comment:remove', { commentId });
      if (workspaceId) removeCommentAction(workspaceId, commentId);
    },
    [workspaceId, removeCommentAction],
  );

  const sendCommentsToAgent = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    const { attachments } = await invoke('comment:sendToAgent', {
      workspaceId,
    });
    // The comments just sent flip to `sent` server-side; refetch to reflect it.
    const list = await invoke('comment:list', { workspaceId });
    setComments(workspaceId, list);
    await sendTurn(
      'Please address the following review comments.',
      attachments,
    );
  }, [workspaceId, setComments, sendTurn]);

  const runReview = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    const { prompt } = await invoke('review:run', { workspaceId });
    setReviewPending(workspaceId, true);
    await sendTurn(prompt, []);
  }, [workspaceId, setReviewPending, sendTurn]);

  return {
    diffSet,
    loadingDiff: workspaceId != null && diffSet == null,
    selectedPath,
    selectFile,
    fileDiff:
      selectedPath && fileDiffCache
        ? (fileDiffCache[selectedPath] ?? null)
        : null,
    loadingFileDiff:
      selectedPath != null && !(fileDiffCache && fileDiffCache[selectedPath]),
    menuInfo,
    scope,
    setTargetRef,
    setScope,
    comments,
    openComments: comments.filter((c) => c.state === 'open'),
    createComment,
    resolveComment,
    removeComment,
    sendCommentsToAgent,
    runReview,
    isReviewPending,
  };
}
