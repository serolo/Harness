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
  streaming: 'text-warn',
  completed: 'text-ok',
  interrupted: 'text-fg-3',
  error: 'text-danger',
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
      className="my-2 flex items-center gap-2 text-2xs uppercase tracking-caps text-fg-3"
      data-testid="turn-divider"
      data-status={status}
    >
      <span className="h-px flex-1 bg-border-1" />
      <span className={STATUS_CLASS[status]}>{STATUS_LABEL[status]}</span>
      {tokens && <span className="text-fg-3">· {tokens}</span>}
      <span className="h-px flex-1 bg-border-1" />
    </div>
  );
}
