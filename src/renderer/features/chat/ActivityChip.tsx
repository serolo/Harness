import { Activity } from 'lucide-react';

export interface ActivityChipProps {
  title: string;
  detail?: string;
}

export function ActivityChip({
  title,
  detail,
}: ActivityChipProps): React.JSX.Element {
  return (
    <div
      className="flex min-h-8 min-w-0 items-center gap-2 rounded-2 px-1.5 text-base text-fg-2"
      data-testid="activity-chip"
    >
      <Activity className="h-4 w-4 shrink-0 text-fg-3" aria-hidden />
      <span className="shrink-0 font-medium text-fg-1">{title}</span>
      {detail && <span className="min-w-0 truncate font-mono text-sm">{detail}</span>}
    </div>
  );
}
