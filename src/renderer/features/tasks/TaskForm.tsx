// TaskForm — the create/edit dialog for a scheduled task (Phase 12). Fields: a prompt
// textarea, the ModelPicker, a provider-aware reasoning-effort select, plan mode, and an
// OPTIONAL `datetime-local` schedule that maps to
// epoch millis (no new dependency). New tasks stay scoped to the workspace that opened
// the dialog. Client-side `MODEL_PATTERN` validation gives a friendlier error; the IPC
// boundary re-validates. Emits the field values to `onSubmit`; the parent (`TasksPanel`)
// decides create vs update.

import { useEffect, useRef, useState } from 'react';
import type {
  AgentMode,
  Attachment,
  HarnessId,
  ReasoningEffort,
} from '@shared/harness';
import type { ScheduledTask } from '@shared/tasks';
import type { MetaAgentSummary } from '@shared/agents';
import { MODEL_PATTERN } from '@shared/tasks';
import {
  expandSlashTemplate,
  matchSlashCommands,
  parseSlash,
  type SlashCommand,
} from '@shared/slash';
import { Dialog, Button, Textarea } from '@renderer/components/ui';
import { Check, Clock3, Gauge, Map, Plus } from 'lucide-react';
import { invoke } from '@renderer/ipc';
import { AttachmentBar } from '../chat/AttachmentBar';
import { ModelPicker } from './ModelPicker';
import { visibleProviderModelGroups } from '../chat/modelCatalog';
import { effortOptionsForHarness } from '../chat/effortCatalog';
import { readModelPreferences } from '../settings/modelPreferences';
import { AgentPicker } from '../agents/AgentPicker';

/** The values a submit yields. `null` clears a nullable field (edit); create maps to undefined. */
export interface TaskFormValues {
  prompt: string;
  model: string | null;
  mode: AgentMode | null;
  scheduledAt: number | null;
  workspaceId: string;
  harnessOverride: HarnessId | null;
  attachments: Attachment[];
  effort: ReasoningEffort | null;
  agentId: string | null;
}

export interface TaskFormProps {
  mode: 'create' | 'edit';
  initial?: ScheduledTask;
  /** Focus the schedule field on open (the missed-task "Reschedule" affordance). */
  focusSchedule?: boolean;
  /** The effective `agent.mode` shown for the inherited mode option. */
  defaultAgentMode?: AgentMode;
  workspaceId: string;
  projectId?: string | null;
  onSubmit: (values: TaskFormValues) => Promise<void>;
  onClose: () => void;
}

type ScheduleKind = 'now' | 'specific' | 'relative';
const RELATIVE_SCHEDULE_PRESETS = [
  { minutes: 2, label: '2 min' },
  { minutes: 5, label: '5 min' },
  { minutes: 10, label: '10 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 480, label: '8 hours' },
  { minutes: 1_440, label: '1 day' },
] as const;

function relativeScheduleDescription(minutes: number): string {
  if (minutes < 60) return `Runs in ${minutes} minutes`;
  if (minutes === 1_440) return 'Runs in 1 day';
  const hours = minutes / 60;
  return `Runs in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

function slashQuery(input: string): string | null {
  return /^\/([A-Za-z0-9_-]*)$/.exec(input)?.[1] ?? null;
}

function commandDescription(command: SlashCommand): string {
  return (
    command.description ??
    command.template.split('\n').find((line) => line.trim() !== '') ??
    ''
  );
}

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
  workspaceId,
  projectId = null,
  onSubmit,
  onClose,
}: TaskFormProps): React.JSX.Element {
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [model, setModel] = useState<string | null>(initial?.model ?? null);
  const [harnessOverride, setHarnessOverride] = useState<HarnessId | null>(
    initial?.harnessOverride ?? null,
  );
  const [attachments, setAttachments] = useState<Attachment[]>(
    initial?.attachments ?? [],
  );
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const preferences = readModelPreferences();
  const defaultModelHarness = visibleProviderModelGroups()
    .flatMap((group) => group.options)
    .find(
      (option) =>
        option.id === preferences.defaultModel ||
        option.model === preferences.defaultModel,
    )?.harness;
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [effort, setEffort] = useState<ReasoningEffort>(
    initial?.effort ??
      (['low', 'medium', 'high', 'xhigh', 'max'].includes(
        preferences.defaultEffort,
      )
        ? (preferences.defaultEffort as ReasoningEffort)
        : 'high'),
  );
  const [taskMode, setTaskMode] = useState<AgentMode | null>(
    initial?.mode ?? null,
  );
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashActive, setSlashActive] = useState(0);
  const slashLoadedForRef = useRef<string | null>(null);
  const [scheduleInput, setScheduleInput] = useState<string>(
    initial?.scheduledAt != null ? toLocalInput(initial.scheduledAt) : '',
  );
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(
    initial?.scheduledAt != null ? 'specific' : 'now',
  );
  const [relativeDelayMinutes, setRelativeDelayMinutes] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<MetaAgentSummary[]>([]);
  const [agentId, setAgentId] = useState<string | null>(
    initial?.agentId ?? null,
  );

  const promptEmpty = prompt.trim() === '';
  const modelInvalid =
    model !== null && model !== '' && !MODEL_PATTERN.test(model);
  const canSubmit = !promptEmpty && !modelInvalid && !submitting;

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void invoke('metaAgent:list', { projectId })
      .then((items) => {
        if (active) setAgents(items);
      })
      .catch(() => {
        if (active) setAgents([]);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const inheritedMode = defaultAgentMode ?? 'default';
  const planActive =
    taskMode === 'plan' || (taskMode === null && inheritedMode === 'plan');
  const effortOptions = effortOptionsForHarness(
    harnessOverride ?? defaultModelHarness,
  );
  const activeSlashQuery = slashQuery(prompt);
  const slashMatches =
    activeSlashQuery === null
      ? []
      : matchSlashCommands(activeSlashQuery, slashCommands);
  const slashOpen = activeSlashQuery !== null;
  const selectedEffortLabel =
    effortOptions.find((option) => option.id === effort)?.label ?? 'High';

  useEffect(() => {
    if (effortOptions.some((option) => option.id === effort)) return;
    const preferred = effortOptions.find(
      (option) => option.id === preferences.defaultEffort,
    );
    setEffort(preferred?.id ?? effortOptions[2]?.id ?? 'high');
  }, [effort, effortOptions, preferences.defaultEffort]);

  useEffect(() => {
    if (!slashOpen) return;
    const catalogueKey = `${workspaceId}:${harnessOverride ?? ''}`;
    if (slashLoadedForRef.current === catalogueKey) return;
    slashLoadedForRef.current = catalogueKey;
    let active = true;
    setSlashLoading(true);
    void invoke('slash:list', {
      workspaceId,
      harness: harnessOverride ?? undefined,
    })
      .then((commands) => {
        if (active) setSlashCommands(Array.isArray(commands) ? commands : []);
      })
      .catch(() => {
        if (active) setSlashCommands([]);
      })
      .finally(() => {
        if (active) setSlashLoading(false);
      });
    return () => {
      active = false;
    };
  }, [harnessOverride, slashOpen, workspaceId]);

  useEffect(() => {
    setSlashActive(0);
  }, [activeSlashQuery]);

  function chooseSlash(command: SlashCommand): void {
    setPrompt(`/${command.name} `);
  }

  function attachFile(): void {
    setAttachMenuOpen(false);
    void invoke('workspace:pickFile', undefined)
      .then((path) => {
        if (typeof path !== 'string' || path.trim() === '') return;
        setAttachments((current) =>
          current.some(
            (attachment) =>
              attachment.type === 'file' && attachment.path === path,
          )
            ? current
            : [...current, { type: 'file', path }],
        );
      })
      .catch(() => {
        /* picker cancellation/failure leaves attachments unchanged */
      });
  }

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    // An empty custom model string means "no model" (CLI default).
    const normalizedModel = model === null || model === '' ? null : model;
    const scheduledAt =
      scheduleKind === 'relative'
        ? Date.now() + relativeDelayMinutes * 60_000
        : scheduleKind === 'now' || scheduleInput === ''
          ? null
          : new Date(scheduleInput).getTime();
    if (scheduledAt !== null && !Number.isFinite(scheduledAt)) {
      setError('Invalid schedule time.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const parsedSlash = parseSlash(prompt.trim());
      const command =
        parsedSlash === null
          ? undefined
          : slashCommands.find(
              (candidate) => candidate.name === parsedSlash.name,
            );
      const resolvedPrompt =
        parsedSlash !== null && command !== undefined
          ? expandSlashTemplate(command.template, parsedSlash.args)
          : prompt.trim();
      await onSubmit({
        prompt: resolvedPrompt,
        model: normalizedModel,
        mode: taskMode,
        scheduledAt,
        workspaceId,
        harnessOverride,
        attachments,
        effort: agentId ? null : effort,
        agentId,
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
      width={640}
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
        <AgentPicker
          agents={agents}
          value={agentId}
          onChange={(next) => {
            setAgentId(next);
            if (next) {
              setModel(null);
              setHarnessOverride(null);
              setTaskMode(null);
            }
          }}
        />
        <div
          className="relative rounded-4 border border-border-1 bg-surface-panel shadow-3"
          data-testid="task-composer"
        >
          {slashOpen ? (
            <div
              className="absolute left-3 right-3 top-3 z-30 max-h-[260px] overflow-y-auto rounded-4 border border-border-1 bg-surface-panel shadow-4"
              data-testid="task-slash-menu"
            >
              {slashLoading ? (
                <div className="px-4 py-3 text-sm text-fg-3">
                  Loading commands...
                </div>
              ) : slashMatches.length === 0 ? (
                <div className="px-4 py-3 text-sm text-fg-3">
                  No matching commands
                </div>
              ) : (
                slashMatches.map((command, index) => (
                  <button
                    key={command.name}
                    type="button"
                    className={`flex w-full items-baseline px-4 py-3 text-left transition-colors duration-fast ease-out ${
                      index === slashActive ? 'bg-bg-3' : 'hover:bg-bg-3'
                    }`}
                    data-testid={`task-slash-command-${command.name}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSlash(command)}
                  >
                    <span className="min-w-[120px] text-xs font-semibold text-fg-1">
                      <span className="font-mono font-normal text-fg-3">/</span>
                      {command.name}
                    </span>
                    <span className="ml-4 truncate text-[11px] text-fg-3">
                      {commandDescription(command)}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
          <AttachmentBar
            attachments={attachments}
            onRemove={(index) =>
              setAttachments((current) =>
                current.filter((_, candidate) => candidate !== index),
              )
            }
          />
          <Textarea
            value={prompt}
            rows={4}
            placeholder="Ask the agent to work on something"
            data-testid="task-prompt"
            aria-label="Task prompt"
            className="min-h-[150px] w-full resize-none border-0 bg-transparent px-5 py-4 text-[19px] leading-7 shadow-none focus:border-transparent focus:shadow-none"
            style={{ resize: 'none' }}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(event) => {
              if (!slashOpen) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSlashActive((current) =>
                  slashMatches.length === 0
                    ? 0
                    : (current + 1) % slashMatches.length,
                );
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSlashActive((current) =>
                  slashMatches.length === 0
                    ? 0
                    : (current - 1 + slashMatches.length) % slashMatches.length,
                );
              } else if (
                (event.key === 'Enter' || event.key === 'Tab') &&
                slashMatches[slashActive] !== undefined
              ) {
                event.preventDefault();
                chooseSlash(slashMatches[slashActive]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setPrompt('');
              }
            }}
          />
          <fieldset
            disabled={agentId !== null}
            className="flex min-w-0 items-center gap-3 px-4 pb-4"
            data-testid="task-composer-controls"
          >
            <ModelPicker
              model={model}
              harnessOverride={harnessOverride}
              onChange={(value) => {
                setModel(value.model);
                setHarnessOverride(value.harnessOverride);
              }}
            />

            <div className="relative shrink-0">
              <button
                type="button"
                className="flex h-9 items-center gap-2 rounded-2 px-2 text-sm font-medium text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                data-testid="task-effort-select"
                aria-label="Select effort"
                aria-expanded={effortMenuOpen}
                title="Select effort"
                onClick={() => setEffortMenuOpen((open) => !open)}
              >
                <Gauge className="h-5 w-5 text-fg-3" aria-hidden />
                <span>{selectedEffortLabel}</span>
              </button>
              {effortMenuOpen ? (
                <div
                  className="absolute bottom-[calc(100%+10px)] left-0 z-30 w-48 rounded-4 border border-border-1 bg-surface-panel p-2 shadow-4"
                  data-testid="task-effort-menu"
                >
                  {effortOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className="flex w-full items-center justify-between rounded-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                      data-testid={`task-effort-${option.id}`}
                      onClick={() => {
                        setEffort(option.id);
                        setEffortMenuOpen(false);
                      }}
                    >
                      <span>{option.label}</span>
                      {effort === option.id ? (
                        <Check className="h-4 w-4 text-fg-3" aria-hidden />
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className={`shrink-0 rounded-1 p-1.5 transition-colors duration-fast ease-out ${
                planActive
                  ? 'bg-bg-3 text-fg-1'
                  : 'text-fg-3 hover:bg-bg-3 hover:text-fg-1'
              }`}
              data-testid="task-plan"
              aria-label="Plan mode"
              aria-pressed={planActive}
              title="Plan mode"
              onClick={() => setTaskMode(planActive ? 'default' : 'plan')}
            >
              <Map className="h-5 w-5" aria-hidden />
            </button>

            <div className="relative ml-auto shrink-0">
              <button
                type="button"
                className="rounded-1 p-1.5 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                data-testid="task-attach"
                aria-label="Attach files"
                aria-expanded={attachMenuOpen}
                title="Attachments"
                onClick={() => setAttachMenuOpen((open) => !open)}
              >
                <Plus className="h-5 w-5" aria-hidden />
              </button>
              {attachMenuOpen ? (
                <div
                  className="absolute bottom-[calc(100%+10px)] right-0 z-30 w-48 rounded-4 border border-border-1 bg-surface-panel p-2 shadow-4"
                  data-testid="task-attach-menu"
                >
                  <button
                    type="button"
                    className="w-full rounded-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                    data-testid="task-attach-file"
                    onClick={attachFile}
                  >
                    Attach file
                  </button>
                </div>
              ) : null}
            </div>
          </fieldset>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-fg-2">
            Schedule
          </legend>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {(
              [
                ['now', 'Now'],
                ['specific', 'Specific time'],
                ['relative', 'After delay'],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2 text-sm text-fg-2"
              >
                <input
                  type="radio"
                  name="task-schedule-kind"
                  value={value}
                  checked={scheduleKind === value}
                  data-testid={`task-schedule-${value}`}
                  className="h-4 w-4 cursor-pointer accent-accent"
                  onChange={() => setScheduleKind(value)}
                />
                <span className="font-medium">{label}</span>
              </label>
            ))}
          </div>

          {scheduleKind === 'specific' ? (
            <input
              type="datetime-local"
              value={scheduleInput}
              autoFocus={focusSchedule}
              data-testid="task-schedule"
              className="h-control box-border rounded-2 border border-border-2 bg-surface-well px-2.5 font-ui text-sm text-fg-1"
              onChange={(e) => setScheduleInput(e.target.value)}
            />
          ) : scheduleKind === 'relative' ? (
            <div className="py-1" data-testid="task-relative-schedule">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2 bg-bg-3 text-fg-2">
                  <Clock3 className="h-4 w-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-fg-1">
                    Quick schedule
                  </div>
                  <div className="text-2xs text-fg-3">
                    {relativeScheduleDescription(relativeDelayMinutes)}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {RELATIVE_SCHEDULE_PRESETS.map((preset) => (
                  <button
                    key={preset.minutes}
                    type="button"
                    className={`h-9 rounded-2 border px-3 text-xs font-semibold transition-colors ${
                      relativeDelayMinutes === preset.minutes
                        ? 'border-accent-border bg-accent-muted text-fg-1'
                        : 'border-border-2 bg-surface-well text-fg-3 hover:border-accent-border hover:text-fg-1'
                    }`}
                    data-testid={`task-relative-preset-${preset.minutes}`}
                    aria-pressed={relativeDelayMinutes === preset.minutes}
                    onClick={() => setRelativeDelayMinutes(preset.minutes)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {scheduleKind === 'specific' ? (
            <span className="text-2xs text-fg-3">
              Runs at the selected date and time.
            </span>
          ) : null}
        </fieldset>

        {error ? (
          <span className="text-xs text-danger" data-testid="task-form-error">
            {error}
          </span>
        ) : null}
      </div>
    </Dialog>
  );
}
