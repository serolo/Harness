import { beforeEach, describe, expect, it } from 'vitest';

import type { Workspace } from '@shared/models';
import { useWorkspacesStore } from './workspaces';

function workspace(
  id: string,
  projectId: string,
  status: Workspace['status'] = 'idle',
): Workspace {
  return {
    id,
    projectId,
    name: id,
    branch: `agent/${id}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${id}`,
    status,
    sourceKind: null,
    sourceRef: null,
    harness: 'claude_code',
    port: null,
    createdAt: 1,
    archivedAt: status === 'archived' ? 2 : null,
    prNumber: null,
  };
}

function resetStore(): void {
  useWorkspacesStore.setState({
    projects: [],
    workspaces: [],
    selectedWorkspaceId: null,
    selectedProjectId: null,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetStore();
});

describe('useWorkspacesStore workspace selection persistence', () => {
  it('persists explicit workspace selection and clears it with null', () => {
    useWorkspacesStore.getState().selectWorkspace('ws-1');

    expect(window.localStorage.getItem('harness:last-workspace-id')).toBe(
      'ws-1',
    );

    useWorkspacesStore.getState().selectWorkspace(null);

    expect(window.localStorage.getItem('harness:last-workspace-id')).toBeNull();
  });

  it('restores the last selected workspace when it is loaded', () => {
    window.localStorage.setItem('harness:last-workspace-id', 'ws-2');

    useWorkspacesStore
      .getState()
      .setProjectWorkspaces('project-2', [workspace('ws-2', 'project-2')]);

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-2');
    expect(useWorkspacesStore.getState().selectedProjectId).toBe('project-2');
  });

  it('does not overwrite an active in-memory selection', () => {
    window.localStorage.setItem('harness:last-workspace-id', 'ws-2');
    useWorkspacesStore.setState({
      selectedWorkspaceId: 'ws-1',
      selectedProjectId: 'project-1',
    });

    useWorkspacesStore.getState().setWorkspaces([
      workspace('ws-1', 'project-1'),
      workspace('ws-2', 'project-2'),
    ]);

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-1');
    expect(useWorkspacesStore.getState().selectedProjectId).toBe('project-1');
  });

  it('does not restore an archived workspace', () => {
    window.localStorage.setItem('harness:last-workspace-id', 'ws-2');

    useWorkspacesStore
      .getState()
      .setWorkspaces([workspace('ws-2', 'project-2', 'archived')]);

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
    expect(useWorkspacesStore.getState().selectedProjectId).toBeNull();
  });

  it('moves project focus when selecting a loaded workspace directly', () => {
    useWorkspacesStore.getState().setWorkspaces([
      workspace('ws-1', 'project-1'),
      workspace('ws-2', 'project-2'),
    ]);

    useWorkspacesStore.getState().selectWorkspace('ws-2');

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-2');
    expect(useWorkspacesStore.getState().selectedProjectId).toBe('project-2');
  });

  it('moves selection to another live workspace in the same project when archiving the selected workspace', () => {
    useWorkspacesStore.getState().setWorkspaces([
      workspace('ws-1', 'project-1'),
      workspace('ws-2', 'project-1'),
      workspace('ws-3', 'project-2'),
    ]);
    useWorkspacesStore.getState().selectWorkspace('ws-1');

    useWorkspacesStore.getState().markArchived('ws-1', null);

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-2');
    expect(useWorkspacesStore.getState().selectedProjectId).toBe('project-1');
    expect(window.localStorage.getItem('harness:last-workspace-id')).toBe(
      'ws-2',
    );
  });

  it('clears selected workspace and persisted focus when archiving the only live workspace', () => {
    useWorkspacesStore
      .getState()
      .setWorkspaces([workspace('ws-1', 'project-1')]);
    useWorkspacesStore.getState().selectWorkspace('ws-1');

    useWorkspacesStore.getState().markArchived('ws-1', null);

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
    expect(useWorkspacesStore.getState().selectedProjectId).toBe('project-1');
    expect(window.localStorage.getItem('harness:last-workspace-id')).toBeNull();
  });
});
