// Renderer-side workspace/project store (Zustand).
//
// Phase 0 seeded this empty. Phase 1 extends it with:
//  - `selectedProjectId` — which project's workspaces the sidebar shows.
//  - `upsertProject`    — insert or replace a Project by id (used after add/clone).
//  - `markArchived`     — flip a workspace to `archived` and update its retained/null
//                         checkout path (used by the archived event handler).
//
// Everything already here (setProjects, setWorkspaces, upsertWorkspace,
// selectWorkspace, selectedWorkspaceId) is preserved unchanged.
//
// The DTO types come from the FROZEN shared contract (@shared/models) so the renderer
// and main agree on shape — never redeclare them here (README §10).

import { create } from 'zustand';
import type { Project, Workspace } from '@shared/models';

/** The reactive slice the sidebar (and later, other features) reads. */
export interface WorkspacesState {
  /** Registered projects (empty until Phase 1). */
  projects: Project[];
  /** All workspaces across projects, keyed by project via `Workspace.projectId`. */
  workspaces: Workspace[];
  /** Currently selected workspace, or null when none is focused. */
  selectedWorkspaceId: string | null;
  /**
   * Currently selected project id. Drives which workspaces the sidebar shows.
   * Null until the user selects one (ProjectSwitcher defaults to the first).
   */
  selectedProjectId: string | null;

  // --- Actions ---

  /** Replace the full project list (e.g. after an initial load). */
  setProjects: (projects: Project[]) => void;
  /** Replace the full workspace list. */
  setWorkspaces: (workspaces: Workspace[]) => void;
  /** Replace only one project's workspaces while retaining every other project. */
  setProjectWorkspaces: (projectId: string, workspaces: Workspace[]) => void;
  /** Insert or update a single workspace (by id). */
  upsertWorkspace: (workspace: Workspace) => void;
  /** Focus a workspace (or clear focus with null). */
  selectWorkspace: (workspaceId: string | null) => void;

  // --- Phase 1 additions ---

  /** Set the active project (drives the sidebar workspace list). */
  selectProject: (projectId: string | null) => void;
  /**
   * Insert or replace a Project by id. Called after `project:add` / `project:clone`
   * so the store and the TanStack cache stay in sync without a full refetch.
   */
  upsertProject: (project: Project) => void;
  /**
   * Mark a workspace as archived in place and reflect whether its checkout was kept.
   */
  markArchived: (id: string, worktreePath?: string | null) => void;
}

/**
 * The shared workspaces store. Components subscribe with selectors, e.g.
 * `useWorkspacesStore((s) => s.workspaces)`.
 */
export const useWorkspacesStore = create<WorkspacesState>((set) => ({
  projects: [],
  workspaces: [],
  selectedWorkspaceId: null,
  selectedProjectId: null,

  setProjects: (projects) => set({ projects }),

  setWorkspaces: (workspaces) => set({ workspaces }),

  setProjectWorkspaces: (projectId, workspaces) =>
    set((state) => {
      const current = state.workspaces.filter(
        (workspace) => workspace.projectId === projectId,
      );
      if (
        current.length === workspaces.length &&
        current.every((workspace, index) => workspace === workspaces[index])
      ) {
        return state;
      }
      return {
        workspaces: [
          ...state.workspaces.filter(
            (workspace) => workspace.projectId !== projectId,
          ),
          ...workspaces,
        ],
      };
    }),

  upsertWorkspace: (workspace) =>
    set((state) => {
      const idx = state.workspaces.findIndex((w) => w.id === workspace.id);
      if (idx === -1) {
        return { workspaces: [...state.workspaces, workspace] };
      }
      const next = state.workspaces.slice();
      next[idx] = workspace;
      return { workspaces: next };
    }),

  selectWorkspace: (workspaceId) => set({ selectedWorkspaceId: workspaceId }),

  // --- Phase 1 additions ---

  selectProject: (projectId) => set({ selectedProjectId: projectId }),

  upsertProject: (project) =>
    set((state) => {
      const idx = state.projects.findIndex((p) => p.id === project.id);
      if (idx === -1) {
        return { projects: [...state.projects, project] };
      }
      const next = state.projects.slice();
      next[idx] = project;
      return { projects: next };
    }),

  markArchived: (id, worktreePath) =>
    set((state) => {
      const idx = state.workspaces.findIndex((w) => w.id === id);
      if (idx === -1) return state;
      const next = state.workspaces.slice();
      next[idx] = {
        ...next[idx],
        status: 'archived',
        worktreePath: worktreePath ?? null,
      };
      return { workspaces: next };
    }),
}));
