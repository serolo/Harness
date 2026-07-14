// TaskRow — one scheduled task in the list (Phase 12). Shows the prompt, a StateBadge, and
// the model/mode/schedule meta, plus per-state actions:
//   - Run now:    pending | scheduled | missed | error | queued
//   - Mark done:  same set
//   - Reschedule: a prominent affordance for `missed` (opens the form on the schedule field)
//   - Edit:       any non-running state
//   - Delete:     hidden while running (the repo also rejects it)
// All actions delegate to callbacks the panel wires to `useTasks`.

import type { ScheduledTask } from '@shared/tasks';
import { Button } from '@renderer/components/ui';
import { StateBadge } from './StateBadge';

export interface TaskRowProps {
  task: ScheduledTask;
  onRunNow: (id: string) => void;
  onMarkDone: (id: string) => void;
  onEdit: (task: ScheduledTask, focusSchedule?: boolean) => void;
  onDelete: (id: string) => void;
}

/** States from which a task can be run / marked done (mirrors the server gate). */
const RUNNABLE = new Set(['pending', 'scheduled', 'missed', 'error', 'queued']);

/** States from which a task can be edited (mirrors the repo's EDITABLE_STATES). */
const EDITABLE = new Set(['pending', 'scheduled', 'missed', 'error']);

function formatSchedule(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function TaskRow({
  task,
  onRunNow,
  onMarkDone,
  onEdit,
  onDelete,
}: TaskRowProps): React.JSX.Element {
  const runnable = RUNNABLE.has(task.state);
  const editable = EDITABLE.has(task.state);
  const isRunning = task.state === 'running';

  return (
    <div
      className="flex flex-col gap-2 border-b border-border-1 px-4 py-3"
      data-testid={`task-row-${task.id}`}
      data-state={task.state}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-fg-1">
          {task.prompt}
        </p>
        <StateBadge state={task.state} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-3">
        <span>Model: {task.model ?? 'default'}</span>
        <span>Mode: {task.mode ?? 'workspace default'}</span>
        {task.scheduledAt != null ? (
          <span data-testid="task-schedule-label">
            {formatSchedule(task.scheduledAt)}
          </span>
        ) : (
          <span>Untimed</span>
        )}
        {task.state === 'error' && task.errorMessage ? (
          <span className="text-danger">{task.errorMessage}</span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {task.state === 'missed' ? (
          <Button
            variant="primary"
            size="sm"
            data-testid={`task-reschedule-${task.id}`}
            onClick={() => onEdit(task, true)}
          >
            Reschedule
          </Button>
        ) : null}
        {runnable ? (
          <Button
            variant="secondary"
            size="sm"
            data-testid={`task-run-${task.id}`}
            onClick={() => onRunNow(task.id)}
          >
            Run now
          </Button>
        ) : null}
        {runnable ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid={`task-done-${task.id}`}
            onClick={() => onMarkDone(task.id)}
          >
            Mark done
          </Button>
        ) : null}
        {editable ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid={`task-edit-${task.id}`}
            onClick={() => onEdit(task)}
          >
            Edit
          </Button>
        ) : null}
        {!isRunning ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid={`task-delete-${task.id}`}
            onClick={() => onDelete(task.id)}
          >
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}
