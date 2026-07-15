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

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Pin, RotateCcw } from 'lucide-react';
import type { Workspace, WorkspaceStatus } from '@shared/models';
import { invoke } from '@renderer/ipc';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { Button, Checkbox, Dialog, Input } from '@renderer/components/ui';
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

function branchSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63);
}

function branchNameForWorkspaceName(
  currentBranch: string,
  name: string,
): string | null {
  const slug = branchSlug(name);
  if (slug === '') return null;
  const slash = currentBranch.lastIndexOf('/');
  if (slash <= 0) return slug;
  return `${currentBranch.slice(0, slash)}/${slug}`;
}

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
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(workspace.name);
  const [renameBranch, setRenameBranch] = useState(false);

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
    renameBranch?: boolean;
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
    setRenameDraft(workspace.name);
    setRenameBranch(false);
    setRenameOpen(true);
  }

  async function commitRename(): Promise<void> {
    const nextName = renameDraft.trim();
    if (nextName === '' || nextName === workspace.name) {
      setRenameOpen(false);
      return;
    }
    const nextBranch = branchNameForWorkspaceName(workspace.branch, nextName);
    await updateWorkspace({
      name: nextName,
      ...(renameBranch && nextBranch !== null && nextBranch !== workspace.branch
        ? { renameBranch: true }
        : {}),
    });
    setRenameOpen(false);
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
            <span className="min-w-0 flex-1 truncate">{workspace.branch}</span>
            <span className="shrink-0">
              {HARNESS_LABELS[workspace.harness] ?? workspace.harness}
            </span>
            {workspace.port != null && (
              <span className="shrink-0 tabular-nums">:{workspace.port}</span>
            )}
          </div>
        </button>

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

      {renameOpen ? (
        <RenameWorkspaceDialog
          workspace={workspace}
          draft={renameDraft}
          onDraftChange={setRenameDraft}
          renameBranch={renameBranch}
          onRenameBranchChange={setRenameBranch}
          onCancel={() => setRenameOpen(false)}
          onSubmit={() => void commitRename()}
        />
      ) : null}
    </li>
  );
}

function RenameWorkspaceDialog({
  workspace,
  draft,
  onDraftChange,
  renameBranch,
  onRenameBranchChange,
  onCancel,
  onSubmit,
}: {
  workspace: Workspace;
  draft: string;
  onDraftChange: (value: string) => void;
  renameBranch: boolean;
  onRenameBranchChange: (checked: boolean) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const nextName = draft.trim();
  const nextBranch = branchNameForWorkspaceName(workspace.branch, nextName);
  const canRenameBranch =
    nextName !== '' && nextBranch !== null && nextBranch !== workspace.branch;

  return (
    <Dialog
      title="Rename workspace"
      onClose={onCancel}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={nextName === ''}
            form="workspace-rename-form"
          >
            Rename
          </Button>
        </>
      }
    >
      <form
        id="workspace-rename-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="space-y-4"
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-caps text-fg-3">
            Workspace name
          </span>
          <Input
            autoFocus
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            data-testid="workspace-rename-input"
            className="w-full"
          />
        </label>
        <div className="rounded-2 border border-border-1 bg-surface-well px-3 py-2">
          <Checkbox
            checked={renameBranch && canRenameBranch}
            onChange={onRenameBranchChange}
            disabled={!canRenameBranch}
            data-testid="workspace-rename-branch-checkbox"
            label={
              <span className="text-sm">
                Rename branch
                {nextBranch !== null && nextBranch !== workspace.branch ? (
                  <span className="mt-0.5 block text-xs text-fg-3">
                    {workspace.branch}
                    {' -> '}
                    {nextBranch}
                  </span>
                ) : null}
              </span>
            }
          />
          <p className="mt-2 text-xs text-fg-3">
            The worktree folder will not be renamed.
          </p>
        </div>
      </form>
    </Dialog>
  );
}
