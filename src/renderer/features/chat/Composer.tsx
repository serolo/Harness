// The chat composer: multiline prompt, mode selector (gated by harness capabilities),
// a minimal file-attach affordance, and a Send/Interrupt button tied to `isBusy`.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ArrowRight,
  ArrowUp,
  Check,
  Circle,
  FolderGit2,
  Gauge,
  GitPullRequest,
  Link2,
  Map,
  Paperclip,
  Plus,
  Star,
} from 'lucide-react';
import type { AgentMode, Attachment, HarnessId } from '@shared/harness';
import type { IssueListItem } from '@shared/github';
import type { LinearIssue } from '@shared/linear';
import type { Workspace } from '@shared/models';
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
import { useChatStore, type RenderedTurn } from '@renderer/stores/chat';
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
    displayPrompt?: string,
  ) => void | Promise<void>;
  onInterrupt: () => void | Promise<void>;
  onClear?: () => void | Promise<void>;
}

const MODEL_LABELS: Record<HarnessId, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

const EMPTY_RENDERED_TURNS: readonly RenderedTurn[] = [];

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
  icon: 'claude' | 'gpt' | 'opencode';
  options: ProviderModelOption[];
}

interface EffortOption {
  id: string;
  label: string;
  description: string;
}

type PlusMenuView = 'root' | 'attachment' | 'issues' | 'workspaces';

type IssueContextOption =
  | { kind: 'github'; issue: IssueListItem }
  | { kind: 'linear'; issue: LinearIssue };

const PROVIDER_MODEL_GROUPS: ProviderModelGroup[] = [
  {
    id: 'claude_code',
    label: 'Claude Code',
    harness: 'claude_code',
    icon: 'claude',
    options: [
      { id: 'claude-fable-5', label: 'Fable 5', harness: 'claude_code' },
      {
        id: 'claude-opus-4-8-1m',
        label: 'Opus 4.8 1M',
        harness: 'claude_code',
        favorite: true,
      },
      { id: 'claude-opus-4-7-1m', label: 'Opus 4.7 1M', harness: 'claude_code' },
      { id: 'claude-opus-4-6-1m', label: 'Opus 4.6 1M', harness: 'claude_code' },
      { id: 'claude-sonnet-5-1m', label: 'Sonnet 5 1M', harness: 'claude_code' },
      { id: 'claude-sonnet-4-6-1m', label: 'Sonnet 4.6 1M', harness: 'claude_code' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', harness: 'claude_code' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', harness: 'claude_code' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    harness: 'codex',
    icon: 'gpt',
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
    icon: 'opencode',
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

const CLAUDE_EFFORT_OPTIONS: EffortOption[] = [
  {
    id: 'low',
    label: 'Low',
    description:
      'Skips or minimizes internal thinking. Best for rapid, simple tasks like basic Q&A, formatting, or quick summaries.',
  },
  {
    id: 'medium',
    label: 'Medium',
    description:
      'Balanced reasoning. Ideal for everyday development work, routine coding, and moderate tasks.',
  },
  {
    id: 'high',
    label: 'High',
    description:
      'The default setting. Recommended for complex reasoning, architectural design, and debugging.',
  },
  {
    id: 'xhigh',
    label: 'Extra High',
    description:
      'Designed for heavy agentic workflows, multi-file refactors, extensive tool calling, and deep coding.',
  },
  {
    id: 'max',
    label: 'Max',
    description:
      'Maximum token ceiling. Reserved for highly complex mathematical or logic problems because it consumes significantly more tokens and time.',
  },
];

const CODEX_EFFORT_OPTIONS: EffortOption[] = [
  {
    id: 'medium',
    label: 'Medium',
    description:
      'Recommended default for daily use, balancing fast interaction with enough intelligence for standard edits and debugging.',
  },
  {
    id: 'high',
    label: 'High',
    description:
      'Ideal for complex multi-file refactors or convoluted bugs involving cross-file dependencies.',
  },
  {
    id: 'xhigh',
    label: 'Extra High',
    description:
      'Built for high-level architectural decisions, planning, and hard algorithmic tasks. Resource-heavy but highly capable.',
  },
];

function defaultModelIdForHarness(harness: HarnessId | undefined): string | undefined {
  if (harness === undefined) return undefined;
  return PROVIDER_MODEL_GROUPS.find((group) => group.harness === harness)?.options[0]?.id;
}

function effortOptionsForHarness(harness: HarnessId | undefined): EffortOption[] {
  if (harness === 'codex') return CODEX_EFFORT_OPTIONS;
  return CLAUDE_EFFORT_OPTIONS;
}

function estimateEventChars(turns: readonly RenderedTurn[]): number {
  return turns.reduce((sum, turn) => {
    const eventChars = turn.events.reduce((eventSum, event) => {
      if (event.kind === 'text') return eventSum + event.delta.length;
      if (event.kind === 'tool_use') {
        return eventSum + event.name.length + JSON.stringify(event.input).length;
      }
      if (event.kind === 'tool_result') {
        return eventSum + JSON.stringify(event.output).length;
      }
      if (event.kind === 'file_edit') return eventSum + event.path.length + 16;
      if (event.kind === 'todo_update') {
        return eventSum + event.todos.reduce((todoSum, todo) => todoSum + todo.body.length, 0);
      }
      if (event.kind === 'error') return eventSum + event.message.length;
      return eventSum;
    }, 0);
    return sum + eventChars;
  }, 0);
}

function estimateAttachmentChars(attachments: readonly Attachment[]): number {
  return attachments.reduce((sum, attachment) => {
    if (attachment.type === 'file' || attachment.type === 'image') {
      return sum + attachment.path.length;
    }
    return (
      sum +
      attachment.file.length +
      attachment.excerpt.length +
      attachment.body.length +
      32
    );
  }, 0);
}

function contextLimitForModel(modelLabel: string, harness: HarnessId | undefined): number {
  if (modelLabel.includes('1M')) return 1_000_000;
  if (harness === 'codex') return 200_000;
  return 200_000;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

function formatContextPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

function formatIssueContext(option: IssueContextOption): string {
  if (option.kind === 'github') {
    return [
      `Context: GitHub issue #${option.issue.number} - ${option.issue.title}`,
      `URL: ${option.issue.url}`,
      option.issue.state ? `State: ${option.issue.state}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `Context: Linear issue ${option.issue.identifier} - ${option.issue.title}`,
    `URL: ${option.issue.url}`,
    option.issue.state ? `State: ${option.issue.state}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatWorkspaceContext(workspace: Workspace): string {
  return [
    `Context: workspace ${workspace.name}`,
    `Branch: ${workspace.branch}`,
    `Base branch: ${workspace.baseBranch}`,
    `Status: ${workspace.status}`,
    workspace.sourceKind && workspace.sourceRef
      ? `Source: ${workspace.sourceKind} ${workspace.sourceRef}`
      : undefined,
    workspace.prNumber !== null ? `PR: #${workspace.prNumber}` : undefined,
    workspace.worktreePath ? `Path: ${workspace.worktreePath}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function defaultEffortForHarness(harness: HarnessId | undefined): string {
  return harness === 'codex' ? 'medium' : 'high';
}

function ProviderIcon({
  icon,
  className,
}: {
  icon: ProviderModelGroup['icon'];
  className: string;
}): React.JSX.Element {
  if (icon === 'claude') {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12 3v18M3 12h18M5.64 5.64l12.72 12.72M18.36 5.64 5.64 18.36M8.25 3.78l7.5 16.44M20.22 8.25l-16.44 7.5M15.75 3.78l-7.5 16.44M20.22 15.75l-16.44-7.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (icon === 'gpt') {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12 4.2c1.48-1.33 3.85-.46 4.15 1.5 1.96.3 2.83 2.67 1.5 4.15 1.33 1.48.46 3.85-1.5 4.15-.3 1.96-2.67 2.83-4.15 1.5-1.48 1.33-3.85.46-4.15-1.5-1.96-.3-2.83-2.67-1.5-4.15-1.33-1.48-.46-3.85 1.5-4.15.3-1.96 2.67-2.83 4.15-1.5Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path
          d="M8.3 7.1 12 5l3.7 2.1v4.2L12 13.4 8.3 11.3V7.1ZM8.3 11.3v5.2M15.7 7.1v5.2M12 13.4v5.2"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <span
      className={`inline-block border-2 border-current ${className}`}
      aria-hidden="true"
    />
  );
}

function iconForHarness(harness: HarnessId | undefined): ProviderModelGroup['icon'] {
  if (harness === 'claude_code') return 'claude';
  if (harness === 'codex') return 'gpt';
  return 'opencode';
}

function HelpTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            align="center"
            sideOffset={8}
            className="z-50 max-w-[280px] rounded-2 border border-border-1 bg-surface-panel px-3 py-2 text-sm leading-5 text-fg-1 shadow-4"
          >
            {label}
            <Tooltip.Arrow className="fill-surface-panel" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
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
  const [selectedHarness, setSelectedHarness] = useState<HarnessId | undefined>(
    undefined,
  );
  const [selectedProviderModel, setSelectedProviderModel] = useState<
    string | undefined
  >(undefined);
  const [effortOpen, setEffortOpen] = useState(false);
  const [selectedEffort, setSelectedEffort] = useState('high');
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusView, setPlusView] = useState<PlusMenuView>('root');
  const [contextOpen, setContextOpen] = useState(false);
  const [issueOptions, setIssueOptions] = useState<IssueContextOption[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const textRef = useRef('');
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const effortMenuRef = useRef<HTMLDivElement | null>(null);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  // The composer always targets the currently selected workspace (its host
  // <ChatPanel> is rendered with `workspaceId={selectedWorkspaceId}`), so read the
  // id straight from the store for the one-time pending-prompt hand-off.
  const storeSelectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const selectedWorkspaceId = workspaceId ?? storeSelectedWorkspaceId;
  const selectedProjectId = useWorkspacesStore((s) => s.selectedProjectId);
  const selectedWorkspace = useWorkspacesStore((s) =>
    selectedWorkspaceId === null
      ? undefined
      : s.workspaces.find((w) => w.id === selectedWorkspaceId),
  );
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const projectWorkspaces = useMemo(
    () =>
      selectedProjectId === null
        ? workspaces
        : workspaces.filter((w) => w.projectId === selectedProjectId),
    [selectedProjectId, workspaces],
  );
  const workspaceTurns = useChatStore((s) =>
    selectedWorkspaceId ? s.byWorkspace[selectedWorkspaceId] : undefined,
  );
  const turns = workspaceTurns ?? EMPTY_RENDERED_TURNS;
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
      setComposerText(pending);
    }
  }, [selectedWorkspaceId, takePendingPrompt]);

  useEffect(() => {
    void loadHarnesses();
  }, [loadHarnesses]);

  useEffect(() => {
    if (!modelOpen) return;

    function closeOnOutsidePress(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (modelMenuRef.current?.contains(target)) return;
      setModelOpen(false);
    }

    document.addEventListener('pointerdown', closeOnOutsidePress);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
    };
  }, [modelOpen]);

  useEffect(() => {
    if (!effortOpen) return;

    function closeOnOutsidePress(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (effortMenuRef.current?.contains(target)) return;
      setEffortOpen(false);
    }

    document.addEventListener('pointerdown', closeOnOutsidePress);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
    };
  }, [effortOpen]);

  useEffect(() => {
    if (!plusOpen) return;

    function closeOnOutsidePress(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (plusMenuRef.current?.contains(target)) return;
      setPlusOpen(false);
    }

    document.addEventListener('pointerdown', closeOnOutsidePress);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
    };
  }, [plusOpen]);

  useEffect(() => {
    if (!contextOpen) return;

    function closeOnOutsidePress(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (contextMenuRef.current?.contains(target)) return;
      setContextOpen(false);
    }

    document.addEventListener('pointerdown', closeOnOutsidePress);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
    };
  }, [contextOpen]);

  useEffect(() => {
    setSelectedHarness(selectedWorkspace?.harness);
    setSelectedProviderModel(defaultModelIdForHarness(selectedWorkspace?.harness));
    setSelectedEffort(defaultEffortForHarness(selectedWorkspace?.harness));
  }, [selectedWorkspace?.id, selectedWorkspace?.harness]);

  const selectedModel = selectedHarness ?? selectedWorkspace?.harness;

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
        icon: 'opencode',
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
  const effortOptions = effortOptionsForHarness(selectedModel);
  const selectedEffortOption =
    effortOptions.find((option) => option.id === selectedEffort) ??
    effortOptions.find((option) => option.id === defaultEffortForHarness(selectedModel)) ??
    effortOptions[0];
  const supportsPlan = selectedHarnessInfo?.capabilities.supportsPlanMode ?? true;
  const contextLimit = contextLimitForModel(selectedModelLabel, selectedModel);
  const messagesContextTokens = Math.ceil((estimateEventChars(turns) + text.length) / 4);
  const memoryContextTokens = Math.ceil(estimateAttachmentChars(attachments) / 4);
  const skillsContextTokens = Math.ceil(
    slashCommands.reduce(
      (sum, command) =>
        sum + command.name.length + command.template.length + commandDescription(command).length,
      0,
    ) / 4,
  );
  const systemToolsContextTokens = selectedModel === undefined ? 0 : 5_400;
  const systemPromptContextTokens = selectedModel === undefined ? 0 : 450;
  const mcpToolsContextTokens =
    selectedHarnessInfo?.capabilities.supportsMcp === true ? 250 : 0;
  const customAgentsContextTokens = 0;
  const usedContextTokens = Math.min(
    contextLimit,
    messagesContextTokens +
      memoryContextTokens +
      skillsContextTokens +
      systemToolsContextTokens +
      systemPromptContextTokens +
      mcpToolsContextTokens +
      customAgentsContextTokens,
  );
  const freeContextTokens = Math.max(0, contextLimit - usedContextTokens);
  const contextPercent = Math.min(99, Math.round((usedContextTokens / contextLimit) * 100));
  const contextDash = Math.max(2, Math.min(100, contextPercent));
  const contextBreakdown = [
    { label: 'Free space', tokens: freeContextTokens },
    { label: 'System tools', tokens: systemToolsContextTokens },
    { label: 'Messages', tokens: messagesContextTokens },
    { label: 'Memory files', tokens: memoryContextTokens },
    { label: 'Skills', tokens: skillsContextTokens },
    { label: 'System prompt', tokens: systemPromptContextTokens },
    { label: 'MCP tools', tokens: mcpToolsContextTokens },
    { label: 'Custom agents', tokens: customAgentsContextTokens },
  ];
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
    if (!supportsPlan && mode === 'plan') {
      setMode('default');
    }
  }, [mode, supportsPlan]);

  function setComposerText(next: string): void {
    textRef.current = next;
    setText(next);
  }

  function send(rawText = textRef.current): void {
    if (isBusy || disabled) return;
    const trimmedText = rawText.trim();
    if (trimmedText.length === 0) return;
    const parsedSlash = parseSlash(trimmedText);
    if (parsedSlash?.name === 'clear') {
      void onClear?.();
      setComposerText('');
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
        : rawText;
    void onSend(prompt, attachments, mode, selectedHarness, rawText);
    setComposerText('');
    setAttachments([]);
  }

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    send();
  }

  function togglePlanMode(): void {
    if (!supportsPlan) return;
    setMode((prev) => (prev === 'plan' ? 'default' : 'plan'));
  }

  function chooseSlash(command: SlashCommand): void {
    setComposerText(`/${command.name} `);
  }

  function insertContextBlock(block: string): void {
    setText((prev) => {
      const trimmed = prev.trimEnd();
      const next = trimmed === '' ? block : `${trimmed}\n\n${block}`;
      textRef.current = next;
      return next;
    });
  }

  function addPath(): void {
    const path = pathDraft.trim();
    if (path === '') return;
    setAttachments((prev) => [...prev, { type: 'file', path }]);
    setPathDraft('');
    setPlusOpen(false);
    setPlusView('root');
  }

  async function openIssuePicker(): Promise<void> {
    setPlusView('issues');
    setIssuesLoading(true);
    setIssuesError(null);
    const next: IssueContextOption[] = [];

    if (selectedProjectId !== null) {
      try {
        const issues = await invoke('github:listIssues', {
          projectId: selectedProjectId,
        });
        next.push(
          ...issues.slice(0, 8).map((issue) => ({
            kind: 'github' as const,
            issue,
          })),
        );
      } catch {
        // Missing GitHub auth is normal; Linear may still have issues.
      }
    }

    try {
      const issues = await invoke('linear:listIssues', { first: 8 });
      next.push(
        ...issues.map((issue) => ({
          kind: 'linear' as const,
          issue,
        })),
      );
    } catch {
      // Missing Linear auth is normal; GitHub may still have issues.
    }

    setIssueOptions(next);
    setIssuesError(
      next.length === 0 ? 'No connected issue sources returned issues.' : null,
    );
    setIssuesLoading(false);
  }

  function linkIssue(option: IssueContextOption): void {
    insertContextBlock(formatIssueContext(option));
    setPlusOpen(false);
    setPlusView('root');
  }

  function linkWorkspace(workspace: Workspace): void {
    insertContextBlock(formatWorkspaceContext(workspace));
    setPlusOpen(false);
    setPlusView('root');
  }

  return (
    <div
      className="shrink-0 bg-surface-app px-6 pb-5"
      data-testid="composer"
    >
      <form className="relative mx-auto w-full max-w-[1120px]" onSubmit={submit}>
        {slashOpen ? (
          <div
            className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-[360px] overflow-y-auto rounded-4 border border-border-1 bg-surface-panel shadow-4"
            data-testid="slash-menu"
          >
            <div className="border-b border-border-1 px-4 py-2 text-xs font-medium uppercase tracking-wide text-fg-3">
              Available skills
            </div>
            {slashLoading ? (
              <div className="px-4 py-3 text-sm text-fg-3">
                Loading skills...
              </div>
            ) : slashMatches.length === 0 ? (
              <div className="px-4 py-3 text-sm text-fg-3">
                No matching skills
              </div>
            ) : (
              slashMatches.map((command, index) => (
                <button
                  key={command.name}
                  type="button"
                  className={`flex w-full items-baseline gap-3 px-4 py-2.5 text-left transition-colors duration-fast ease-out ${
                    index === slashActive ? 'bg-bg-3' : 'hover:bg-bg-3'
                  }`}
                  data-testid={`slash-command-${command.name}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => chooseSlash(command)}
                >
                  <span className="font-mono text-sm text-fg-3">/</span>
                  <span className="min-w-[112px] max-w-[180px] truncate text-sm font-semibold text-fg-1">
                    {command.name}
                  </span>
                  <span className="truncate text-sm text-fg-3">
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
            onChange={(e) => setComposerText(e.target.value)}
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
                  if (slashMatches[slashActive] !== undefined) {
                    chooseSlash(slashMatches[slashActive]);
                  } else if (parseSlash(e.currentTarget.value.trim())?.name === 'clear') {
                    send(e.currentTarget.value);
                  }
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setComposerText('');
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(e.currentTarget.value);
              }
            }}
          />
          <div className="flex items-center gap-3 px-4 pb-4">
            <div className="relative" ref={modelMenuRef}>
              <HelpTooltip label="Choose which provider and model this message should use.">
                <button
                  type="button"
                  className="flex h-9 items-center gap-2 rounded-2 px-2 text-sm font-medium text-fg-2 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                  data-testid="composer-model"
                  aria-label="Select model"
                  aria-expanded={modelOpen}
                  title="Select model"
                  onClick={() => {
                    setEffortOpen(false);
                    setContextOpen(false);
                    setPlusOpen(false);
                    setModelOpen((open) => !open);
                  }}
                >
                  <ProviderIcon
                    icon={iconForHarness(selectedModel)}
                    className="h-5 w-5 shrink-0 text-fg-3"
                  />
                  <span>{selectedModelLabel}</span>
                </button>
              </HelpTooltip>
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
                    <>
                      {modelGroups.map((group, groupIndex) => (
                        <div
                          key={group.id}
                          className={
                            groupIndex === 0
                              ? ''
                              : 'border-t border-border-1'
                          }
                        >
                          <div
                            className="flex items-center gap-2 px-4 pb-2 pt-3 text-sm font-medium text-fg-3"
                            data-testid={`composer-model-${group.id}`}
                          >
                            <ProviderIcon
                              icon={group.icon}
                              className="h-4 w-4 shrink-0 text-fg-2"
                            />
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
                                  setSelectedEffort(
                                    defaultEffortForHarness(option.harness),
                                  );
                                  setModelOpen(false);
                                }}
                              >
                                <ProviderIcon
                                  icon={group.icon}
                                  className="h-4 w-4 shrink-0 text-fg-2"
                                />
                                <span className="min-w-0 flex-1 truncate text-base font-medium text-fg-1">
                                  {option.label}
                                </span>
                                {active ? (
                                  <Check
                                    className="h-4 w-4 shrink-0 text-fg-2"
                                    aria-hidden
                                  />
                                ) : option.favorite ? (
                                  <Star
                                    className="h-4 w-4 shrink-0 text-fg-3"
                                    aria-hidden
                                  />
                                ) : (
                                  <span className="w-4 shrink-0 text-right text-sm text-fg-3">
                                    {index + 1}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                      <div className="border-t border-border-1 px-4 py-3">
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 text-left text-sm font-medium text-fg-3 transition-colors duration-fast ease-out hover:text-fg-1"
                        >
                          <span className="min-w-0 flex-1">Harnesses</span>
                          <ArrowRight className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
            <div className="relative" ref={effortMenuRef}>
              <HelpTooltip label={selectedEffortOption?.description ?? 'Adjust reasoning effort.'}>
                <button
                  type="button"
                  className="flex h-9 items-center gap-2 rounded-2 px-2 text-sm font-medium text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                  data-testid="composer-effort"
                  aria-label="Select effort level"
                  aria-expanded={effortOpen}
                  title="Select effort level"
                  onClick={() => {
                    setModelOpen(false);
                    setContextOpen(false);
                    setPlusOpen(false);
                    setEffortOpen((open) => !open);
                  }}
                >
                  <Gauge className="h-5 w-5 text-fg-3" aria-hidden />
                  <span>{selectedEffortOption?.label ?? 'High'}</span>
                </button>
              </HelpTooltip>
              {effortOpen ? (
                <div
                  className="absolute bottom-[calc(100%+10px)] left-0 z-30 w-[360px] overflow-hidden rounded-4 border border-border-1 bg-surface-panel shadow-4"
                  data-testid="composer-effort-menu"
                >
                  <div className="border-b border-border-1 px-4 py-2 text-xs font-medium uppercase tracking-wide text-fg-3">
                    Effort
                  </div>
                  {effortOptions.map((option) => {
                    const active = option.id === selectedEffortOption?.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-fast ease-out ${
                          active ? 'bg-bg-3' : 'hover:bg-bg-3'
                        }`}
                        data-testid={`composer-effort-${option.id}`}
                        onClick={() => {
                          setSelectedEffort(option.id);
                          setEffortOpen(false);
                        }}
                      >
                        <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block text-base font-medium text-fg-1">
                            {option.label}
                          </span>
                          <span className="mt-1 block text-sm leading-5 text-fg-3">
                            {option.description}
                          </span>
                        </span>
                        {active ? (
                          <Check
                            className="mt-0.5 h-4 w-4 shrink-0 text-fg-2"
                            aria-hidden
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <HelpTooltip
              label={
                supportsPlan
                  ? 'Toggle plan mode for a planning-first response before changes.'
                  : 'Plan mode is not available for this provider.'
              }
            >
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
            </HelpTooltip>
            <div className="ml-auto flex items-center gap-3">
              <div className="relative" ref={contextMenuRef}>
                <HelpTooltip
                  label={`${contextPercent}% of the estimated ${contextLimit.toLocaleString()} token context is in use for this session.`}
                >
                  <button
                    type="button"
                    className="relative h-9 w-9 rounded-1 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                    data-testid="composer-context-usage"
                    aria-label={`Context usage ${contextPercent}%`}
                    aria-expanded={contextOpen}
                    title={`Context usage ${contextPercent}%`}
                    onClick={() => {
                      setModelOpen(false);
                      setEffortOpen(false);
                      setPlusOpen(false);
                      setContextOpen((open) => !open);
                    }}
                  >
                    <Circle
                      className="absolute inset-1 h-7 w-7 opacity-30"
                      aria-hidden
                    />
                    <svg
                      className="absolute inset-1 h-7 w-7 -rotate-90"
                      viewBox="0 0 36 36"
                      aria-hidden="true"
                    >
                      <circle
                        cx="18"
                        cy="18"
                        r="15"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeDasharray={`${contextDash} 100`}
                        pathLength="100"
                      />
                    </svg>
                    <span className="sr-only">{contextPercent}% context used</span>
                  </button>
                </HelpTooltip>
                {contextOpen ? (
                  <div
                    className="absolute bottom-[calc(100%+10px)] right-0 z-30 w-[420px] rounded-4 border border-border-1 bg-surface-panel p-4 shadow-4"
                    data-testid="composer-context-popover"
                  >
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <h2 className="text-lg font-semibold text-fg-1">Context</h2>
                      <span className="text-lg tabular-nums text-fg-3">
                        {formatCompactTokens(usedContextTokens)}/
                        {formatCompactTokens(contextLimit)}
                      </span>
                    </div>
                    <div
                      className="h-2.5 overflow-hidden rounded-full bg-bg-3"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full rounded-full bg-fg-1"
                        style={{ width: `${Math.max(2, contextPercent)}%` }}
                      />
                    </div>
                    <div className="my-3 h-px bg-border-1" />
                    <div className="space-y-2">
                      {contextBreakdown.map((item) => (
                        <div
                          key={item.label}
                          className="flex items-center justify-between gap-5 text-base leading-6"
                        >
                          <span className="text-fg-2">{item.label}</span>
                          <span className="tabular-nums text-fg-3">
                            {formatContextPercent((item.tokens / contextLimit) * 100)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="relative" ref={plusMenuRef}>
                <HelpTooltip label="Add files or link context to this message.">
                  <button
                    type="button"
                    className="rounded-1 p-1.5 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                    data-testid="composer-plus"
                    aria-label="Add context"
                    aria-expanded={plusOpen}
                    title="Add context"
                    onClick={() => {
                      setModelOpen(false);
                      setEffortOpen(false);
                      setContextOpen(false);
                      setPlusView('root');
                      setPlusOpen((open) => !open);
                    }}
                  >
                    <Plus className="h-5 w-5" aria-hidden />
                  </button>
                </HelpTooltip>
                {plusOpen ? (
                  <div
                    className="absolute bottom-[calc(100%+10px)] right-0 z-30 w-[360px] overflow-hidden rounded-4 border border-border-1 bg-surface-panel shadow-4"
                    data-testid="composer-plus-menu"
                  >
                    {plusView === 'root' ? (
                      <div className="py-2">
                        <button
                          type="button"
                          className="flex w-full items-center gap-4 px-4 py-3 text-left text-fg-1 transition-colors duration-fast ease-out hover:bg-bg-3"
                          data-testid="composer-plus-attachment"
                          onClick={() => setPlusView('attachment')}
                        >
                          <Paperclip className="h-6 w-6 shrink-0 text-fg-2" aria-hidden />
                          <span className="min-w-0 flex-1 text-lg font-medium">
                            Add attachment
                          </span>
                          <span className="text-sm text-fg-3">⌘U</span>
                        </button>
                        <button
                          type="button"
                          className="flex w-full items-center gap-4 px-4 py-3 text-left text-fg-1 transition-colors duration-fast ease-out hover:bg-bg-3"
                          data-testid="composer-plus-issue"
                          onClick={() => void openIssuePicker()}
                        >
                          <GitPullRequest className="h-6 w-6 shrink-0 text-fg-2" aria-hidden />
                          <span className="min-w-0 flex-1 text-lg font-medium">
                            Link issue
                          </span>
                          <span className="text-sm text-fg-3">⌘I</span>
                        </button>
                        <button
                          type="button"
                          className="flex w-full items-center gap-4 px-4 py-3 text-left text-fg-1 transition-colors duration-fast ease-out hover:bg-bg-3"
                          data-testid="composer-plus-workspaces"
                          onClick={() => setPlusView('workspaces')}
                        >
                          <FolderGit2 className="h-6 w-6 shrink-0 text-fg-2" aria-hidden />
                          <span className="min-w-0 flex-1 text-lg font-medium">
                            Link workspaces
                          </span>
                        </button>
                      </div>
                    ) : null}
                    {plusView === 'attachment' ? (
                      <div className="p-4" data-testid="composer-attachment-view">
                        <div className="mb-3 flex items-center gap-2">
                          <button
                            type="button"
                            className="text-sm text-fg-3 hover:text-fg-1"
                            onClick={() => setPlusView('root')}
                          >
                            Back
                          </button>
                          <span className="text-sm font-medium text-fg-1">
                            Add attachment
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <Input
                            mono
                            className="min-w-0 flex-1"
                            placeholder="File path"
                            value={pathDraft}
                            data-testid="composer-plus-attach-input"
                            onChange={(e) => setPathDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                addPath();
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="rounded-2 bg-accent px-3 text-sm font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-45"
                            data-testid="composer-plus-attach-add"
                            disabled={pathDraft.trim() === ''}
                            onClick={addPath}
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {plusView === 'issues' ? (
                      <div data-testid="composer-issues-view">
                        <div className="flex items-center gap-2 border-b border-border-1 px-4 py-3">
                          <button
                            type="button"
                            className="text-sm text-fg-3 hover:text-fg-1"
                            onClick={() => setPlusView('root')}
                          >
                            Back
                          </button>
                          <span className="text-sm font-medium text-fg-1">
                            Link issue
                          </span>
                        </div>
                        {issuesLoading ? (
                          <div className="px-4 py-3 text-sm text-fg-3">
                            Loading issues...
                          </div>
                        ) : issueOptions.length === 0 ? (
                          <div className="px-4 py-3 text-sm text-fg-3">
                            {issuesError ?? 'No issues found'}
                          </div>
                        ) : (
                          <div className="max-h-[320px] overflow-y-auto py-1">
                            {issueOptions.map((option) => {
                              const key =
                                option.kind === 'github'
                                  ? `github-${option.issue.number}`
                                  : `linear-${option.issue.id}`;
                              const label =
                                option.kind === 'github'
                                  ? `#${option.issue.number}`
                                  : option.issue.identifier;
                              return (
                                <button
                                  key={key}
                                  type="button"
                                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-fast ease-out hover:bg-bg-3"
                                  data-testid={`composer-issue-${key}`}
                                  onClick={() => linkIssue(option)}
                                >
                                  <GitPullRequest
                                    className="mt-0.5 h-4 w-4 shrink-0 text-fg-3"
                                    aria-hidden
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium text-fg-1">
                                      {label} {option.issue.title}
                                    </span>
                                    <span className="mt-1 block truncate text-xs text-fg-3">
                                      {option.issue.url}
                                    </span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {plusView === 'workspaces' ? (
                      <div data-testid="composer-workspaces-view">
                        <div className="flex items-center gap-2 border-b border-border-1 px-4 py-3">
                          <button
                            type="button"
                            className="text-sm text-fg-3 hover:text-fg-1"
                            onClick={() => setPlusView('root')}
                          >
                            Back
                          </button>
                          <span className="text-sm font-medium text-fg-1">
                            Link workspaces
                          </span>
                        </div>
                        {projectWorkspaces.length === 0 ? (
                          <div className="px-4 py-3 text-sm text-fg-3">
                            No workspaces available
                          </div>
                        ) : (
                          <div className="max-h-[320px] overflow-y-auto py-1">
                            {projectWorkspaces.map((workspace) => (
                              <button
                                key={workspace.id}
                                type="button"
                                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-fast ease-out hover:bg-bg-3"
                                data-testid={`composer-workspace-${workspace.id}`}
                                onClick={() => linkWorkspace(workspace)}
                              >
                                <Link2
                                  className="mt-0.5 h-4 w-4 shrink-0 text-fg-3"
                                  aria-hidden
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-fg-1">
                                    {workspace.name}
                                  </span>
                                  <span className="mt-1 block truncate text-xs text-fg-3">
                                    {workspace.branch}
                                  </span>
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {isBusy ? (
                <HelpTooltip label="Stop the running agent turn.">
                  <button
                    type="button"
                    className="flex h-10 w-10 items-center justify-center rounded-2 bg-danger text-white transition-colors duration-fast ease-out hover:bg-danger-hover"
                    data-testid="composer-interrupt"
                    title="Stop"
                    onClick={() => void onInterrupt()}
                    aria-label="Stop"
                  >
                    <span className="h-3 w-3 rounded-[2px] bg-white" />
                  </button>
                </HelpTooltip>
              ) : (
                <HelpTooltip label="Send this message to the selected model.">
                  <button
                    type="submit"
                    className="flex h-10 w-10 items-center justify-center rounded-2 bg-accent text-accent-fg transition-colors duration-fast ease-out hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                    data-testid="composer-send"
                    title="Send"
                    disabled={!canSend}
                    aria-label="Send"
                  >
                    <ArrowUp className="h-5 w-5" aria-hidden />
                  </button>
                </HelpTooltip>
              )}
            </div>
          </div>
        </div>
      </form>
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
