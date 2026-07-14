// A single workspace row in the sidebar list.
//
// Renders:
//   - City name (primary label)
//   - Branch name (muted, secondary)
//   - StatusBadge (colored pill)
//   - Harness label (claude_code / codex / cursor)
//   - Port (when allocated)
//   - Archive button (non-archived only)
//   - Restore button (archived only)
//
// Archive/restore each call the respective IPC command behind a window.confirm
// guard, then invalidate the TanStack query cache so the list refreshes.
//
// Archived rows render dimmed. The selected row is highlighted.

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Pin, RotateCcw } from 'lucide-react';
import type { Workspace, WorkspaceStatus } from '@shared/models';
import { invoke } from '@renderer/ipc';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import {
  archiveWorkspaceWithConfirmation,
  workspaceDeepLink,
} from '@renderer/features/workspace/actions';
import { StatusBadge } from './StatusBadge';
import { WorkspaceContextMenu } from './WorkspaceContextMenu';

/** Human-readable labels for each HarnessId. */
const HARNESS_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

export interface WorkspaceItemProps {
  workspace: Workspace;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

/**
 * Renders one workspace row inside the sidebar list.
 * Provides archive/restore actions with confirmation guards.
 */
export function WorkspaceItem({
  workspace,
  isSelected,
  onSelect,
}: WorkspaceItemProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const upsertWorkspace = useWorkspacesStore((state) => state.upsertWorkspace);
  const isArchived = workspace.status === 'archived';
  const [contextPoint, setContextPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(workspace.name);
  const cancelRenameRef = useRef(false);
  const renameCommitStartedRef = useRef(false);

  /** Invalidate the workspaces cache for this project after a mutating action. */
  function invalidate(): void {
    void queryClient.invalidateQueries({
      queryKey: ['workspaces', workspace.projectId],
    });
  }

  async function handleArchive(): Promise<void> {
    try {
      if (await archiveWorkspaceWithConfirmation(workspace)) invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`Failed to archive workspace: ${msg}`);
    }
  }

  async function updateWorkspace(patch: {
    name?: string;
    status?: WorkspaceStatus;
    isUnread?: boolean;
    isPinned?: boolean;
  }): Promise<Workspace | null> {
    try {
      const updated = await invoke('workspace:update', {
        id: workspace.id,
        ...patch,
      });
      queryClient.setQueryData<Workspace[]>(
        ['workspaces', workspace.projectId],
        (previous) =>
          previous?.map((row) => (row.id === updated.id ? updated : row)),
      );
      upsertWorkspace(updated);
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`Failed to update workspace: ${message}`);
      return null;
    }
  }

  function handleSelect(): void {
    onSelect(workspace.id);
    if (workspace.isUnread) {
      void updateWorkspace({ isUnread: false });
    }
  }

  function startRename(): void {
    cancelRenameRef.current = false;
    renameCommitStartedRef.current = false;
    setRenameDraft(workspace.name);
    setRenaming(true);
  }

  async function commitRename(): Promise<void> {
    if (!renaming || renameCommitStartedRef.current) return;
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    renameCommitStartedRef.current = true;
    const nextName = renameDraft.trim();
    setRenaming(false);
    if (nextName === '' || nextName === workspace.name) return;
    await updateWorkspace({ name: nextName });
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(workspaceDeepLink(workspace.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`Failed to copy workspace link: ${message}`);
    }
  }

  async function handleRestore(): Promise<void> {
    const ok = window.confirm(
      workspace.worktreePath
        ? `Restore workspace "${workspace.name}" using its preserved checkout?`
        : `Restore workspace "${workspace.name}"? A new worktree will be re-created from the branch.`,
    );
    if (!ok) return;
    try {
      await invoke('workspace:restore', { id: workspace.id });
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`Failed to restore workspace: ${msg}`);
    }
  }

  return (
    <li
      className={isArchived ? 'opacity-50' : ''}
      data-testid="workspace-item"
      data-workspace-id={workspace.id}
      onContextMenu={(event) => {
        if (isArchived) return;
        event.preventDefault();
        setContextPoint({ x: event.clientX, y: event.clientY });
      }}
    >
      <div
        className={`group flex items-center rounded-2 transition-colors duration-fast ease-out ${
          isSelected ? 'bg-bg-4 text-fg-1' : 'text-fg-2 hover:bg-bg-3'
        }`}
      >
        {renaming ? (
          <div className="min-w-0 flex-1 px-2 py-1.5">
            <input
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitRename();
                if (event.key === 'Escape') {
                  cancelRenameRef.current = true;
                  setRenaming(false);
                }
              }}
              aria-label="Workspace name"
              data-testid="workspace-rename-input"
              className="h-7 w-full rounded-1 border border-accent bg-surface-well px-2 text-sm text-fg-1 outline-none ring-1 ring-focus-ring"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={handleSelect}
            aria-current={isSelected ? 'true' : undefined}
            className="min-w-0 flex-1 px-2 py-2 text-left"
          >
            <div className="flex items-center gap-1.5">
              {workspace.isUnread ? (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  aria-label="Unread"
                  data-testid="workspace-unread-dot"
                />
              ) : null}
              <span
                className={`min-w-0 flex-1 truncate text-sm ${
                  workspace.isUnread ? 'font-semibold text-fg-1' : 'font-medium'
                }`}
              >
                {workspace.name}
              </span>
              {workspace.isPinned ? (
                <Pin
                  className="h-3 w-3 shrink-0 text-fg-3"
                  aria-label="Pinned"
                  data-testid="workspace-pinned-icon"
                />
              ) : null}
              <StatusBadge status={workspace.status} />
            </div>

            <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-3">
              <span className="min-w-0 flex-1 truncate">
                {workspace.branch}
              </span>
              <span className="shrink-0">
                {HARNESS_LABELS[workspace.harness] ?? workspace.harness}
              </span>
              {workspace.port != null && (
                <span className="shrink-0 tabular-nums">:{workspace.port}</span>
              )}
            </div>
          </button>
        )}

        {isArchived ? (
          <button
            type="button"
            onClick={() => void handleRestore()}
            className="mr-1.5 rounded-1 p-1.5 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
            data-testid="restore-btn"
            aria-label={`Restore workspace ${workspace.name}`}
            title="Restore workspace"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleArchive()}
            className="mr-1.5 rounded-1 p-1.5 text-fg-3 opacity-70 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1 hover:opacity-100"
            data-testid="archive-btn"
            aria-label={`Archive workspace ${workspace.name}`}
            title="Archive workspace"
          >
            <Archive className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {contextPoint ? (
        <WorkspaceContextMenu
          workspace={workspace}
          point={contextPoint}
          onClose={() => setContextPoint(null)}
          onToggleUnread={() =>
            void updateWorkspace({ isUnread: !workspace.isUnread })
          }
          onTogglePin={() =>
            void updateWorkspace({ isPinned: !workspace.isPinned })
          }
          onSetStatus={(status) => void updateWorkspace({ status })}
          onRename={startRename}
          onCopyLink={() => void copyLink()}
          onArchive={() => void handleArchive()}
        />
      ) : null}
    </li>
  );
}
