// useChecks — the checks feature's data hook. Bridges the FROZEN Phase-5 IPC channels
// (`checks:get`, `checks:updated`, `pr:*`, `review:resolveThread`) to the Zustand checks
// store: fetch the merge-readiness roll-up on mount / workspace change, subscribe
// `checks:updated` to refetch, and drive the one-click blocker actions + merge/resolve.
// All main access funnels through `@renderer/ipc` (README §10) — never `window.api`/
// `ipcRenderer` directly.
//
// The blocker "fix" actions (`pr:fixReviews` / `pr:fixChecks`) RETURN a composed
// `{ prompt, attachments }`; like Phase-4's `review:run` (see `useDiff.runReview`) we feed
// that into the SAME shared chat transcript via `useChat(workspaceId).sendTurn`, so the
// agent's reply streams into the ChatPanel rather than being re-implemented here.

import { useCallback, useEffect, useState } from 'react';
import type { MergeMethod } from '@shared/github';
import type { ChecksResult } from '@shared/checks';
import { AppError } from '@shared/errors';
import { invoke, onEvent } from '@renderer/ipc';
import { useChecksStore } from '@renderer/stores/checks';
import { useChat } from '@renderer/features/chat/useChat';

/**
 * The one-click actions surfaced by the panel's blocker rows, keyed by the check's
 * `suggestedAction` label (see `src/main/checks`). `pr:open` publishes the branch / opens
 * the PR; the `pr:fix*` actions compose an agent turn. `null` = no wired command.
 */
export type BlockerCommand = 'pr:open' | 'pr:fixChecks' | 'pr:fixReviews';

/** Map a check's `suggestedAction` label to the IPC command that resolves it. */
export function blockerCommandFor(
  suggestedAction: string | undefined,
): BlockerCommand | null {
  switch (suggestedAction) {
    case 'Commit & push':
    case 'Create PR':
      return 'pr:open';
    case 'Fix failing checks':
      return 'pr:fixChecks';
    case 'Fix review comments':
      return 'pr:fixReviews';
    default:
      return null;
  }
}

export interface UseChecks {
  /** The latest merge-readiness roll-up for this workspace (null until first load). */
  result: ChecksResult | null;
  /** True while the initial `checks:get` for this workspace hasn't resolved yet. */
  loading: boolean;
  /** The last load error, if the roll-up could not be fetched. */
  error: AppError | null;
  /** Re-run `checks:get` for this workspace. */
  refetch: () => void;
  /** Run the one-click command behind a blocker row's `suggestedAction`. */
  runBlockerAction: (suggestedAction: string) => Promise<void>;
  /** Merge this workspace's PR (server-gated on green; the button also mirrors the gate). */
  merge: (method: MergeMethod) => Promise<void>;
  /** Mark one GitHub review thread resolved, then refetch. */
  resolveThread: (threadId: string) => Promise<void>;
}

/**
 * Checks state + actions for one workspace. Hydrates the roll-up on mount / workspace
 * change, subscribes `checks:updated` (filtered to this workspace) to refetch, and
 * unsubscribes on cleanup — no listener leak across workspaces. The blocker "fix" actions
 * reuse `useChat().sendTurn` so their composed prompt streams into the shared transcript.
 */
export function useChecks(workspaceId: string | null): UseChecks {
  const result = useChecksStore((s) =>
    workspaceId ? (s.resultByWorkspace[workspaceId] ?? null) : null,
  );
  const setResult = useChecksStore((s) => s.setResult);

  const [loading, setLoading] = useState<boolean>(workspaceId != null);
  const [error, setError] = useState<AppError | null>(null);

  const { sendTurn } = useChat(workspaceId);

  // Hydrate the roll-up on mount / workspace change; refetch when `checks:updated` fires
  // for THIS workspace. The subscription is torn down on cleanup so it never leaks.
  useEffect(() => {
    if (!workspaceId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);

    function load(): void {
      if (!workspaceId) return;
      void invoke('checks:get', { workspaceId })
        .then((res) => {
          if (!active) return;
          setResult(workspaceId, res);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!active) return;
          setError(
            err instanceof AppError
              ? err
              : new AppError('internal', 'failed to load checks', err),
          );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }

    load();
    const unsubscribe = onEvent('checks:updated', (payload) => {
      if (payload.workspaceId === workspaceId) load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspaceId, setResult]);

  const refetch = useCallback((): void => {
    if (!workspaceId) return;
    void invoke('checks:get', { workspaceId })
      .then((res) => setResult(workspaceId, res))
      .catch(() => {
        /* the panel keeps showing the previous roll-up on a refetch failure */
      });
  }, [workspaceId, setResult]);

  const runBlockerAction = useCallback(
    async (suggestedAction: string): Promise<void> => {
      if (!workspaceId) return;
      const command = blockerCommandFor(suggestedAction);
      if (command === null) return;

      if (command === 'pr:open') {
        // Publishing the branch / opening the PR mutates git+GitHub state; the server
        // emits `checks:updated`, but refetch too so the roll-up updates immediately.
        await invoke('pr:open', { workspaceId });
        refetch();
        return;
      }

      // `pr:fixChecks` / `pr:fixReviews` compose an agent turn — stream it into the shared
      // chat transcript exactly like `useDiff.runReview` does for `review:run`.
      const { prompt, attachments } = await invoke(command, { workspaceId });
      await sendTurn(prompt, attachments);
    },
    [workspaceId, refetch, sendTurn],
  );

  const merge = useCallback(
    async (method: MergeMethod): Promise<void> => {
      if (!workspaceId) return;
      // The server re-gates the merge on green; if it succeeds the roll-up changes, so
      // refetch to reflect the merged state.
      await invoke('pr:merge', { workspaceId, method });
      refetch();
    },
    [workspaceId, refetch],
  );

  const resolveThread = useCallback(
    async (threadId: string): Promise<void> => {
      if (!workspaceId) return;
      await invoke('review:resolveThread', { workspaceId, threadId });
      refetch();
    },
    [workspaceId, refetch],
  );

  return {
    result,
    loading,
    error,
    refetch,
    runBlockerAction,
    merge,
    resolveThread,
  };
}
