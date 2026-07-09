// A divider between turns showing terminal status + token usage.

import type { Usage } from '@shared/harness';
import type { TurnStatus } from '@shared/models';

export interface TurnDividerProps {
  status: TurnStatus;
  usage?: Usage;
}

const STATUS_LABEL: Record<TurnStatus, string> = {
  streaming: 'streaming…',
  completed: 'completed',
  interrupted: 'interrupted',
  error: 'error',
};

const STATUS_CLASS: Record<TurnStatus, string> = {
  streaming: 'text-amber-300',
  completed: 'text-emerald-400',
  interrupted: 'text-slate-400',
  error: 'text-red-400',
};

export function TurnDivider({
  status,
  usage,
}: TurnDividerProps): React.JSX.Element {
  const tokens =
    usage && (usage.inputTokens != null || usage.outputTokens != null)
      ? `${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out`
      : null;

  return (
    <div
      className="my-2 flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500"
      data-testid="turn-divider"
      data-status={status}
    >
      <span className="h-px flex-1 bg-slate-800" />
      <span className={STATUS_CLASS[status]}>{STATUS_LABEL[status]}</span>
      {tokens && <span className="text-slate-600">· {tokens}</span>}
      <span className="h-px flex-1 bg-slate-800" />
    </div>
  );
}
