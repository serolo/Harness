// Persistent project tree: every project is visible and expands to its sessions.

import { useEffect, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useUiStore } from '@renderer/stores/ui';
import { useProjects, useWorkspaceEvents } from './hooks';
import { AddProjectMenu } from './AddProjectMenu';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';
import { ProjectGroup } from './ProjectGroup';

export function Sidebar(): React.JSX.Element {
  useWorkspaceEvents();

  const selectedProjectId = useWorkspacesStore((s) => s.selectedProjectId);
  const selectProject = useWorkspacesStore((s) => s.selectProject);
  const setProjects = useWorkspacesStore((s) => s.setProjects);
  const { data: projects = [] } = useProjects();

  const dialogOpen = useUiStore((s) => s.newWorkspaceOpen);
  const setDialogOpen = useUiStore((s) => s.setNewWorkspaceOpen);
  const [addProjectOpen, setAddProjectOpen] = useState(false);

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
      className="flex h-full flex-col gap-3 p-3"
      aria-label="Workspaces"
      data-testid="sidebar"
    >
      <div className="flex items-center justify-between">
        <h2 className="px-1 text-sm font-semibold text-fg-2">Projects</h2>
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

      {dialogOpen && (
        <NewWorkspaceDialog
          projectId={selectedProjectId}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </nav>
  );
}
