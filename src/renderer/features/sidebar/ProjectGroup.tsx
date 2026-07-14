import { useEffect, useState } from 'react';
import { ChevronRight, FolderGit2, Plus } from 'lucide-react';
import type { Project } from '@shared/models';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useWorkspaces } from './hooks';
import { WorkspaceItem } from './WorkspaceItem';

export interface ProjectGroupProps {
  project: Project;
  defaultExpanded?: boolean;
  onNewWorkspace: (projectId: string) => void;
}

/** One expandable project and all of its workspace sessions. */
export function ProjectGroup({
  project,
  defaultExpanded = false,
  onNewWorkspace,
}: ProjectGroupProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { data, isLoading } = useWorkspaces(project.id);
  const workspaces = data ?? [];
  const visibleWorkspaces = workspaces
    .filter((workspace) => workspace.status !== 'archived')
    .sort(
      (left, right) =>
        Number(Boolean(right.isPinned)) - Number(Boolean(left.isPinned)),
    );
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const selectProject = useWorkspacesStore((s) => s.selectProject);
  const setProjectWorkspaces = useWorkspacesStore(
    (s) => s.setProjectWorkspaces,
  );

  useEffect(() => {
    if (data !== undefined) {
      setProjectWorkspaces(project.id, data);
    }
  }, [data, project.id, setProjectWorkspaces]);

  function selectSession(workspaceId: string): void {
    selectProject(project.id);
    selectWorkspace(workspaceId);
  }

  return (
    <section data-testid="project-group" data-project-id={project.id}>
      <div className="group flex items-center rounded-2 hover:bg-bg-3">
        <button
          type="button"
          onClick={() => {
            selectProject(project.id);
            setExpanded((value) => !value);
          }}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm font-medium text-fg-2"
          data-testid="project-toggle"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
          <FolderGit2
            className="h-4 w-4 shrink-0 text-fg-3"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          <span className="text-2xs font-normal tabular-nums text-fg-3">
            {visibleWorkspaces.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            onNewWorkspace(project.id);
          }}
          className="mr-1 rounded-1 p-1.5 text-fg-3 transition-colors hover:bg-bg-4 hover:text-fg-1"
          aria-label={`New workspace in ${project.name}`}
          title="New workspace"
          data-testid="project-new-workspace"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {expanded && (
        <div className="ml-4 border-l border-border-1 pl-1.5">
          {isLoading ? (
            <p className="px-2 py-2 text-xs text-fg-3">Loading sessions…</p>
          ) : visibleWorkspaces.length === 0 ? (
            <p className="px-2 py-2 text-xs text-fg-3">No sessions yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visibleWorkspaces.map((workspace) => (
                <WorkspaceItem
                  key={workspace.id}
                  workspace={workspace}
                  isSelected={workspace.id === selectedWorkspaceId}
                  onSelect={selectSession}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
