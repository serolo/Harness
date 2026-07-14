// TasksPanel — the "Tasks" center-tab view for the selected workspace (Phase 12). Wires
// `useTasks(workspaceId)` to the list of TaskRows + a "New task" button + the TaskForm
// dialog (create / edit / reschedule). Fetches the effective `agent.mode` once so the
// form can label the "Workspace default" option. All main access happens inside
// `useTasks` / a one-shot `settings:getEffective`, via `@renderer/ipc`.

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { AgentMode } from '@shared/harness';
import type { ScheduledTask } from '@shared/tasks';
import { invoke } from '@renderer/ipc';
import { Button } from '@renderer/components/ui';
import { useTasks } from './useTasks';
import { TaskRow } from './TaskRow';
import { TaskForm, type TaskFormValues } from './TaskForm';

export interface TasksPanelProps {
  workspaceId: string | null;
}

/** The open form dialog: create, or edit a specific task (optionally on the schedule field). */
type FormState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; task: ScheduledTask; focusSchedule: boolean };

export function TasksPanel({
  workspaceId,
}: TasksPanelProps): React.JSX.Element {
  const {
    tasks,
    loading,
    error,
    createTask,
    updateTask,
    deleteTask,
    runNow,
    markDone,
  } = useTasks(workspaceId);
  const [form, setForm] = useState<FormState>({ kind: 'closed' });
  const [defaultMode, setDefaultMode] = useState<AgentMode | undefined>();

  // Fetch the effective agent.mode once, for the form's "Workspace default (…)" label.
  useEffect(() => {
    let active = true;
    void invoke('settings:getEffective', undefined)
      .then((s) => {
        if (active) setDefaultMode(s.agent.mode);
      })
      .catch(() => {
        /* the label just omits the resolved mode on failure */
      });
    return () => {
      active = false;
    };
  }, []);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
        data-testid="tasks-empty-workspace"
      >
        Select a workspace to view its tasks.
      </div>
    );
  }

  async function handleSubmit(values: TaskFormValues): Promise<void> {
    if (form.kind === 'edit') {
      await updateTask({
        id: form.task.id,
        prompt: values.prompt,
        model: values.model,
        mode: values.mode,
        scheduledAt: values.scheduledAt,
      });
    } else {
      // Create: the request type uses optional fields (no null), so map null → undefined.
      await createTask({
        prompt: values.prompt,
        model: values.model ?? undefined,
        mode: values.mode ?? undefined,
        scheduledAt: values.scheduledAt ?? undefined,
      });
    }
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-surface-app"
      data-testid="tasks-panel"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-1 bg-surface-panel px-4">
        <span className="text-sm font-semibold text-fg-1">Tasks</span>
        <Button
          variant="primary"
          size="sm"
          data-testid="task-new"
          onClick={() => setForm({ kind: 'create' })}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New task
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div
            className="flex h-full items-center justify-center p-6 text-sm text-danger"
            data-testid="tasks-error"
          >
            Could not load tasks.
          </div>
        ) : loading && tasks.length === 0 ? (
          <div
            className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
            data-testid="tasks-loading"
          >
            Loading tasks…
          </div>
        ) : tasks.length === 0 ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-fg-3"
            data-testid="tasks-empty"
          >
            <p>No tasks yet.</p>
            <p className="text-2xs">
              Create a task to run a prompt on a schedule, or on demand.
            </p>
          </div>
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onRunNow={(id) => void runNow(id)}
              onMarkDone={(id) => void markDone(id)}
              onEdit={(t, focusSchedule) =>
                setForm({
                  kind: 'edit',
                  task: t,
                  focusSchedule: focusSchedule ?? false,
                })
              }
              onDelete={(id) => void deleteTask(id)}
            />
          ))
        )}
      </div>

      {form.kind !== 'closed' ? (
        <TaskForm
          mode={form.kind === 'create' ? 'create' : 'edit'}
          initial={form.kind === 'edit' ? form.task : undefined}
          focusSchedule={form.kind === 'edit' ? form.focusSchedule : false}
          defaultAgentMode={defaultMode}
          onSubmit={handleSubmit}
          onClose={() => setForm({ kind: 'closed' })}
        />
      ) : null}
    </div>
  );
}
