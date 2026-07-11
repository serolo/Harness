// Project switcher: a <select> over all registered projects that drives
// `selectedProjectId` in the Zustand store. Includes the <AddProjectMenu>
// for adding a local repo or cloning a URL.
//
// When data loads and no project is selected, defaults to the first project in
// the list so the sidebar workspace list is not blank after initial load.

import { useEffect, useState } from 'react';
import { GitBranch, ChevronsUpDown } from 'lucide-react';
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
      {/* Project selector — a combobox-styled trigger (leading git-branch glyph, trailing
          chevrons-up-down) over a native <select>. Kept as a hand-rolled element rather
          than the shared `Select` primitive: the placeholder option below is a real
          `disabled` option (so it can't be re-selected once a project is chosen), and
          `Select`'s `options` prop has no per-option disabled support. */}
      {projects.length > 0 ? (
        <div className="relative">
          <GitBranch
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3"
          />
          <select
            value={selectedProjectId ?? ''}
            onChange={(e) => selectProject(e.target.value || null)}
            className="h-control w-full cursor-pointer appearance-none rounded-2 border border-border-2 bg-surface-well pl-8 pr-8 text-xs text-fg-1 transition-colors duration-fast ease-out focus:border-accent-border focus:outline-none"
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
          <ChevronsUpDown
            aria-hidden="true"
            className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3"
          />
        </div>
      ) : (
        <p className="px-1 text-xs text-fg-3">No projects yet.</p>
      )}

      {/* Toggle add-project menu */}
      <button
        type="button"
        onClick={() => setAddOpen((v) => !v)}
        className="rounded-1 px-2 py-1 text-left text-xs text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-2"
      >
        {addOpen ? '− Add project' : '+ Add project'}
      </button>

      {addOpen && (
        <div className="rounded-2 border border-border-1 bg-surface-card p-2">
          <AddProjectMenu onDone={() => setAddOpen(false)} />
        </div>
      )}
    </div>
  );
}
