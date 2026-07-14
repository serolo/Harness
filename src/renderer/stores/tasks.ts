// Renderer-side scheduled-tasks store (Zustand) — the per-workspace task list fetched
// from `task:list` and refetched on `task:changed`. Single list per workspace, mirroring
// `stores/checks.ts`'s per-workspace `Record` shape.
//
// DTO types come from the FROZEN shared contract (@shared/tasks); never redeclare them.

import { create } from 'zustand';
import type { ScheduledTask } from '@shared/tasks';

export interface TasksState {
  /** The latest task list per workspace (from `task:list` / a refetch). */
  tasksByWorkspace: Record<string, ScheduledTask[]>;

  /** Replace a workspace's task list. */
  setTasks: (workspaceId: string, tasks: ScheduledTask[]) => void;
  /** Clear a workspace's cached tasks (e.g. on workspace archive). */
  reset: (workspaceId: string) => void;
}

export const useTasksStore = create<TasksState>((set) => ({
  tasksByWorkspace: {},

  setTasks: (workspaceId, tasks) =>
    set((state) => ({
      tasksByWorkspace: { ...state.tasksByWorkspace, [workspaceId]: tasks },
    })),

  reset: (workspaceId) =>
    set((state) => {
      const tasksByWorkspace = { ...state.tasksByWorkspace };
      delete tasksByWorkspace[workspaceId];
      return { tasksByWorkspace };
    }),
}));
