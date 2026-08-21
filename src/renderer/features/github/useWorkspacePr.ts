import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { PrSummary } from '@shared/github';
import { invoke } from '@renderer/ipc';

export interface WorkspacePrIdentity {
  workspaceId: string | null;
  branch?: string | null;
  prNumber?: number | null;
  poll?: boolean;
}

/**
 * Shared live PR lookup for the selected workspace.
 *
 * A failed background integration request must stay stopped until the user explicitly
 * retries it. Otherwise a network outage produces an endless timeout/refetch loop.
 */
export function useWorkspacePr({
  workspaceId,
  branch = null,
  prNumber = null,
  poll = true,
}: WorkspacePrIdentity): UseQueryResult<PrSummary | null, Error> {
  return useQuery<PrSummary | null, Error>({
    queryKey: ['workspace-pr', workspaceId, branch, prNumber],
    queryFn: async () => {
      if (!workspaceId) return null;
      return (await invoke('github:getWorkspacePr', { workspaceId })) ?? null;
    },
    enabled: workspaceId !== null,
    retry: false,
    staleTime: 15_000,
    refetchInterval: (query) => {
      if (!poll || query.state.error !== null) return false;
      const state = query.state.data?.state?.toLowerCase();
      if (state === 'closed' || state === 'merged') return false;
      return 60_000;
    },
    refetchOnWindowFocus: (query) => query.state.error === null,
  });
}
