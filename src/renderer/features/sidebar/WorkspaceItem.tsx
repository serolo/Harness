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

import { useQueryClient } from '@tanstack/react-query';
import type { Workspace } from '@shared/models';
import { invoke } from '@renderer/ipc';
import { StatusBadge } from './StatusBadge';

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
  const isArchived = workspace.status === 'archived';

  /** Invalidate the workspaces cache for this project after a mutating action. */
  function invalidate(): void {
    void queryClient.invalidateQueries({
      queryKey: ['workspaces', workspace.projectId],
    });
  }

  async function handleArchive(): Promise<void> {
    const ok = window.confirm(
      `Archive workspace "${workspace.name}"? The worktree will be removed from disk but the workspace record is kept.`,
    );
    if (!ok) return;
    try {
      await invoke('workspace:archive', { id: workspace.id });
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`Failed to archive workspace: ${msg}`);
    }
  }

  async function handleRestore(): Promise<void> {
    const ok = window.confirm(
      `Restore workspace "${workspace.name}"? A new worktree will be re-created from the branch.`,
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
    >
      <button
        type="button"
        onClick={() => onSelect(workspace.id)}
        aria-current={isSelected ? 'true' : undefined}
        className={`group w-full rounded px-2 py-2 text-left transition-colors ${
          isSelected
            ? 'bg-slate-700 text-slate-100'
            : 'text-slate-300 hover:bg-slate-800'
        }`}
      >
        {/* Top row: name + status badge */}
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {workspace.name}
          </span>
          <StatusBadge status={workspace.status} />
        </div>

        {/* Second row: branch + harness + optional port */}
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
          <span className="min-w-0 flex-1 truncate">{workspace.branch}</span>
          <span className="shrink-0">
            {HARNESS_LABELS[workspace.harness] ?? workspace.harness}
          </span>
          {workspace.port != null && (
            <span className="shrink-0 tabular-nums">:{workspace.port}</span>
          )}
        </div>
      </button>

      {/* Action buttons */}
      <div className="flex justify-end px-2 pb-1">
        {isArchived ? (
          <button
            type="button"
            onClick={() => void handleRestore()}
            className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            data-testid="restore-btn"
            aria-label={`Restore workspace ${workspace.name}`}
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleArchive()}
            className="rounded px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-800 hover:text-slate-400"
            data-testid="archive-btn"
            aria-label={`Archive workspace ${workspace.name}`}
          >
            Archive
          </button>
        )}
      </div>
    </li>
  );
}
