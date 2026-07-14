// TaskForm — the create/edit dialog for a scheduled task (Phase 12). Fields: a prompt
// textarea, the ModelPicker, a permission-mode select (defaulting to "Workspace default"
// = the effective `agent.mode`), and an OPTIONAL `datetime-local` schedule that maps to
// epoch millis (no new dependency). Client-side `MODEL_PATTERN` validation gives a
// friendlier error; the IPC boundary re-validates. Emits the field values to `onSubmit`;
// the parent (`TasksPanel`) decides create vs update.

import { useState } from 'react';
import type { AgentMode } from '@shared/harness';
import type { ScheduledTask } from '@shared/tasks';
import { MODEL_PATTERN } from '@shared/tasks';
import { Dialog, Button, Textarea, Select } from '@renderer/components/ui';
import { ModelPicker } from './ModelPicker';

/** The values a submit yields. `null` clears a nullable field (edit); create maps to undefined. */
export interface TaskFormValues {
  prompt: string;
  model: string | null;
  mode: AgentMode | null;
  scheduledAt: number | null;
}

export interface TaskFormProps {
  mode: 'create' | 'edit';
  initial?: ScheduledTask;
  /** Focus the schedule field on open (the missed-task "Reschedule" affordance). */
  focusSchedule?: boolean;
  /** The effective `agent.mode` (for the "Workspace default (…)" label). */
  defaultAgentMode?: AgentMode;
  onSubmit: (values: TaskFormValues) => Promise<void>;
  onClose: () => void;
}

/** Sentinel select value meaning "use the workspace's effective agent.mode at fire time". */
const WORKSPACE_DEFAULT = '__workspace_default__';

/** Format epoch millis as a local `datetime-local` input value (YYYY-MM-DDTHH:mm). */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function TaskForm({
  mode,
  initial,
  focusSchedule,
  defaultAgentMode,
  onSubmit,
  onClose,
}: TaskFormProps): React.JSX.Element {
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [model, setModel] = useState<string | null>(initial?.model ?? null);
  const [taskMode, setTaskMode] = useState<AgentMode | null>(
    initial?.mode ?? null,
  );
  const [scheduleInput, setScheduleInput] = useState<string>(
    initial?.scheduledAt != null ? toLocalInput(initial.scheduledAt) : '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const promptEmpty = prompt.trim() === '';
  const modelInvalid =
    model !== null && model !== '' && !MODEL_PATTERN.test(model);
  const canSubmit = !promptEmpty && !modelInvalid && !submitting;

  const modeOptions = [
    {
      value: WORKSPACE_DEFAULT,
      label: defaultAgentMode
        ? `Workspace default (${defaultAgentMode})`
        : 'Workspace default',
    },
    { value: 'plan', label: 'plan' },
    { value: 'default', label: 'default' },
    { value: 'auto_accept', label: 'auto_accept' },
  ];

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    // An empty custom model string means "no model" (CLI default).
    const normalizedModel = model === null || model === '' ? null : model;
    const scheduledAt =
      scheduleInput === '' ? null : new Date(scheduleInput).getTime();
    if (scheduledAt !== null && !Number.isFinite(scheduledAt)) {
      setError('Invalid schedule time.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        prompt: prompt.trim(),
        model: normalizedModel,
        mode: taskMode,
        scheduledAt,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the task.');
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title={mode === 'create' ? 'New task' : 'Edit task'}
      width={520}
      onClose={onClose}
      data-testid="task-form"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            data-testid="task-form-submit"
            onClick={() => void handleSubmit()}
          >
            {mode === 'create' ? 'Create' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-2">Prompt</span>
          <Textarea
            value={prompt}
            rows={4}
            placeholder="What should the agent do?"
            data-testid="task-prompt"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-2">Model</span>
          <ModelPicker value={model} onChange={setModel} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-2">Permission mode</span>
          <Select
            options={modeOptions}
            value={taskMode ?? WORKSPACE_DEFAULT}
            data-testid="task-mode-select"
            onChange={(e) =>
              setTaskMode(
                e.target.value === WORKSPACE_DEFAULT
                  ? null
                  : (e.target.value as AgentMode),
              )
            }
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-2">
            Schedule (optional)
          </span>
          <input
            type="datetime-local"
            value={scheduleInput}
            autoFocus={focusSchedule}
            data-testid="task-schedule"
            className="h-control box-border rounded-2 border border-border-2 bg-surface-well px-2.5 font-ui text-sm text-fg-1"
            onChange={(e) => setScheduleInput(e.target.value)}
          />
          <span className="text-2xs text-fg-3">
            Leave empty to run manually (Run now / Mark done).
          </span>
        </label>

        {error ? (
          <span className="text-xs text-danger" data-testid="task-form-error">
            {error}
          </span>
        ) : null}
      </div>
    </Dialog>
  );
}
