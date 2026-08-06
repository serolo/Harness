import { useCallback, useEffect, useState } from 'react';
import type { MetaAgentSummary, MetaRunSummary } from '@shared/agents';
import { invoke, onEvent } from '@renderer/ipc';

export function useAgents(projectId: string | null): {
  agents: MetaAgentSummary[];
  runs: MetaRunSummary[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const [agents, setAgents] = useState<MetaAgentSummary[]>([]);
  const [runs, setRuns] = useState<MetaRunSummary[]>([]);
  const [loading, setLoading] = useState(projectId !== null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    void Promise.all([
      invoke('metaAgent:list', { projectId }),
      invoke('metaRun:list', { projectId }),
    ])
      .then(([nextAgents, nextRuns]) => {
        setAgents(nextAgents);
        setRuns(nextRuns);
        setError(null);
      })
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error ? reason.message : 'Could not load agents.',
        ),
      )
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setAgents([]);
      setRuns([]);
      setLoading(false);
      return;
    }
    let active = true;
    const guardedLoad = (): void => {
      if (active) load();
    };
    guardedLoad();
    const offAgent = onEvent('metaAgent:changed', (event) => {
      if (event.projectId === projectId) guardedLoad();
    });
    const offRun = onEvent('metaRun:changed', (event) => {
      if (event.projectId === projectId) guardedLoad();
    });
    return () => {
      active = false;
      offAgent();
      offRun();
    };
  }, [load, projectId]);

  return { agents, runs, loading, error, refetch: load };
}
