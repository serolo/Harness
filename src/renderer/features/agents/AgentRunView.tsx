import type { AgentDispatchSummary, MetaRunDetail } from '@shared/agents';
import { Button, Dialog } from '@renderer/components/ui';
import { useWorkspacesStore } from '@renderer/stores/workspaces';

export function AgentRunView({
  run,
  onClose,
  onCancel,
  onTakeOver,
}: {
  run: MetaRunDetail;
  onClose: () => void;
  onCancel: () => void;
  onTakeOver: () => void;
}): React.JSX.Element {
  const selectWorkspace = useWorkspacesStore((state) => state.selectWorkspace);
  const isActive = run.status === 'starting' || run.status === 'running';
  const debby = run.agentProtocol === 'debby';
  const partnerDispatches = run.dispatches.filter(
    (dispatch) => debateStage(dispatch) === 'partner',
  );
  const critiqueRounds = [
    ...new Set(
      run.dispatches
        .filter((dispatch) => debateStage(dispatch) === 'critique')
        .map((dispatch) => debateRound(dispatch)),
    ),
  ].sort((left, right) => left - right);
  return (
    <Dialog
      fullScreen
      title={`${run.agentName} run`}
      onClose={onClose}
      contentClassName="min-h-0 overflow-y-auto p-5"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {isActive ? (
            <Button variant="secondary" onClick={onTakeOver}>
              Take over
            </Button>
          ) : null}
          {isActive ? (
            <Button variant="danger" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </>
      }
    >
      <div className="mb-4 rounded-3 border border-border-1 bg-surface-panel p-4">
        <div className="text-sm font-semibold text-fg-1">{run.goal}</div>
        <div className="mt-1 text-xs text-fg-3">
          {run.status} · revision {run.agentRevision.slice(0, 12)}
        </div>
        {run.coordinatorWorkspaceId ? (
          <Button
            className="mt-3"
            size="sm"
            variant="secondary"
            onClick={() => selectWorkspace(run.coordinatorWorkspaceId)}
          >
            Open coordinator workspace
          </Button>
        ) : null}
        {run.skillSnapshot?.length ? (
          <div className="mt-3" data-testid="meta-skill-snapshot">
            <div className="text-2xs font-semibold uppercase tracking-wide text-fg-3">
              Immutable skill snapshot
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-2xs text-fg-2">
              {run.skillSnapshot.map((skill) => (
                <span key={`${skill.slug}:${skill.digest}`}>
                  {skill.slug}@{skill.digest.slice(0, 12)}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <SkillUsage
          label="Coordinator agent-reported usage"
          usage={run.coordinatorSkillUsage}
        />
      </div>
      {debby ? (
        <div className="space-y-4" data-testid="debby-comparison">
          <DebateStage
            title="Independent partner responses"
            dispatches={partnerDispatches}
            onOpenWorkspace={selectWorkspace}
          />
          {critiqueRounds.map((round) => (
            <DebateStage
              key={round}
              title={`Critique round ${round}`}
              dispatches={run.dispatches.filter(
                (dispatch) =>
                  debateStage(dispatch) === 'critique' &&
                  debateRound(dispatch) === round,
              )}
              onOpenWorkspace={selectWorkspace}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3" data-testid="agent-dispatch-list">
          {run.dispatches.map((dispatch) => (
            <DispatchCard
              key={dispatch.id}
              dispatch={dispatch}
              onOpenWorkspace={selectWorkspace}
            />
          ))}
        </div>
      )}
      {run.finalSummary ? (
        <section className="mt-4 rounded-3 border border-accent-border bg-accent-muted p-4">
          <h3 className="text-sm font-semibold text-fg-1">Synthesis</h3>
          <pre className="mt-2 whitespace-pre-wrap break-words font-ui text-xs text-fg-2">
            {run.finalSummary}
          </pre>
        </section>
      ) : null}
    </Dialog>
  );
}

function debateStage(dispatch: AgentDispatchSummary): 'partner' | 'critique' {
  if (dispatch.debateStage) return dispatch.debateStage;
  return dispatch.purpose === 'critique' || dispatch.role.endsWith('-critic')
    ? 'critique'
    : 'partner';
}

function debateRound(dispatch: AgentDispatchSummary): number {
  return dispatch.debateRound ?? (debateStage(dispatch) === 'critique' ? 1 : 0);
}

function DebateStage({
  title,
  dispatches,
  onOpenWorkspace,
}: {
  title: string;
  dispatches: AgentDispatchSummary[];
  onOpenWorkspace: (id: string) => void;
}): React.JSX.Element {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-fg-2">{title}</h3>
      <div className="grid gap-3 md:grid-cols-2">
        {dispatches.map((dispatch) => (
          <DispatchCard
            key={dispatch.id}
            dispatch={dispatch}
            onOpenWorkspace={onOpenWorkspace}
          />
        ))}
      </div>
    </section>
  );
}

function DispatchCard({
  dispatch,
  onOpenWorkspace,
}: {
  dispatch: AgentDispatchSummary;
  onOpenWorkspace: (id: string) => void;
}): React.JSX.Element {
  return (
    <article className="rounded-3 border border-border-1 bg-surface-panel p-4">
      <div className="flex justify-between gap-3">
        <strong className="text-sm text-fg-1">{dispatch.role}</strong>
        <span className="text-xs text-fg-3">{dispatch.status}</span>
      </div>
      <div className="mt-1 text-2xs text-fg-3">
        {dispatch.harness}
        {dispatch.model ? ` · ${dispatch.model}` : ''} ·{' '}
        {dispatch.branch ?? 'allocating workspace'}
      </div>
      {dispatch.workspaceId ? (
        <Button
          className="mt-2"
          size="sm"
          variant="ghost"
          onClick={() => onOpenWorkspace(dispatch.workspaceId!)}
        >
          Open workspace
        </Button>
      ) : null}
      {dispatch.summary ? (
        <pre className="mt-3 whitespace-pre-wrap break-words font-ui text-xs text-fg-2">
          {dispatch.summary}
        </pre>
      ) : null}
      <SkillUsage label="Agent-reported usage" usage={dispatch.skillUsage} />
      {dispatch.error ? (
        <div className="mt-2 text-xs text-danger">{dispatch.error}</div>
      ) : null}
      {dispatch.changedFiles.length ? (
        <div className="mt-2 text-2xs text-fg-3">
          {dispatch.changedFiles.join(', ')}
        </div>
      ) : null}
      {dispatch.diffStat ? (
        <div className="mt-1 text-2xs text-fg-3">{dispatch.diffStat}</div>
      ) : null}
    </article>
  );
}

function SkillUsage({
  label,
  usage,
}: {
  label: string;
  usage: AgentDispatchSummary['skillUsage'];
}): React.JSX.Element | null {
  if (!usage?.reported) return null;
  return (
    <div className="mt-2 text-2xs text-fg-3" data-testid="meta-skill-usage">
      <span className="font-semibold">{label}:</span>{' '}
      {usage.skills.length
        ? usage.skills
            .map((skill) => `${skill.slug}@${skill.digest.slice(0, 12)}`)
            .join(', ')
        : 'none'}
    </div>
  );
}
