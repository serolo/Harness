// Persistent project tree: every project is visible and expands to its sessions.

import { useEffect, useState } from 'react';
import { AlertTriangle, FolderPlus, X } from 'lucide-react';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useUiStore } from '@renderer/stores/ui';
import { useProjects, useWorkspaceEvents } from './hooks';
import { AddProjectMenu } from './AddProjectMenu';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';
import { ProjectGroup } from './ProjectGroup';
import { useWorkspaceCreationStore } from '@renderer/stores/workspaceCreation';

export function Sidebar(): React.JSX.Element {
  useWorkspaceEvents();

  const selectedProjectId = useWorkspacesStore((s) => s.selectedProjectId);
  const selectProject = useWorkspacesStore((s) => s.selectProject);
  const setProjects = useWorkspacesStore((s) => s.setProjects);
  const { data: projects = [] } = useProjects();

  const dialogOpen = useUiStore((s) => s.newWorkspaceOpen);
  const setDialogOpen = useUiStore((s) => s.setNewWorkspaceOpen);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const creation = useWorkspaceCreationStore((state) => state.current);
  const clearCreation = useWorkspaceCreationStore((state) => state.clear);

  useEffect(() => {
    setProjects(projects);
    if (selectedProjectId === null && projects.length > 0) {
      selectProject(projects[0].id);
    }
  }, [projects, selectProject, selectedProjectId, setProjects]);

  function openNewWorkspace(projectId: string): void {
    selectProject(projectId);
    setDialogOpen(true);
  }

  return (
    <nav
      className="flex h-full flex-col gap-3 px-3 py-4"
      aria-label="Workspaces"
      data-testid="sidebar"
    >
      <div className="flex items-center justify-between">
        <h2 className="px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-3">
          Projects
        </h2>
        <button
          type="button"
          onClick={() => setAddProjectOpen((value) => !value)}
          className="rounded-1 p-1.5 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
          data-testid="add-project-button"
          title="Add project"
          aria-label="Add project"
        >
          <FolderPlus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {addProjectOpen && (
        <div className="rounded-2 border border-border-1 bg-surface-card p-2">
          <AddProjectMenu onDone={() => setAddProjectOpen(false)} />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {projects.length === 0 ? (
          <p
            className="px-1 py-2 text-sm text-fg-3"
            data-testid="sidebar-empty"
          >
            No projects yet.
          </p>
        ) : (
          projects.map((project, index) => (
            <ProjectGroup
              key={project.id}
              project={project}
              defaultExpanded={
                project.id === selectedProjectId ||
                (selectedProjectId === null && index === 0)
              }
              onNewWorkspace={openNewWorkspace}
            />
          ))
        )}
      </div>

      {creation?.status === 'error' ? (
        <div
          role="alert"
          className="shrink-0 rounded-2 border border-danger/30 bg-danger-muted p-3"
          data-testid="workspace-creation-error"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-danger"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-danger">
                Workspace creation failed
              </p>
              <p className="mt-1 break-words text-xs text-fg-2">
                {creation.error ?? 'An unknown error occurred.'}
              </p>
              <button
                type="button"
                className="mt-2 text-xs font-medium text-accent hover:underline"
                onClick={() => {
                  clearCreation();
                  selectProject(creation.projectId);
                  setDialogOpen(true);
                }}
              >
                Try again
              </button>
            </div>
            <button
              type="button"
              aria-label="Dismiss workspace creation error"
              className="rounded-1 p-1 text-fg-3 hover:bg-bg-3 hover:text-fg-1"
              onClick={clearCreation}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}

      {dialogOpen && (
        <NewWorkspaceDialog
          projectId={selectedProjectId}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </nav>
  );
}
