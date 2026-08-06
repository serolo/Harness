import { useEffect, useState } from 'react';
import type { MetaAgentDetail, MetaRunDetail } from '@shared/agents';
import { Button, Dialog, Textarea } from '@renderer/components/ui';
import { invoke } from '@renderer/ipc';
import { useAgents } from './useAgents';
import { AgentEditor } from './AgentEditor';
import { AgentRunView } from './AgentRunView';

export function AgentsPanel({
  projectId,
  workspaceId,
}: {
  projectId: string | null;
  workspaceId: string | null;
}): React.JSX.Element {
  const { agents, runs, loading, error, refetch } = useAgents(projectId);
  const [editor, setEditor] = useState<MetaAgentDetail | null>(null);
  const [run, setRun] = useState<MetaRunDetail | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [startingAgent, setStartingAgent] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [allowPush, setAllowPush] = useState(false);
  const [allowOpenPr, setAllowOpenPr] = useState(false);
  const [maxDispatches, setMaxDispatches] = useState('');
  const [maxParallel, setMaxParallel] = useState('');
  useEffect(() => {
    if (!run || !projectId) return;
    const summary = runs.find((item) => item.id === run.id);
    if (!summary) return;
    let active = true;
    void invoke('metaRun:get', { projectId, runId: run.id })
      .then((next) => {
        if (active) setRun(next);
      })
      .catch((reason: unknown) => {
        if (active) setActionError(messageFor(reason));
      });
    return () => {
      active = false;
    };
  }, [projectId, run?.id, runs]);
  if (!projectId || !workspaceId)
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-fg-3">
        Select a workspace to view project agents.
      </div>
    );
  const inspect = async (agentId: string): Promise<void> => {
    try {
      setEditor(await invoke('metaAgent:get', { projectId, agentId }));
      setActionError(null);
    } catch (reason) {
      setActionError(messageFor(reason));
    }
  };
  const openRun = async (runId: string): Promise<void> => {
    try {
      setRun(await invoke('metaRun:get', { projectId, runId }));
      setActionError(null);
    } catch (reason) {
      setActionError(messageFor(reason));
    }
  };
  const mutateRun = async (action: 'cancel' | 'takeOver'): Promise<void> => {
    if (!run) return;
    try {
      setRun(
        await invoke(`metaRun:${action}` as 'metaRun:cancel', {
          projectId,
          runId: run.id,
        }),
      );
      setActionError(null);
    } catch (reason) {
      setActionError(messageFor(reason));
    }
  };
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto p-3"
      data-testid="agents-panel"
    >
      {actionError ? (
        <div className="mb-3 text-sm text-danger">{actionError}</div>
      ) : null}
      <div className="mb-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void invoke('metaAgent:import', { projectId })
              .then(refetch)
              .catch((reason: unknown) => setActionError(messageFor(reason)))
          }
        >
          Import
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            void invoke('metaAgent:create', {
              projectId,
              slug: `agent-${Date.now().toString(36)}`,
              name: 'New agent',
            })
              .then((detail) => {
                refetch();
                setEditor(detail);
              })
              .catch((reason: unknown) => setActionError(messageFor(reason)))
          }
        >
          New agent
        </Button>
      </div>
      {loading ? (
        <div className="p-5 text-sm text-fg-3">Loading agents…</div>
      ) : error ? (
        <div className="p-5 text-sm text-danger">{error}</div>
      ) : agents.length === 0 ? (
        <div className="p-5 text-sm text-fg-3">No agents available.</div>
      ) : (
        agents.map((agent) => (
          <article
            key={agent.id}
            className="mb-2 rounded-3 border border-border-1 bg-surface-panel p-3"
            data-testid={`agent-${agent.slug}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-fg-1">
                  {agent.name}
                </h3>
                <p className="mt-1 text-xs text-fg-3">{agent.description}</p>
              </div>
              <span className="text-2xs uppercase text-fg-3">
                {agent.origin}
              </span>
            </div>
            <div className="mt-2 text-2xs text-fg-3">
              revision {agent.revision.slice(0, 8)} ·{' '}
              {agent.requiredProviders.join(', ') || 'no provider requirement'}
            </div>
            {agent.diagnostics.map((item, index) => (
              <div key={index} className="mt-1 text-xs text-danger">
                {item.message}
              </div>
            ))}
            {!agent.available ? (
              <div className="mt-1 text-xs text-warning">
                {agent.unavailableReasons.join('; ')}
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void inspect(agent.id)}
              >
                Inspect{agent.editable ? ' / edit' : ''}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void invoke('metaAgent:duplicate', {
                    projectId,
                    agentId: agent.id,
                    slug: `${agent.slug.slice(0, 55)}-copy`,
                  })
                    .then(refetch)
                    .catch((reason: unknown) =>
                      setActionError(messageFor(reason)),
                    )
                }
              >
                Duplicate
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!agent.available || !agent.valid}
                onClick={() => {
                  setStartingAgent(agent.id);
                  setGoal('');
                  setAllowPush(false);
                  setAllowOpenPr(false);
                  setMaxDispatches('');
                  setMaxParallel('');
                }}
              >
                Run
              </Button>
              {agent.editable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void invoke('metaAgent:delete', {
                      projectId,
                      agentId: agent.id,
                    })
                      .then(refetch)
                      .catch((reason: unknown) =>
                        setActionError(messageFor(reason)),
                      )
                  }
                >
                  Delete
                </Button>
              ) : null}
            </div>
          </article>
        ))
      )}
      {runs.length ? (
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-fg-3">
            Recent runs
          </h3>
          {runs.map((item) => (
            <button
              key={item.id}
              type="button"
              className="mb-1 flex w-full justify-between rounded-2 border border-border-1 bg-surface-panel px-3 py-2 text-left text-xs text-fg-2"
              onClick={() => void openRun(item.id)}
            >
              <span>
                {item.agentName}: {item.goal}
              </span>
              <span>{item.status}</span>
            </button>
          ))}
        </section>
      ) : null}
      {editor ? (
        <AgentEditor
          projectId={projectId}
          agent={editor}
          onClose={() => setEditor(null)}
          onSaved={(next) => {
            setEditor(next);
            refetch();
          }}
        />
      ) : null}
      {startingAgent ? (
        <Dialog
          title="Start agent run"
          onClose={() => setStartingAgent(null)}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setStartingAgent(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!goal.trim()}
                onClick={() =>
                  void invoke('metaAgent:startRun', {
                    projectId,
                    agentId: startingAgent,
                    sourceWorkspaceId: workspaceId,
                    goal,
                    allowPush,
                    allowOpenPr,
                    ...((maxDispatches || maxParallel) && {
                      policy: {
                        ...(maxDispatches
                          ? { maxDispatches: Number(maxDispatches) }
                          : {}),
                        ...(maxParallel
                          ? { maxParallel: Number(maxParallel) }
                          : {}),
                      },
                    }),
                  })
                    .then((next) => {
                      setRun(next);
                      setStartingAgent(null);
                      setActionError(null);
                      refetch();
                    })
                    .catch((reason: unknown) =>
                      setActionError(messageFor(reason)),
                    )
                }
              >
                Start
              </Button>
            </>
          }
        >
          <Textarea
            rows={8}
            value={goal}
            aria-label="Run goal"
            placeholder="What should this agent accomplish?"
            onChange={(event) => setGoal(event.target.value)}
          />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="text-xs text-fg-2">
              Max dispatches
              <input
                className="mt-1 w-full rounded-2 border border-border-1 bg-bg-2 px-2 py-1"
                type="number"
                min={1}
                max={32}
                value={maxDispatches}
                placeholder="Agent default"
                onChange={(event) => setMaxDispatches(event.target.value)}
              />
            </label>
            <label className="text-xs text-fg-2">
              Max parallel
              <input
                className="mt-1 w-full rounded-2 border border-border-1 bg-bg-2 px-2 py-1"
                type="number"
                min={1}
                max={8}
                value={maxParallel}
                placeholder="Agent default"
                onChange={(event) => setMaxParallel(event.target.value)}
              />
            </label>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs text-fg-2">
            <input
              type="checkbox"
              checked={allowPush}
              onChange={(event) => {
                setAllowPush(event.target.checked);
                if (!event.target.checked) setAllowOpenPr(false);
              }}
            />
            Push completed child branches when this run succeeds
          </label>
          <label className="mt-2 flex items-start gap-2 text-xs text-fg-2">
            <input
              type="checkbox"
              checked={allowOpenPr}
              onChange={(event) => {
                setAllowOpenPr(event.target.checked);
                if (event.target.checked) setAllowPush(true);
              }}
            />
            Open draft pull requests for completed child branches
          </label>
          <p className="mt-2 text-2xs text-fg-3">
            Consent is recorded with this run and uses Harness&apos;s reviewed,
            branch-only Git/PR workflow. Merging is never delegated.
          </p>
        </Dialog>
      ) : null}
      {run ? (
        <AgentRunView
          run={run}
          onClose={() => setRun(null)}
          onCancel={() => void mutateRun('cancel')}
          onTakeOver={() => void mutateRun('takeOver')}
        />
      ) : null}
    </div>
  );
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Agent action failed.';
}
