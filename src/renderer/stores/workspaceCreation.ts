import { create } from 'zustand';

import type { CreateWorkspaceReq } from '@shared/models';
import { subscribeStream } from '@renderer/ipc';

export type WorkspaceCreationStatus = 'creating' | 'complete' | 'error';

export interface WorkspaceCreation {
  runId: string;
  projectId: string;
  workspaceId: string | null;
  phase: string;
  lines: string[];
  status: WorkspaceCreationStatus;
  error: string | null;
}

interface WorkspaceCreationState {
  current: WorkspaceCreation | null;
  clear: () => void;
}

export const useWorkspaceCreationStore = create<WorkspaceCreationState>((set) => ({
  current: null,
  clear: () => set({ current: null }),
}));

/**
 * Start creation independently of the modal that launched it. The stream deliberately
 * lives outside React so closing/unmounting the modal never cancels setup output.
 */
export function createWorkspaceInBackground(
  request: CreateWorkspaceReq,
  onCreated: (workspaceId: string) => void,
): string {
  const runId = globalThis.crypto.randomUUID();
  useWorkspaceCreationStore.setState({
    current: {
      runId,
      projectId: request.projectId,
      workspaceId: null,
      phase: 'Creating workspace…',
      lines: [],
      status: 'creating',
      error: null,
    },
  });

  void subscribeStream('workspace:create', request, (chunk) => {
    const current = useWorkspaceCreationStore.getState().current;
    if (current === null || current.runId !== runId) return;

    if (chunk.kind === 'created') {
      useWorkspaceCreationStore.setState({
        current: {
          ...current,
          workspaceId: chunk.workspace.id,
          phase: 'Running setup…',
        },
      });
      onCreated(chunk.workspace.id);
      return;
    }
    if (chunk.kind === 'setupLog') {
      useWorkspaceCreationStore.setState({
        current: { ...current, lines: [...current.lines, chunk.chunk] },
      });
      return;
    }
    useWorkspaceCreationStore.setState({
      current: {
        ...current,
        phase: chunk.message ?? chunk.phase,
      },
    });
  })
    .then(() => {
      const current = useWorkspaceCreationStore.getState().current;
      if (current === null || current.runId !== runId) return;
      useWorkspaceCreationStore.setState({
        current: { ...current, phase: 'Workspace ready', status: 'complete' },
      });
    })
    .catch((error: unknown) => {
      const current = useWorkspaceCreationStore.getState().current;
      if (current === null || current.runId !== runId) return;
      const message = error instanceof Error ? error.message : String(error);
      useWorkspaceCreationStore.setState({
        current: {
          ...current,
          phase: 'Workspace creation failed',
          status: 'error',
          error: message,
        },
      });
    });
  return runId;
}
