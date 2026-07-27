import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import type { MonthlyUsage } from '@shared/billing';
import { formatUsdMicros } from '@shared/billing';
import { invoke } from '@renderer/ipc';
import { IconButton } from '@renderer/components/ui';

export interface UsagePanelProps {
  onClose: () => void;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthRequest(date: Date): {
  month: string;
  startAt: number;
  endAt: number;
} {
  return {
    month: monthKey(date),
    startAt: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
    endAt: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(),
  };
}

function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function modelColor(index: number): string {
  return ['bg-accent', 'bg-ok', 'bg-warn', 'bg-danger', 'bg-fg-3'][index % 5];
}

export function UsagePanel({ onClose }: UsagePanelProps): React.JSX.Element {
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [usage, setUsage] = useState<MonthlyUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useMemo(() => monthRequest(month), [month]);

  useEffect(() => {
    let active = true;
    setUsage(null);
    setError(null);
    void invoke('usage:monthly', request)
      .then((result) => {
        if (active) setUsage(result);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [request]);

  const title = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(month);
  const currentMonth = monthKey(new Date());

  return (
    <div
      className="flex h-[720px] max-h-[86vh] flex-col"
      data-testid="usage-panel"
    >
      <header className="flex items-center gap-3 border-b border-border-1 px-5 py-4">
        <IconButton label="Close usage" size="sm" onClick={onClose}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </IconButton>
        <div>
          <h1 className="font-display text-lg font-semibold text-fg-1">
            Usage
          </h1>
          <p className="text-xs text-fg-3">
            Estimated API-equivalent spend in USD
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <IconButton
            label="Previous month"
            size="sm"
            onClick={() => setMonth((value) => shiftMonth(value, -1))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </IconButton>
          <span className="min-w-36 text-center text-sm text-fg-2">
            {title}
          </span>
          <IconButton
            label="Next month"
            size="sm"
            disabled={request.month >= currentMonth}
            onClick={() => setMonth((value) => shiftMonth(value, 1))}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </IconButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {!usage && !error ? (
          <p className="text-sm text-fg-3">Loading usage…</p>
        ) : null}
        {usage ? (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-3">
              <Metric
                label="Estimated spend"
                value={formatUsdMicros(usage.totalCostMicros)}
              />
              <Metric label="Turns" value={String(usage.turns)} />
              <Metric
                label="Tokens"
                value={new Intl.NumberFormat().format(
                  usage.inputTokens + usage.outputTokens,
                )}
              />
            </div>

            <section className="rounded-2 border border-border-1 bg-surface-panel p-5">
              <h2 className="mb-1 font-display text-sm font-semibold text-fg-1">
                Spend by model
              </h2>
              <p className="mb-5 text-xs text-fg-3">
                Each segment represents its share of this month’s estimate.
              </p>
              {usage.models.length === 0 ? (
                <p className="py-8 text-center text-sm text-fg-3">
                  No priced usage for this month.
                </p>
              ) : (
                <>
                  <div
                    className="mb-5 flex h-4 overflow-hidden rounded-full bg-bg-3"
                    role="img"
                    aria-label={`Estimated spend by model for ${title}`}
                  >
                    {usage.models.map((row, index) => (
                      <span
                        key={`${row.harness}:${row.model}`}
                        className={modelColor(index)}
                        style={{
                          width: `${(row.costMicros / usage.totalCostMicros) * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                  <div className="divide-y divide-border-1">
                    {usage.models.map((row, index) => (
                      <div
                        key={`${row.harness}:${row.model}`}
                        className="flex items-center gap-3 py-3"
                      >
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${modelColor(index)}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-fg-1">
                            {row.model}
                          </p>
                          <p className="text-xs text-fg-3">
                            {row.harness.replace('_', ' ')} · {row.turns} turns
                            ·{' '}
                            {new Intl.NumberFormat().format(
                              row.inputTokens + row.outputTokens,
                            )}{' '}
                            tokens
                          </p>
                        </div>
                        <span className="font-mono text-sm text-fg-2">
                          {formatUsdMicros(row.costMicros)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>

            {usage.unpricedTurns > 0 ? (
              <p className="rounded-2 border border-warn/30 bg-warn/10 px-4 py-3 text-xs text-warn">
                {usage.unpricedTurns} turn{usage.unpricedTurns === 1 ? '' : 's'}{' '}
                could not be priced because the exact model or rate was
                unavailable.
              </p>
            ) : null}
            <p className="text-xs leading-relaxed text-fg-3">
              Estimates use public standard API token rates. Subscription plans,
              regional processing, long-context tiers, tools, and provider
              credits can make the amount differ from an invoice.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="rounded-2 border border-border-1 bg-surface-panel p-4">
      <p className="text-xs uppercase tracking-caps text-fg-3">{label}</p>
      <p className="mt-2 font-display text-2xl font-semibold text-fg-1">
        {value}
      </p>
    </div>
  );
}
