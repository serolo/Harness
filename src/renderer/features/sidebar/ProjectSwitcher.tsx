// Project switcher: a <select> over all registered projects that drives
// `selectedProjectId` in the Zustand store. Includes the <AddProjectMenu>
// for adding a local repo or cloning a URL.
//
// When data loads and no project is selected, defaults to the first project in
// the list so the sidebar workspace list is not blank after initial load.

import { useEffect, useState } from 'react';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useProjects } from './hooks';
import { AddProjectMenu } from './AddProjectMenu';

/**
 * Displays a project drop-down and an inline add-project menu.
 * Drives `selectedProjectId` in the Zustand store.
 */
export function ProjectSwitcher(): React.JSX.Element {
  const { data: projects = [] } = useProjects();
  const selectedProjectId = useWorkspacesStore((s) => s.selectedProjectId);
  const selectProject = useWorkspacesStore((s) => s.selectProject);
  const [addOpen, setAddOpen] = useState(false);

  // Default-select the first project when projects load and nothing is selected.
  useEffect(() => {
    if (selectedProjectId == null && projects.length > 0) {
      selectProject(projects[0].id);
    }
  }, [projects, selectedProjectId, selectProject]);

  return (
    <div className="flex flex-col gap-1" data-testid="project-switcher">
      {/* Project selector */}
      {projects.length > 0 ? (
        <select
          value={selectedProjectId ?? ''}
          onChange={(e) => selectProject(e.target.value || null)}
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 focus:border-slate-500 focus:outline-none"
          aria-label="Select project"
        >
          <option value="" disabled>
            Select project…
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : (
        <p className="px-1 text-[11px] text-slate-600">No projects yet.</p>
      )}

      {/* Toggle add-project menu */}
      <button
        type="button"
        onClick={() => setAddOpen((v) => !v)}
        className="rounded px-2 py-1 text-left text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-400"
      >
        {addOpen ? '− Add project' : '+ Add project'}
      </button>

      {addOpen && (
        <div className="rounded border border-slate-800 bg-slate-950 p-2">
          <AddProjectMenu onDone={() => setAddOpen(false)} />
        </div>
      )}
    </div>
  );
}
