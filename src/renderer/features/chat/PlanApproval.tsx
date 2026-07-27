import { Check, Play } from 'lucide-react';

export function PlanApproval({
  onApprove,
}: {
  onApprove: () => void;
}): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-between gap-4 rounded-2 border border-accent/30 bg-accent/5 px-4 py-3"
      data-testid="plan-approval"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Check className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <div className="text-sm font-medium text-fg-1">Plan ready</div>
          <div className="text-xs text-fg-3">
            Review the plan above, then approve it to begin implementation.
          </div>
        </div>
      </div>
      <button
        type="button"
        className="flex shrink-0 items-center gap-2 rounded-1 bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        data-testid="plan-approve"
        onClick={onApprove}
      >
        <Play className="h-3.5 w-3.5" aria-hidden />
        Approve plan &amp; start
      </button>
    </div>
  );
}
