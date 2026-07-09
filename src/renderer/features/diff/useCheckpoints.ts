// useCheckpoints — fetches a workspace's per-turn checkpoints (`checkpoint:list`) and
// exposes `revert(turnIdx)` (`checkpoint:revert`). All main access funnels through
// `@renderer/ipc` (README §10) — never `window.api`/`ipcRenderer` directly.
//
// Checkpoints are kept in local hook state (not the Zustand diff store) — they're
// consumed by exactly one component (`CheckpointTimeline`) and aren't shared cross-
// component the way the diff set / comments are.

import { useCallback, useEffect, useState } from 'react';
import type { Checkpoint } from '@shared/review';
import { invoke, onEvent } from '@renderer/ipc';

export interface UseCheckpoints {
  checkpoints: Checkpoint[];
  loading: boolean;
  /** Revert the workspace to the checkpoint at `turnIdx` (`checkpoint:revert`). */
  revert: (turnIdx: number) => Promise<void>;
}

/**
 * Checkpoint list + revert action for one workspace. Refetches on mount / workspace
 * change and whenever `diff:changed` fires for this workspace (a revert or new turn
 * can change the checkpoint list) — subscription is torn down on cleanup.
 */
export function useCheckpoints(workspaceId: string | null): UseCheckpoints {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!workspaceId) {
      setCheckpoints([]);
      return;
    }
    let active = true;

    function load(): void {
      if (!workspaceId) return;
      setLoading(true);
      void invoke('checkpoint:list', { workspaceId })
        .then((res) => {
          if (active) setCheckpoints(res);
        })
        .catch(() => {
          if (active) setCheckpoints([]);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }

    load();
    const unsubscribe = onEvent('diff:changed', (payload) => {
      if (payload.workspaceId === workspaceId) load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspaceId]);

  const revert = useCallback(
    async (turnIdx: number): Promise<void> => {
      if (!workspaceId) return;
      await invoke('checkpoint:revert', { workspaceId, turnIdx });
    },
    [workspaceId],
  );

  return { checkpoints, loading, revert };
}
