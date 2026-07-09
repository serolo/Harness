// Status badge pill rendered next to each workspace row in the sidebar.
//
// Maps the five `WorkspaceStatus` values to a color + optional animation:
//   idle            → slate/neutral (workspace is ready but not running)
//   working         → amber + pulse (agent is actively working)
//   needs_attention → red (something requires the user's input)
//   running         → emerald (dev-server is live)
//   archived        → slate/dim (workspace is archived — shown in the collapsed section)

import type { WorkspaceStatus } from '@shared/models';

/** Presentational config per status. */
const STATUS_CONFIG: Record<
  WorkspaceStatus,
  { dotClass: string; label: string }
> = {
  idle: {
    dotClass: 'bg-slate-500',
    label: 'idle',
  },
  working: {
    dotClass: 'bg-amber-400 animate-pulse',
    label: 'working',
  },
  needs_attention: {
    dotClass: 'bg-red-500',
    label: 'attention',
  },
  running: {
    dotClass: 'bg-emerald-500',
    label: 'running',
  },
  archived: {
    dotClass: 'bg-slate-700',
    label: 'archived',
  },
};

export interface StatusBadgeProps {
  status: WorkspaceStatus;
}

/**
 * A small colored pill that conveys the current workspace lifecycle status.
 * Accessible: the label text is visible; `data-status` is present for tests
 * and conditional CSS targeting.
 */
export function StatusBadge({ status }: StatusBadgeProps): React.JSX.Element {
  const { dotClass, label } = STATUS_CONFIG[status];

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-slate-300"
      data-testid="status-badge"
      data-status={status}
      aria-label={`Status: ${label}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`}
      />
      {label}
    </span>
  );
}
