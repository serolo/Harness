// Sidebar feature — project switcher, workspace list with live status, and
// the New Workspace dialog trigger.
//
// Architecture:
//   - `useWorkspaceEvents()` mounts once here and subscribes to all three
//     `workspace:*` broadcast events, keeping TanStack cache + Zustand store live.
//   - `<ProjectSwitcher>` lets the user switch between registered projects.
//   - `<WorkspaceItem>` renders each workspace row with status badge + actions.
//   - Live (non-archived) workspaces render at the top; archived rows are greyed
//     and collapsed at the bottom with a toggle.
//   - `data-testid="sidebar"` on the root nav; `data-testid="sidebar-empty"` on
//     the empty state paragraph (preserved from Phase 0 for tests).

import { useState } from 'react';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkspaces, useWorkspaceEvents } from './hooks';
import { ProjectSwitcher } from './ProjectSwitcher';
import { WorkspaceItem } from './WorkspaceItem';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

/**
 * The left rail: project switcher, "New Workspace" button, workspace list with
 * live status badges, and archived rows with restore actions.
 */
export function Sidebar(): React.JSX.Element {
  // Mount workspace event subscriptions for the lifetime of the sidebar.
  useWorkspaceEvents();

  const selectedProjectId = useWorkspacesStore((s) => s.selectedProjectId);
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);

  const { data: workspaces = [] } = useWorkspaces(selectedProjectId);

  // The dialog's open-state lives in the shared UI store so the app menu / ⌘K palette
  // ("New Workspace") can open it too — not just the local "+ New" button.
  const dialogOpen = useUiStore((s) => s.newWorkspaceOpen);
  const setDialogOpen = useUiStore((s) => s.setNewWorkspaceOpen);
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  const liveWorkspaces = workspaces.filter((w) => w.status !== 'archived');
  const archivedWorkspaces = workspaces.filter((w) => w.status === 'archived');
  const hasWorkspaces =
    liveWorkspaces.length > 0 || archivedWorkspaces.length > 0;

  return (
    <nav
      className="flex h-full flex-col gap-3 p-3"
      aria-label="Workspaces"
      data-testid="sidebar"
    >
      {/* Project switcher */}
      <ProjectSwitcher />

      {/* Section header + New Workspace button */}
      <div className="flex items-center justify-between">
        <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Workspaces
        </h2>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          disabled={selectedProjectId == null}
          className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="new-workspace-button"
          title={
            selectedProjectId == null
              ? 'Select a project first'
              : 'New Workspace'
          }
        >
          + New
        </button>
      </div>

      {/* Workspace list */}
      {!hasWorkspaces ? (
        <p className="px-1 text-sm text-slate-500" data-testid="sidebar-empty">
          No workspaces yet.
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 overflow-y-auto">
          {/* Live workspaces */}
          {liveWorkspaces.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {liveWorkspaces.map((ws) => (
                <WorkspaceItem
                  key={ws.id}
                  workspace={ws}
                  isSelected={ws.id === selectedWorkspaceId}
                  onSelect={selectWorkspace}
                />
              ))}
            </ul>
          )}

          {/* Archived workspaces — collapsed by default */}
          {archivedWorkspaces.length > 0 && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setArchivedExpanded((v) => !v)}
                className="w-full rounded px-2 py-1 text-left text-[11px] text-slate-600 hover:bg-slate-800 hover:text-slate-500"
                aria-expanded={archivedExpanded}
              >
                {archivedExpanded ? '▾' : '▸'} Archived (
                {archivedWorkspaces.length})
              </button>

              {archivedExpanded && (
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {archivedWorkspaces.map((ws) => (
                    <WorkspaceItem
                      key={ws.id}
                      workspace={ws}
                      isSelected={ws.id === selectedWorkspaceId}
                      onSelect={selectWorkspace}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* New Workspace dialog */}
      {dialogOpen && (
        <NewWorkspaceDialog
          projectId={selectedProjectId}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </nav>
  );
}
