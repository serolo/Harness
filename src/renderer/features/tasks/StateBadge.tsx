// StateBadge — a small colored pill for a task's lifecycle state (Phase 12). Pure
// presentational: maps each `TaskState` to a label + Tailwind color classes, mirroring the
// design-system color tokens used elsewhere (danger/amber/muted). `running` pulses;
// `queued` reads "waiting for active turn…".

import type { TaskState } from '@shared/tasks';

const LABELS: Record<TaskState, string> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  queued: 'Waiting for active turn…',
  running: 'Running',
  done: 'Done',
  missed: 'Missed',
  error: 'Error',
};

const CLASSES: Record<TaskState, string> = {
  pending: 'bg-bg-3 text-fg-2',
  scheduled: 'bg-bg-3 text-fg-1',
  queued: 'bg-bg-3 text-fg-3',
  running: 'bg-accent-muted text-accent animate-pulse',
  done: 'bg-bg-3 text-fg-3',
  missed: 'bg-warn-muted text-warn',
  error: 'bg-danger-muted text-danger',
};

export function StateBadge({ state }: { state: TaskState }): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-1 px-1.5 py-0.5 text-2xs font-medium ${CLASSES[state]}`}
      data-testid={`task-state-${state}`}
    >
      {LABELS[state]}
    </span>
  );
}
