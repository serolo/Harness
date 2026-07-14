// useTasks — the tasks feature's data hook. Bridges the FROZEN Phase-12 IPC channels
// (`task:list`/`task:create`/`task:update`/`task:delete`/`task:runNow`/`task:markDone` +
// the `task:changed` broadcast) to the Zustand tasks store: fetch the list on mount /
// workspace change, subscribe `task:changed` (filtered to this workspace) to refetch, and
// expose the mutating actions. Every mutation goes through `@renderer/ipc` (README §10) —
// never `window.api`/`ipcRenderer` directly. The server emits `task:changed` after each
// mutation, so there is no optimistic bookkeeping here.

import { useCallback, useEffect, useState } from 'react';
import type {
  CreateTaskReq,
  ScheduledTask,
  UpdateTaskReq,
} from '@shared/tasks';
import { AppError } from '@shared/errors';
import { invoke, onEvent } from '@renderer/ipc';
import { useTasksStore } from '@renderer/stores/tasks';

export interface UseTasks {
  /** This workspace's tasks (created_at ASC); empty until the first load. */
  tasks: ScheduledTask[];
  /** True while the initial `task:list` for this workspace hasn't resolved yet. */
  loading: boolean;
  /** The last load error, if the list could not be fetched. */
  error: AppError | null;
  /** Re-run `task:list`. */
  refetch: () => void;
  createTask: (req: Omit<CreateTaskReq, 'workspaceId'>) => Promise<void>;
  updateTask: (req: UpdateTaskReq) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<void>;
  markDone: (id: string) => Promise<void>;
}

/** Stable empty-array reference so the selector doesn't loop on `?? []`. */
const EMPTY: ScheduledTask[] = [];

/**
 * Tasks state + actions for one workspace. Hydrates on mount / workspace change,
 * subscribes `task:changed` (filtered to this workspace) to refetch, and unsubscribes on
 * cleanup — no listener leak across workspaces.
 */
export function useTasks(workspaceId: string | null): UseTasks {
  const tasks = useTasksStore((s) =>
    workspaceId ? (s.tasksByWorkspace[workspaceId] ?? EMPTY) : EMPTY,
  );
  const setTasks = useTasksStore((s) => s.setTasks);

  const [loading, setLoading] = useState<boolean>(workspaceId != null);
  const [error, setError] = useState<AppError | null>(null);

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
      void invoke('task:list', { workspaceId })
        .then((res) => {
          if (!active) return;
          setTasks(workspaceId, res);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!active) return;
          setError(
            err instanceof AppError
              ? err
              : new AppError('internal', 'failed to load tasks', err),
          );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }

    load();
    const unsubscribe = onEvent('task:changed', (payload) => {
      if (payload.workspaceId === workspaceId) load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspaceId, setTasks]);

  const refetch = useCallback((): void => {
    if (!workspaceId) return;
    void invoke('task:list', { workspaceId })
      .then((res) => setTasks(workspaceId, res))
      .catch(() => {
        /* keep the previous list on a refetch failure */
      });
  }, [workspaceId, setTasks]);

  const createTask = useCallback(
    async (req: Omit<CreateTaskReq, 'workspaceId'>): Promise<void> => {
      if (!workspaceId) return;
      await invoke('task:create', { ...req, workspaceId });
    },
    [workspaceId],
  );

  const updateTask = useCallback(async (req: UpdateTaskReq): Promise<void> => {
    await invoke('task:update', req);
  }, []);

  const deleteTask = useCallback(async (id: string): Promise<void> => {
    await invoke('task:delete', { id });
  }, []);

  const runNow = useCallback(async (id: string): Promise<void> => {
    await invoke('task:runNow', { id });
  }, []);

  const markDone = useCallback(async (id: string): Promise<void> => {
    await invoke('task:markDone', { id });
  }, []);

  return {
    tasks,
    loading,
    error,
    refetch,
    createTask,
    updateTask,
    deleteTask,
    runNow,
    markDone,
  };
}
