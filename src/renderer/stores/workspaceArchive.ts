import { create } from 'zustand';

import type { Workspace } from '@shared/models';
import { subscribeStream } from '@renderer/ipc';

interface WorkspaceArchiveProgress {
  workspaceId: string;
  workspaceName: string;
  phase: string;
  lines: string[];
  status: 'running' | 'complete' | 'error';
  error: string | null;
}

interface WorkspaceArchiveState {
  current: WorkspaceArchiveProgress | null;
  clear: () => void;
}

export const useWorkspaceArchiveStore = create<WorkspaceArchiveState>((set) => ({
  current: null,
  clear: () => set({ current: null }),
}));

export function archiveWorkspaceInBackground(workspace: Workspace): void {
  useWorkspaceArchiveStore.setState({
    current: {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      phase: 'Preparing workspace archive…',
      lines: [],
      status: 'running',
      error: null,
    },
  });

  void subscribeStream('workspace:archiveStream', { id: workspace.id }, (chunk) => {
    const current = useWorkspaceArchiveStore.getState().current;
    if (current === null || current.workspaceId !== workspace.id) return;
    if (chunk.kind === 'log') {
      useWorkspaceArchiveStore.setState({
        current: { ...current, lines: [...current.lines, chunk.chunk] },
      });
    } else {
      useWorkspaceArchiveStore.setState({
        current: { ...current, phase: chunk.message },
      });
    }
  })
    .then(() => {
      const current = useWorkspaceArchiveStore.getState().current;
      if (current === null || current.workspaceId !== workspace.id) return;
      useWorkspaceArchiveStore.setState({
        current: { ...current, phase: 'Workspace archived', status: 'complete' },
      });
    })
    .catch((error: unknown) => {
      const current = useWorkspaceArchiveStore.getState().current;
      if (current === null || current.workspaceId !== workspace.id) return;
      useWorkspaceArchiveStore.setState({
        current: {
          ...current,
          phase: 'Archive failed',
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
}
