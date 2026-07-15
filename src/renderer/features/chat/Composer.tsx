// The chat composer: multiline prompt, mode selector (gated by harness capabilities),
// a minimal file-attach affordance, and a Send/Interrupt button tied to `isBusy`.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  Gauge,
  Map,
  Paperclip,
  Plus,
  Star,
  Zap,
} from 'lucide-react';
import type { AgentMode, Attachment, HarnessId } from '@shared/harness';
import type { SlashCommand } from '@shared/slash';
import {
  expandSlashTemplate,
  matchSlashCommands,
  parseSlash,
} from '@shared/slash';
import { invoke } from '@renderer/ipc';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useHarnessStore } from '@renderer/stores/harness';
import { useComposerStore } from '@renderer/stores/composer';
import { Input, Textarea } from '@renderer/components/ui';
import { AttachmentBar } from './AttachmentBar';

export interface ComposerProps {
  isBusy: boolean;
  workspaceId?: string | null;
  disabled?: boolean;
  onSend: (
    prompt: string,
    attachments: Attachment[],
    mode: AgentMode,
    harness?: HarnessId,
  ) => void | Promise<void>;
  onInterrupt: () => void | Promise<void>;
  onClear?: () => void | Promise<void>;
}

const MODEL_LABELS: Record<HarnessId, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

interface ProviderModelOption {
  id: string;
  label: string;
  harness?: HarnessId;
  favorite?: boolean;
}

interface ProviderModelGroup {
  id: string;
  label: string;
  harness?: HarnessId;
  options: ProviderModelOption[];
}

interface ComposerIssue {
  id: string;
  label: string;
}

interface EffortOption {
  id: string;
  label: string;
}

const CLAUDE_EFFORT_OPTIONS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
];

const CODEX_EFFORT_OPTIONS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
];

const PROVIDER_MODEL_GROUPS: ProviderModelGroup[] = [
  {
    id: 'claude_code',
    label: 'Claude Code',
    harness: 'claude_code',
    options: [
      { id: 'claude-fable-5', label: 'Fable 5', harness: 'claude_code' },
      {
        id: 'claude-opus-4-8-1m',
        label: 'Opus 4.8 1M',
        harness: 'claude_code',
        favorite: true,
      },
      {
        id: 'claude-opus-4-7-1m',
        label: 'Opus 4.7 1M',
        harness: 'claude_code',
      },
      {
        id: 'claude-opus-4-6-1m',
        label: 'Opus 4.6 1M',
        harness: 'claude_code',
      },
      {
        id: 'claude-sonnet-5-1m',
        label: 'Sonnet 5 1M',
        harness: 'claude_code',
      },
      {
        id: 'claude-sonnet-4-6-1m',
        label: 'Sonnet 4.6 1M',
        harness: 'claude_code',
      },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', harness: 'claude_code' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', harness: 'claude_code' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    harness: 'codex',
    options: [
      { id: 'codex-gpt-5-6-sol', label: 'GPT-5.6 Sol', harness: 'codex' },
      { id: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra', harness: 'codex' },
      { id: 'codex-gpt-5-5', label: 'GPT-5.5', harness: 'codex' },
      { id: 'codex-gpt-5-4', label: 'GPT-5.4', harness: 'codex' },
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    options: [
      { id: 'opencode-big-pickle', label: 'opencode/big-pickle' },
      {
        id: 'opencode-deepseek-v4-flash',
        label: 'opencode/deepseek-v4-flash-fr...',
      },
      { id: 'opencode-mimo-v2-5-free', label: 'opencode/mimo-v2.5-free' },
      {
        id: 'opencode-nemotron-3-ultra-free',
        label: 'opencode/nemotron-3-ultra-free',
      },
      {
        id: 'opencode-north-mini-code-free',
        label: 'opencode/north-mini-code-free',
      },
    ],
  },
];

function defaultModelIdForHarness(
  harness: HarnessId | undefined,
): string | undefined {
  return PROVIDER_MODEL_GROUPS.find((group) => group.harness === harness)
    ?.options[0]?.id;
}

function slashQuery(input: string): string | null {
  const match = /^\/([A-Za-z0-9_-]*)$/.exec(input);
  return match?.[1] ?? null;
}

function commandDescription(command: SlashCommand): string {
  if (command.description !== undefined && command.description.trim() !== '') {
    return command.description;
  }
  return command.template.split('\n').find((line) => line.trim() !== '') ?? '';
}

export function Composer({
  isBusy,
  workspaceId,
  disabled,
  onSend,
  onInterrupt,
  onClear,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AgentMode>('default');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pathDraft, setPathDraft] = useState('');
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashActive, setSlashActive] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [effort, setEffort] = useState<EffortOption>(
    CLAUDE_EFFORT_OPTIONS[2],
  );
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusPanel, setPlusPanel] = useState<
    'root' | 'attachment' | 'issue' | 'workspaces'
  >('root');
  const [plusPathDraft, setPlusPathDraft] = useState('');
  const [issueOptions, setIssueOptions] = useState<ComposerIssue[]>([]);
  const [selectedHarness, setSelectedHarness] = useState<HarnessId | undefined>(
    undefined,
  );
  const [selectedProviderModel, setSelectedProviderModel] = useState<
    string | undefined
  >(undefined);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  // The composer always targets the currently selected workspace (its host
  // <ChatPanel> is rendered with `workspaceId={selectedWorkspaceId}`), so read the
  // id straight from the store for the one-time pending-prompt hand-off.
  const storeSelectedWorkspaceId = useWorkspacesStore(
    (s) => s.selectedWorkspaceId,
  );
  const selectedWorkspaceId = workspaceId ?? storeSelectedWorkspaceId;
  const selectedWorkspace = useWorkspacesStore((s) =>
    selectedWorkspaceId === null
      ? undefined
      : s.workspaces.find((w) => w.id === selectedWorkspaceId),
  );
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const takePendingPrompt = useComposerStore((s) => s.takePendingPrompt);
  const loadHarnesses = useHarnessStore((s) => s.load);
  const harnessInfoById = useHarnessStore((s) => s.infoById);

  // Consume any pending prompt seeded for this workspace (e.g. by the "From issue"
  // create flow) exactly once. Keyed on the workspace id: it fires on mount and when
  // the selection changes; `takePendingPrompt` clears the value, so switching away and
  // back after it was consumed does not re-seed the input. `takePendingPrompt` is a
  // stable Zustand action, so it never re-fires the effect on its own.
  useEffect(() => {
    if (selectedWorkspaceId === null) return;
    const pending = takePendingPrompt(selectedWorkspaceId);
    if (pending !== undefined && pending !== '') {
      setText(pending);
    }
  }, [selectedWorkspaceId, takePendingPrompt]);

  useEffect(() => {
    void loadHarnesses();
  }, [loadHarnesses]);

  useEffect(() => {
    setSelectedHarness(selectedWorkspace?.harness);
    setSelectedProviderModel(
      defaultModelIdForHarness(selectedWorkspace?.harness),
    );
  }, [selectedWorkspace?.id, selectedWorkspace?.harness]);

  const selectedModel = selectedHarness ?? selectedWorkspace?.harness;
  const effortOptions =
    selectedModel === 'codex' ? CODEX_EFFORT_OPTIONS : CLAUDE_EFFORT_OPTIONS;

  useEffect(() => {
    let alive = true;
    setSlashLoading(true);
    void invoke('slash:list', {
      workspaceId: selectedWorkspaceId ?? undefined,
      harness: selectedModel,
    })
      .then((commands) => {
        if (alive) setSlashCommands(Array.isArray(commands) ? commands : []);
      })
      .catch(() => {
        if (alive) setSlashCommands([]);
      })
      .finally(() => {
        if (alive) setSlashLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedWorkspaceId, selectedModel]);

  const harnessOptions = useMemo(() => {
    const loaded = Object.values(harnessInfoById);
    const runnable = loaded.filter(
      (info) => info.detect.installed && info.detect.authenticated,
    );
    const options = runnable.length > 0 ? runnable : loaded;
    if (
      selectedModel !== undefined &&
      !options.some((info) => info.id === selectedModel)
    ) {
      return [
        {
          id: selectedModel,
          capabilities: {
            supportsResume: false,
            supportsMcp: false,
            supportsPlanMode: false,
            rawTerminalFallback: false,
          },
          detect: { installed: true, authenticated: true },
        },
        ...options,
      ];
    }
    return options;
  }, [harnessInfoById, selectedModel]);
  const selectedHarnessInfo =
    selectedModel === undefined ? undefined : harnessInfoById[selectedModel];
  const availableHarnessIds = new Set(harnessOptions.map((info) => info.id));
  const modeledHarnessIds = new Set(
    PROVIDER_MODEL_GROUPS.flatMap((group) =>
      group.harness === undefined ? [] : [group.harness],
    ),
  );
  const modelGroups = PROVIDER_MODEL_GROUPS.filter(
    (group) =>
      group.harness === undefined ||
      availableHarnessIds.has(group.harness) ||
      group.harness === selectedModel,
  ).concat(
    harnessOptions
      .filter((info) => !modeledHarnessIds.has(info.id))
      .map((info): ProviderModelGroup => ({
        id: info.id,
        label: MODEL_LABELS[info.id],
        harness: info.id,
        options: [
          {
            id: `${info.id}-default`,
            label: MODEL_LABELS[info.id],
            harness: info.id,
          },
        ],
      })),
  );
  const selectedProviderModelOption = modelGroups
    .flatMap((group) => group.options)
    .find((option) => option.id === selectedProviderModel);
  const selectedModelLabel =
    selectedProviderModelOption?.label ??
    (selectedModel ? MODEL_LABELS[selectedModel] : 'Default');
  const supportsPlan =
    selectedHarnessInfo?.capabilities.supportsPlanMode ?? true;
  const canSend = !isBusy && !disabled && text.trim().length > 0;
  const activeSlashQuery = slashQuery(text);
  const slashMatches = useMemo(
    () =>
      activeSlashQuery === null
        ? []
        : matchSlashCommands(activeSlashQuery, slashCommands),
    [activeSlashQuery, slashCommands],
  );
  const slashOpen = activeSlashQuery !== null;

  useEffect(() => {
    setSlashActive(0);
  }, [activeSlashQuery]);

  useEffect(() => {
    if (!effortOptions.some((option) => option.id === effort.id)) {
      setEffort(effortOptions[2]);
    }
  }, [effort.id, effortOptions]);

  useEffect(() => {
    if (!supportsPlan && mode === 'plan') {
      setMode('default');
    }
  }, [mode, supportsPlan]);

  useEffect(() => {
    if (!modelOpen) return;

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (modelPickerRef.current?.contains(target)) return;
      setModelOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [modelOpen]);

  function send(): void {
    if (!canSend) return;
    const parsedSlash = parseSlash(text.trim());
    if (parsedSlash?.name === 'clear') {
      void onClear?.();
      setText('');
      setAttachments([]);
      return;
    }
    const command =
      parsedSlash === null
        ? undefined
        : slashCommands.find((cmd) => cmd.name === parsedSlash.name);
    const prompt =
      parsedSlash !== null && command !== undefined
        ? expandSlashTemplate(command.template, parsedSlash.args)
        : text;
    void onSend(prompt, attachments, mode, selectedHarness);
    setText('');
    setAttachments([]);
  }

  function togglePlanMode(): void {
    if (!supportsPlan) return;
    setMode((prev) => (prev === 'plan' ? 'default' : 'plan'));
  }

  function chooseSlash(command: SlashCommand): void {
    setText(`/${command.name} `);
  }

  function addPath(): void {
    const path = pathDraft.trim();
    if (path === '') return;
    setAttachments((prev) => [...prev, { type: 'file', path }]);
    setPathDraft('');
  }

  function addPlusPath(): void {
    const path = plusPathDraft.trim();
    if (path === '') return;
    setAttachments((prev) => [...prev, { type: 'file', path }]);
    setPlusPathDraft('');
    setPlusOpen(false);
    setPlusPanel('root');
  }

  function appendDraft(fragment: string): void {
    setText((prev) => {
      const separator = prev.trim().length === 0 ? '' : '\n';
      return `${prev}${separator}${fragment}`;
    });
    setPlusOpen(false);
    setPlusPanel('root');
  }

  function openPlusPanel(
    panel: 'attachment' | 'issue' | 'workspaces',
  ): void {
    setPlusPanel(panel);
    if (panel !== 'issue' || selectedWorkspace?.projectId === undefined) {
      return;
    }
    void invoke('github:listIssues', {
      projectId: selectedWorkspace.projectId,
    })
      .then((issues) => {
        if (!Array.isArray(issues)) {
          setIssueOptions([]);
          return;
        }
        setIssueOptions(
          issues
            .filter(
              (issue) =>
                typeof issue?.number === 'number' &&
                typeof issue?.title === 'string',
            )
            .map((issue) => ({
              id: `github-${issue.number}`,
              label: `GitHub issue #${issue.number} - ${issue.title}`,
            })),
        );
      })
      .catch(() => setIssueOptions([]));
  }

  return (
    <div className="shrink-0 bg-surface-app px-6 pb-5" data-testid="composer">
      <div className="relative mx-auto w-full max-w-[1120px]">
        {slashOpen ? (
          <div
            className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-[360px] overflow-y-auto rounded-4 border border-border-1 bg-surface-panel shadow-4"
            data-testid="slash-menu"
          >
            <div className="border-b border-border-1 px-4 py-2 text-xs font-medium uppercase tracking-wide text-fg-3">
              Available commands
            </div>
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
                  className={`flex w-full items-baseline gap-4 px-4 py-3 text-left transition-colors duration-fast ease-out ${
                    index === slashActive ? 'bg-bg-3' : 'hover:bg-bg-3'
                  }`}
                  data-testid={`slash-command-${command.name}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => chooseSlash(command)}
                >
                  <span className="font-mono text-lg text-fg-3">/</span>
                  <span className="min-w-[120px] text-lg font-semibold text-fg-1">
                    {command.name}
                  </span>
                  <span className="truncate text-base text-fg-3">
                    {commandDescription(command)}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
        <div className="rounded-4 border border-border-1 bg-surface-panel shadow-3">
          <AttachmentBar
            attachments={attachments}
            onRemove={(i) =>
              setAttachments((prev) => prev.filter((_, idx) => idx !== i))
            }
          />
          <Textarea
            className="min-h-[118px] w-full resize-none border-0 bg-transparent px-5 py-4 text-[19px] leading-7 shadow-none focus:border-transparent focus:shadow-none"
            rows={4}
            placeholder="Ask to make changes, @mention files, run /commands"
            value={text}
            disabled={disabled}
            data-testid="composer-input"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSlashActive((prev) =>
                    slashMatches.length === 0
                      ? 0
                      : (prev + 1) % slashMatches.length,
                  );
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashActive((prev) =>
                    slashMatches.length === 0
                      ? 0
                      : (prev - 1 + slashMatches.length) % slashMatches.length,
                  );
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  if (
                    e.key === 'Enter' &&
                    parseSlash(e.currentTarget.value.trim())?.name === 'clear'
                  ) {
                    send();
                  } else if (slashMatches[slashActive] !== undefined) {
                    chooseSlash(slashMatches[slashActive]);
                  }
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setText('');
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="flex items-center gap-3 px-4 pb-4">
            <div className="relative" ref={modelPickerRef}>
              <button
                type="button"
                className="flex h-9 items-center gap-2 rounded-2 px-2 text-sm font-medium text-fg-2 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                data-testid="composer-model"
                aria-label="Select model"
                aria-expanded={modelOpen}
                title="Select model"
                onClick={() => setModelOpen((open) => !open)}
              >
                <Zap className="h-5 w-5 text-fg-3" aria-hidden />
                <span>{selectedModelLabel}</span>
              </button>
              {modelOpen ? (
                <div
                  className="absolute bottom-[calc(100%+10px)] left-0 z-30 max-h-[70vh] w-[360px] overflow-y-auto rounded-4 border border-border-1 bg-surface-panel shadow-4"
                  data-testid="composer-model-menu"
                >
                  {modelGroups.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-fg-3">
                      No runnable models found
                    </div>
                  ) : (
                    modelGroups.map((group, groupIndex) => (
                      <div
                        key={group.id}
                        className={
                          groupIndex === 0 ? '' : 'border-t border-border-1'
                        }
                      >
                        <div
                          className="flex items-center gap-2 px-4 pb-2 pt-3 text-sm font-medium text-fg-3"
                          data-testid={`composer-model-${group.id}`}
                        >
                          <Zap className="h-4 w-4 text-fg-3" aria-hidden />
                          <span>{group.label}</span>
                        </div>
                        {group.options.map((option, index) => {
                          const enabled =
                            option.harness !== undefined &&
                            availableHarnessIds.has(option.harness);
                          const active = option.id === selectedProviderModel;
                          return (
                            <button
                              key={option.id}
                              type="button"
                              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-fast ease-out ${
                                active
                                  ? 'bg-bg-3'
                                  : enabled
                                    ? 'hover:bg-bg-3'
                                    : 'cursor-not-allowed opacity-50'
                              }`}
                              data-testid={`composer-model-option-${option.id}`}
                              disabled={!enabled}
                              onClick={() => {
                                if (option.harness === undefined) return;
                                setSelectedHarness(option.harness);
                                setSelectedProviderModel(option.id);
                                setModelOpen(false);
                              }}
                            >
                              <Zap className="h-4 w-4 text-fg-3" aria-hidden />
                              <span className="min-w-0 flex-1 truncate text-base font-medium text-fg-1">
                                {option.label}
                              </span>
                              {active ? (
                                <Check
                                  className="h-4 w-4 text-fg-2"
                                  aria-hidden
                                />
                              ) : option.favorite ? (
                                <Star
                                  className="h-4 w-4 text-fg-3"
                                  aria-hidden
                                />
                              ) : (
                                <span className="text-sm text-fg-3">
                                  {index + 1}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            <div className="relative">
              <button
                type="button"
                className="flex h-9 items-center gap-2 rounded-2 px-2 text-sm font-medium text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                data-testid="composer-effort"
                aria-label="Select effort"
                aria-expanded={effortOpen}
                title="Select effort"
                onClick={() => setEffortOpen((open) => !open)}
              >
                <Gauge className="h-5 w-5 text-fg-3" aria-hidden />
                <span>{effort.label}</span>
              </button>
              {effortOpen ? (
                <div
                  className="absolute bottom-[calc(100%+10px)] left-0 z-30 w-44 rounded-4 border border-border-1 bg-surface-panel p-2 shadow-4"
                  data-testid="composer-effort-menu"
                >
                  {effortOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className="flex w-full items-center justify-between rounded-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                      data-testid={`composer-effort-${option.id}`}
                      onClick={() => {
                        setEffort(option);
                        setEffortOpen(false);
                      }}
                    >
                      <span>{option.label}</span>
                      {option.id === effort.id ? (
                        <Check className="h-4 w-4 text-fg-3" aria-hidden />
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className={`rounded-1 p-1.5 transition-colors duration-fast ease-out ${
                mode === 'plan'
                  ? 'bg-bg-3 text-fg-1'
                  : 'text-fg-3 hover:bg-bg-3 hover:text-fg-1'
              } disabled:cursor-not-allowed disabled:opacity-40`}
              data-testid="composer-plan"
              aria-label="Plan mode"
              aria-pressed={mode === 'plan'}
              title="Plan mode"
              disabled={!supportsPlan}
              onClick={togglePlanMode}
            >
              <Map className="h-5 w-5" aria-hidden />
            </button>
            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                className="rounded-1 p-1.5 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                aria-label="Attach file"
                title="Attach file"
                onClick={addPath}
              >
                <Paperclip className="h-5 w-5" aria-hidden />
              </button>
              <div className="relative">
                <button
                  type="button"
                  className="rounded-1 p-1.5 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                  data-testid="composer-plus"
                  aria-label="More options"
                  aria-expanded={plusOpen}
                  title="More options"
                  onClick={() => {
                    setPlusOpen((open) => !open);
                    setPlusPanel('root');
                  }}
                >
                  <Plus className="h-5 w-5" aria-hidden />
                </button>
                {plusOpen ? (
                  <div
                    className="absolute bottom-[calc(100%+10px)] right-0 z-30 w-[300px] rounded-4 border border-border-1 bg-surface-panel p-2 shadow-4"
                    data-testid="composer-plus-menu"
                  >
                    {plusPanel === 'root' ? (
                      <div className="grid gap-1">
                        <button
                          type="button"
                          className="rounded-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                          data-testid="composer-plus-attachment"
                          onClick={() => openPlusPanel('attachment')}
                        >
                          Attach file
                        </button>
                        <button
                          type="button"
                          className="rounded-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                          data-testid="composer-plus-issue"
                          onClick={() => openPlusPanel('issue')}
                        >
                          Link issue
                        </button>
                        <button
                          type="button"
                          className="rounded-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                          data-testid="composer-plus-workspaces"
                          onClick={() => openPlusPanel('workspaces')}
                        >
                          Link workspace
                        </button>
                      </div>
                    ) : null}
                    {plusPanel === 'attachment' ? (
                      <div className="flex gap-2">
                        <Input
                          className="min-w-0 flex-1"
                          value={plusPathDraft}
                          data-testid="composer-plus-attach-input"
                          placeholder="Path"
                          onChange={(e) => setPlusPathDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              addPlusPath();
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="rounded-2 bg-accent px-3 text-sm font-medium text-accent-fg"
                          data-testid="composer-plus-attach-add"
                          onClick={addPlusPath}
                        >
                          Add
                        </button>
                      </div>
                    ) : null}
                    {plusPanel === 'issue' ? (
                      <div className="grid max-h-64 gap-1 overflow-y-auto">
                        {issueOptions.map((issue) => (
                          <button
                            key={issue.id}
                            type="button"
                            className="rounded-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                            data-testid={`composer-issue-${issue.id}`}
                            onClick={() => appendDraft(issue.label)}
                          >
                            {issue.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {plusPanel === 'workspaces' ? (
                      <div className="grid max-h-64 gap-1 overflow-y-auto">
                        {workspaces.map((workspace) => (
                          <button
                            key={workspace.id}
                            type="button"
                            className="rounded-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                            data-testid={`composer-workspace-${workspace.id}`}
                            onClick={() =>
                              appendDraft(
                                `Context: workspace ${workspace.name}`,
                              )
                            }
                          >
                            {workspace.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {isBusy ? (
                <button
                  type="button"
                  className="flex h-10 w-10 items-center justify-center rounded-2 bg-danger text-white transition-colors duration-fast ease-out hover:bg-danger-hover"
                  data-testid="composer-interrupt"
                  onClick={() => void onInterrupt()}
                  aria-label="Stop"
                  title="Stop"
                >
                  <span className="h-3 w-3 rounded-[2px] bg-white" />
                </button>
              ) : (
                <button
                  type="button"
                  className="flex h-10 w-10 items-center justify-center rounded-2 bg-accent text-accent-fg transition-colors duration-fast ease-out hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                  data-testid="composer-send"
                  disabled={!canSend}
                  onClick={send}
                  aria-label="Send"
                  title="Send"
                >
                  <ArrowUp className="h-5 w-5" aria-hidden />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="sr-only">
        <Input
          mono
          className="w-64"
          placeholder="Attach a file path…"
          value={pathDraft}
          data-testid="composer-attach-input"
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addPath();
            }
          }}
        />
        <button type="button" data-testid="composer-attach" onClick={addPath}>
          Attach
        </button>
      </div>
    </div>
  );
}
