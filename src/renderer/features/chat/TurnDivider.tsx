// A divider between turns showing terminal status + token usage.

import type { Usage } from '@shared/harness';
import type { TurnStatus } from '@shared/models';
import { formatTokenCount, formatUsdMicros } from '@shared/billing';

export interface TurnDividerProps {
  status: TurnStatus;
  usage?: Usage;
  model?: string;
  costMicros?: number;
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
  model,
  costMicros,
}: TurnDividerProps): React.JSX.Element {
  const tokens =
    usage && (usage.inputTokens != null || usage.outputTokens != null)
      ? `${formatTokenCount(usage.inputTokens ?? 0)} in / ${formatTokenCount(
          usage.outputTokens ?? 0,
        )} out`
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
      {model ? (
        <span className="normal-case tracking-normal text-fg-3">· {model}</span>
      ) : null}
      {costMicros !== undefined ? (
        <span
          className="normal-case tracking-normal text-fg-3"
          title="Estimated provider API list price, including prompt-cache reads and writes. Subscription plans may not be billed per turn."
        >
          · API est. {formatUsdMicros(costMicros)}
        </span>
      ) : null}
      <span className="h-px flex-1 bg-border-1" />
    </div>
  );
}
