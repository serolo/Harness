// Sidebar TanStack Query hooks + live workspace event subscriptions.
//
// `useProjects`        — fetches the project list via `project:list`.
// `useWorkspaces`      — fetches one project's workspaces via `workspace:list`.
// `useWorkspaceEvents` — mounts a single effect that subscribes to all three
//                        `workspace:*` broadcast events and keeps BOTH the TanStack
//                        query cache and the Zustand store up-to-date. Mirrors the
//                        active-guard + cleanup pattern from IpcHealth.tsx.
//
// All main-process access funnels through `@renderer/ipc` (README §10 — never
// `window.api` or `ipcRenderer` directly).

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Project, Workspace } from '@shared/models';
import { invoke, onEvent } from '@renderer/ipc';
import { useWorkspacesStore } from '@renderer/stores/workspaces';

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

/**
 * Fetches the full project list. Returns the TanStack query object so callers
 * can read `.data`, `.isLoading`, `.error`, etc.
 */
export function useProjects(): UseQueryResult<Project[]> {
  return useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => invoke('project:list', undefined),
  });
}

/**
 * Fetches the workspaces for `projectId`, including archived ones so the
 * sidebar can show the restore option. Disabled when `projectId` is null.
 */
export function useWorkspaces(
  projectId: string | null,
): UseQueryResult<Workspace[]> {
  return useQuery<Workspace[]>({
    queryKey: ['workspaces', projectId],
    queryFn: () =>
      invoke('workspace:list', {
        projectId: projectId!,
        includeArchived: true,
      }),
    enabled: projectId != null,
  });
}

// ---------------------------------------------------------------------------
// Live event subscriptions
// ---------------------------------------------------------------------------

/**
 * Mounts a single effect that subscribes to all three workspace broadcast events
 * and keeps the TanStack query cache + Zustand store in sync.
 *
 * - `workspace:created`  → upsert into the `['workspaces', projectId]` cache and
 *                          the Zustand store (so the new item appears immediately).
 * - `workspace:status`   → update just the status field in-place in the cache and
 *                          store (avoids a full refetch for every status tick).
 * - `workspace:archived` → set status to `'archived'` and `worktreePath` to null
 *                          in cache + store.
 *
 * The effect cleans up ALL three subscriptions on unmount (leaks otherwise).
 * Mirrors the active-guard discipline in IpcHealth.tsx.
 */
export function useWorkspaceEvents(): void {
  const queryClient = useQueryClient();
  const upsertWorkspace = useWorkspacesStore((s) => s.upsertWorkspace);
  const markArchived = useWorkspacesStore((s) => s.markArchived);

  useEffect(() => {
    // Guard against state updates after unmount (React 18 StrictMode double-invoke).
    let active = true;

    /**
     * Helper: patch a single workspace entry in the `['workspaces', pid]` cache.
     * We operate on whichever project bucket contains this workspace; we don't know
     * the projectId from the event itself (only the workspaceId or the full DTO),
     * so we iterate over all cached project buckets.
     */
    function patchInCache(
      workspaceId: string,
      patcher: (ws: Workspace) => Workspace,
    ): void {
      // Collect all cached workspace query keys so we patch the right bucket.
      const allKeys = queryClient
        .getQueryCache()
        .getAll()
        .filter(
          (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'workspaces',
        );

      for (const cacheEntry of allKeys) {
        const key = cacheEntry.queryKey as ['workspaces', string | null];
        queryClient.setQueryData<Workspace[]>(key, (prev) => {
          if (!prev) return prev;
          return prev.map((ws) => (ws.id === workspaceId ? patcher(ws) : ws));
        });
      }
    }

    /**
     * Upsert a workspace into the correct project bucket in the cache.
     */
    function upsertInCache(workspace: Workspace): void {
      const key = ['workspaces', workspace.projectId] as const;
      queryClient.setQueryData<Workspace[]>(key, (prev) => {
        if (!prev) {
          // Cache not yet populated for this project; invalidate so the next
          // mount of useWorkspaces picks it up.
          void queryClient.invalidateQueries({ queryKey: key });
          return prev;
        }
        const idx = prev.findIndex((w) => w.id === workspace.id);
        if (idx === -1) return [...prev, workspace];
        const next = prev.slice();
        next[idx] = workspace;
        return next;
      });
    }

    const unsubCreated = onEvent('workspace:created', ({ workspace }) => {
      if (!active) return;
      upsertInCache(workspace);
      upsertWorkspace(workspace);
    });

    const unsubStatus = onEvent(
      'workspace:status',
      ({ workspaceId, status }) => {
        if (!active) return;
        patchInCache(workspaceId, (ws) => ({ ...ws, status }));
        // Also patch the Zustand store so components that subscribe to the store
        // get the update without waiting for a cache refetch.
        const current = useWorkspacesStore
          .getState()
          .workspaces.find((w) => w.id === workspaceId);
        if (current) {
          upsertWorkspace({ ...current, status });
        }
      },
    );

    const unsubArchived = onEvent('workspace:archived', ({ workspaceId }) => {
      if (!active) return;
      patchInCache(workspaceId, (ws) => ({
        ...ws,
        status: 'archived',
        worktreePath: null,
      }));
      markArchived(workspaceId);
    });

    return () => {
      active = false;
      unsubCreated();
      unsubStatus();
      unsubArchived();
    };
  }, [queryClient, upsertWorkspace, markArchived]);
}

// Re-export for convenience so Sidebar can get everything from one import.
export { useWorkspacesStore };
