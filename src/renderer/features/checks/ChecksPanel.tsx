// ChecksPanel — the right context pane's merge-readiness view (spec §5.5). Wires
// `useChecks(workspaceId)` to the presentational parts: a red BlockerList of actionable
// rows up top, a PrCard, one SignalRow per aggregated `CheckItem` with source-specific
// detail (CI runs, review threads, deployments, todos), and a MergeButton gated on green.
// All main access happens inside `useChecks` via `@renderer/ipc`; this component is view +
// wiring only. External links (PR, CI logs, deployment URLs) open via plain anchors — the
// sandboxed renderer must not import electron's `shell`.

import type { CheckDetails, CheckItem } from '@shared/checks';
import type { ReviewThread } from '@shared/github';
import { Button } from '@renderer/components/ui';
import { SignalRow } from './SignalRow';
import { BlockerList } from './BlockerList';
import { PrCard } from './PrCard';
import { MergeButton } from './MergeButton';
import { useChecks } from './useChecks';

export interface ChecksPanelProps {
  workspaceId: string | null;
}

export function ChecksPanel({
  workspaceId,
}: ChecksPanelProps): React.JSX.Element {
  const { result, loading, error, runBlockerAction, merge, resolveThread } =
    useChecks(workspaceId);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
        data-testid="checks-empty"
      >
        Select a workspace to view its checks.
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-danger"
        data-testid="checks-error"
      >
        Could not load checks.
      </div>
    );
  }

  if (loading && result === null) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
        data-testid="checks-loading"
      >
        Loading checks…
      </div>
    );
  }

  if (result === null) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
        data-testid="checks-none"
      >
        No checks available.
      </div>
    );
  }

  const prItem = result.items.find((item) => item.source === 'pr');
  const prDetails =
    prItem?.details?.source === 'pr' ? prItem.details : undefined;

  const hasBlocker = result.items.some((item) => item.severity === 'blocker');
  const mergeDisabled = result.state !== 'green' || hasBlocker;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-surface-panel"
      data-testid="checks-panel"
      data-state={result.state}
    >
      {/* Header: overall roll-up state. */}
      <div className="flex items-center justify-between border-b border-border-1 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-caps text-fg-3">
          Checks
        </span>
        <span className="text-xs text-fg-3" data-testid="checks-state-label">
          {result.state}
        </span>
      </div>

      {/* Actionable blockers, each with a one-click fix button. */}
      <BlockerList
        items={result.items}
        onAction={(a) => void runBlockerAction(a)}
      />

      {/* PR summary card (external link opens on GitHub). */}
      {prDetails ? <PrCard details={prDetails} /> : null}

      {/* One SignalRow per aggregated item, plus per-source detail. */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {result.items.map((item) => (
          <div key={item.source} data-testid={`check-item-${item.source}`}>
            <SignalRow item={item} />
            <CheckDetailBlock item={item} onResolveThread={resolveThread} />
          </div>
        ))}
      </div>

      {/* Merge control — disabled unless the roll-up is green (server also gates). */}
      <MergeButton
        disabled={mergeDisabled}
        onMerge={(method) => merge(method)}
      />
    </div>
  );
}

/**
 * Render the source-specific detail beneath a SignalRow. Narrows on `details.source` so
 * each variant renders its own payload (CI runs + log links, review threads + resolve,
 * deployment environments, open todos). Sources without extra detail render nothing.
 */
function CheckDetailBlock({
  item,
  onResolveThread,
}: {
  item: CheckItem;
  onResolveThread: (threadId: string) => Promise<void>;
}): React.JSX.Element | null {
  const details = item.details;
  if (details === undefined) return null;

  switch (details.source) {
    case 'ci':
      return <CiDetail details={details} />;
    case 'review':
      return (
        <ReviewDetail details={details} onResolveThread={onResolveThread} />
      );
    case 'deployment':
      return <DeploymentDetail details={details} />;
    case 'todos':
      return <TodosDetail details={details} />;
    case 'git':
    case 'pr':
      return null;
  }
}

function CiDetail({
  details,
}: {
  details: Extract<CheckDetails, { source: 'ci' }>;
}): React.JSX.Element | null {
  if (details.runs.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 px-3 pb-1 pl-14 text-xs text-fg-2">
      {details.runs.map((run, idx) => (
        <li key={`${run.name}-${idx}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{run.name}</span>
          <span className="shrink-0 text-fg-3">
            {run.conclusion ?? 'running'}
          </span>
          {run.detailsUrl ? (
            <a
              href={run.detailsUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-link underline"
            >
              logs
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ReviewDetail({
  details,
  onResolveThread,
}: {
  details: Extract<CheckDetails, { source: 'review' }>;
  onResolveThread: (threadId: string) => Promise<void>;
}): React.JSX.Element | null {
  // `threads` is opaque (`unknown[]`) in the shared contract; narrow to the shared
  // `ReviewThread` shape for the resolve affordance (read-only render + id-keyed action).
  const threads = (details.threads ?? []) as ReviewThread[];
  const unresolved = threads.filter((thread) => !thread.resolved);
  if (unresolved.length === 0) return null;

  return (
    <ul className="flex flex-col gap-0.5 px-3 pb-1 pl-14 text-xs text-fg-2">
      {unresolved.map((thread) => (
        <li key={thread.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {thread.path
              ? `${thread.path}${thread.line != null ? `:${thread.line}` : ''}`
              : 'thread'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0 text-2xs"
            data-testid={`resolve-thread-${thread.id}`}
            onClick={() => void onResolveThread(thread.id)}
          >
            Resolve
          </Button>
        </li>
      ))}
    </ul>
  );
}

function DeploymentDetail({
  details,
}: {
  details: Extract<CheckDetails, { source: 'deployment' }>;
}): React.JSX.Element | null {
  if (details.environments.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 px-3 pb-1 pl-14 text-xs text-fg-2">
      {details.environments.map((env, idx) => (
        <li key={`${env.name}-${idx}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{env.name}</span>
          <span className="shrink-0 text-fg-3">{env.state}</span>
          {env.url ? (
            <a
              href={env.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-link underline"
            >
              open
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TodosDetail({
  details,
}: {
  details: Extract<CheckDetails, { source: 'todos' }>;
}): React.JSX.Element | null {
  const open = details.items.filter((todo) => !todo.done);
  if (open.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 px-3 pb-1 pl-14 text-xs text-fg-2">
      {open.map((todo, idx) => (
        <li key={idx} className="truncate">
          {todo.body}
        </li>
      ))}
    </ul>
  );
}
