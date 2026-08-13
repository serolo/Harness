// The chat composer: multiline prompt, mode selector (gated by harness capabilities),
// a minimal file-attach affordance, and a Send/Interrupt button tied to `isBusy`.

import {
  type DragEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  BookOpenText,
  Check,
  DollarSign,
  Gauge,
  Info,
  Map,
  MoreHorizontal,
  Plus,
  Star,
  X,
  Zap,
} from 'lucide-react';
import type {
  AgentMode,
  Attachment,
  HarnessId,
  ReasoningEffort,
  Usage,
} from '@shared/harness';
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
import type { RenderedTurn } from '@renderer/stores/chat';
import { Textarea, Tooltip } from '@renderer/components/ui';
import { formatUsdMicros } from '@shared/billing';
import { AttachmentBar } from './AttachmentBar';
import { readModelPreferences } from '../settings/modelPreferences';
import {
  isOpenCodeConfigured,
  PROVIDER_MODEL_GROUPS,
  runtimeProviderModel,
  type ProviderModelGroup,
} from './modelCatalog';
import {
  CLAUDE_EFFORT_OPTIONS,
  CODEX_EFFORT_OPTIONS,
  type EffortOption,
} from './effortCatalog';

export interface ComposerProps {
  isBusy: boolean;
  workspaceId?: string | null;
  contextId?: string;
  turns?: RenderedTurn[];
  disabled?: boolean;
  onSend: (
    prompt: string,
    attachments: Attachment[],
    mode: AgentMode,
    harness?: HarnessId,
    model?: string,
    effort?: ReasoningEffort,
    displayPrompt?: string,
  ) => void | Promise<void>;
  onInterrupt: () => void | Promise<void>;
  onClear?: () => void | Promise<void>;
}

interface ContextStats {
  capacity: number;
  used: number;
  input: number;
  output: number;
  messageCount: number;
  toolCount: number;
}

const MODEL_LABELS: Record<HarnessId, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

interface ComposerIssue {
  id: string;
  label: string;
}

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

function modelContextCapacity(label: string): number {
  const million = /\b(\d+(?:\.\d+)?)\s*M\b/i.exec(label);
  if (million) return Math.round(Number(million[1]) * 1_000_000);
  const thousand = /\b(\d+(?:\.\d+)?)\s*K\b/i.exec(label);
  if (thousand) return Math.round(Number(thousand[1]) * 1_000);
  return 200_000;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function percent(value: number, capacity: number): string {
  if (capacity <= 0) return '0.0%';
  return `${((value / capacity) * 100).toFixed(1)}%`;
}

function estimatedTokens(value: unknown): number {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return Math.max(0, Math.ceil(text.length / 4));
}

function contextStats(
  turns: readonly RenderedTurn[] | undefined,
  modelLabel: string,
): ContextStats {
  const capacity = modelContextCapacity(modelLabel);
  const source = turns ?? [];
  let input = 0;
  let output = 0;
  let messageCount = 0;
  let toolCount = 0;

  for (const turn of source) {
    let estimatedInput = 0;
    let estimatedOutput = 0;
    let contextUsage: Usage | undefined;
    for (const event of turn.events) {
      if (event.kind === 'user_message' || event.kind === 'text') {
        messageCount += 1;
      }
      if (event.kind === 'user_message') {
        estimatedInput += estimatedTokens(event.text);
      }
      if (event.kind === 'text') {
        estimatedOutput += estimatedTokens(event.delta);
      }
      if (event.kind === 'tool_use' || event.kind === 'tool_result') {
        toolCount += 1;
      }
      if (event.kind === 'tool_use') {
        estimatedOutput += estimatedTokens(event.input);
      }
      if (event.kind === 'tool_result') {
        estimatedInput += estimatedTokens(event.output);
      }
      if (event.kind === 'context_usage') {
        contextUsage = event.usage;
      }
    }
    if (contextUsage?.inputTokens != null) {
      // Claude's terminal usage is cumulative across every model call in the tool
      // loop. The latest assistant message carries the actual context snapshot.
      input = contextUsage.inputTokens;
      output = contextUsage.outputTokens ?? estimatedOutput;
    } else if (turn.usage?.inputTokens != null) {
      // A resumed turn's provider input count is a snapshot of the context sent for
      // that request for providers without per-call snapshots.
      input = turn.usage.inputTokens;
      output = turn.usage.outputTokens ?? estimatedOutput;
    } else {
      // No provider snapshot yet (normally the live turn). Roll the preceding model
      // output into the next request's input, then add only this turn's new material.
      input += output + estimatedInput;
      output = turn.usage?.outputTokens ?? estimatedOutput;
    }
  }

  return {
    capacity,
    used: Math.min(input + output, capacity),
    input,
    output,
    messageCount,
    toolCount,
  };
}

function ContextIndicator({
  stats,
}: {
  stats: ContextStats;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const [popoverPosition, setPopoverPosition] = useState({
    bottom: 0,
    left: 0,
  });
  const usedPct = stats.capacity === 0 ? 0 : stats.used / stats.capacity;
  const free = Math.max(stats.capacity - stats.used, 0);
  const breakdown = [
    { label: 'Free space', value: free },
    { label: 'Input tokens', value: stats.input },
    { label: 'Output tokens', value: stats.output },
    { label: 'Messages', value: stats.messageCount },
    { label: 'Tool events', value: stats.toolCount },
  ];

  const cancelHoverClose = (): void => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  };

  const scheduleHoverClose = (): void => {
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setOpen(false);
    }, 100);
  };

  useEffect(
    () => () => {
      cancelHoverClose();
    },
    [],
  );

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (indicatorRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    function positionPopover(): void {
      const rect = indicatorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 16;
      const width = 320;
      setPopoverPosition({
        bottom: window.innerHeight - rect.top + 10,
        left: Math.max(
          margin,
          Math.min(rect.left, window.innerWidth - width - margin),
        ),
      });
    }

    positionPopover();
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
    return () => {
      window.removeEventListener('resize', positionPopover);
      window.removeEventListener('scroll', positionPopover, true);
    };
  }, [open]);

  return (
    <div className="relative" ref={indicatorRef}>
      <button
        type="button"
        className={`flex h-9 items-center gap-2 rounded-2 px-2 text-sm font-medium transition-colors duration-fast ease-out ${
          open ? 'bg-bg-3 text-fg-1' : 'text-fg-3 hover:bg-bg-3 hover:text-fg-1'
        }`}
        data-testid="composer-context"
        aria-label="Context usage"
        aria-expanded={open}
        onMouseEnter={() => {
          cancelHoverClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleHoverClose}
        onClick={() => setOpen((value) => !value)}
      >
        <BookOpenText className="h-5 w-5" aria-hidden />
        <span className="hidden tabular-nums sm:inline">
          {compactNumber(stats.used)}
        </span>
        <span
          className="h-1.5 w-12 overflow-hidden rounded-full bg-bg-4"
          aria-hidden
        >
          <span
            className="block h-full rounded-full bg-fg-2"
            style={{
              width: `${Math.max(4, Math.min(100, usedPct * 100))}%`,
            }}
          />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="fixed z-[1000] w-[320px] rounded-4 border border-border-1 bg-surface-panel p-4 shadow-4"
              style={popoverPosition}
              data-testid="composer-context-popover"
              onMouseEnter={cancelHoverClose}
              onMouseLeave={() => {
                cancelHoverClose();
                setOpen(false);
              }}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="text-lg font-semibold text-fg-1">Context</div>
                <div className="font-mono text-base text-fg-3">
                  {compactNumber(stats.used)}/{compactNumber(stats.capacity)}
                </div>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-4">
                <div
                  className="h-full rounded-full bg-fg-1"
                  style={{ width: `${Math.min(100, usedPct * 100)}%` }}
                />
              </div>
              <div className="mt-4 border-t border-border-1 pt-3">
                {breakdown.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between py-1 text-sm"
                  >
                    <span className="text-fg-3">{row.label}</span>
                    <span className="font-mono text-fg-3">
                      {percent(row.value, stats.capacity)}
                    </span>
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function CostIndicator({
  turns,
}: {
  turns: RenderedTurn[];
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const [popoverPosition, setPopoverPosition] = useState({
    bottom: 0,
    left: 0,
  });
  const pricedTurns = turns.filter((turn) => turn.costMicros !== undefined);
  const totalCostMicros = pricedTurns.reduce(
    (total, turn) => total + (turn.costMicros ?? 0),
    0,
  );
  const unpricedTurns = turns.length - pricedTurns.length;

  const cancelHoverClose = (): void => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  };

  const scheduleHoverClose = (): void => {
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setOpen(false);
    }, 100);
  };

  useEffect(
    () => () => {
      cancelHoverClose();
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function positionPopover(): void {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 16;
      const width = 320;
      setPopoverPosition({
        bottom: window.innerHeight - rect.top + 10,
        left: Math.max(
          margin,
          Math.min(rect.left, window.innerWidth - width - margin),
        ),
      });
    }
    positionPopover();
    window.addEventListener('resize', positionPopover);
    return () => window.removeEventListener('resize', positionPopover);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={triggerRef}>
      <button
        type="button"
        className={`flex h-9 items-center gap-1 rounded-2 px-2 text-sm font-medium tabular-nums transition-colors duration-fast ease-out ${
          open ? 'bg-bg-3 text-fg-1' : 'text-fg-3 hover:bg-bg-3 hover:text-fg-1'
        }`}
        data-testid="composer-cost"
        aria-label="Estimated API cost"
        aria-expanded={open}
        onMouseEnter={() => {
          cancelHoverClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleHoverClose}
        onClick={() => setOpen((value) => !value)}
      >
        <DollarSign className="h-5 w-5" aria-hidden />
        <span className="hidden sm:inline">
          {formatUsdMicros(totalCostMicros)}
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="fixed z-[1000] w-[320px] rounded-4 border border-border-1 bg-surface-panel p-4 shadow-4"
              style={popoverPosition}
              data-testid="composer-cost-popover"
              onMouseEnter={cancelHoverClose}
              onMouseLeave={() => {
                cancelHoverClose();
                setOpen(false);
              }}
            >
              <div className="text-lg font-semibold text-fg-1">
                Estimated API cost
              </div>
              <div className="mt-1 font-mono text-2xl text-fg-1">
                {formatUsdMicros(totalCostMicros)}
              </div>
              <div className="mt-4 border-t border-border-1 pt-3 text-sm">
                <div className="flex justify-between py-1">
                  <span className="text-fg-3">Priced turns</span>
                  <span className="text-fg-1">{pricedTurns.length}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-fg-3">Unpriced turns</span>
                  <span className="text-fg-1">{unpricedTurns}</span>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-fg-3">
                Provider API list-price estimate. Subscription plans may not be
                billed per turn.
              </p>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function Composer({
  isBusy,
  workspaceId,
  contextId,
  turns,
  disabled,
  onSend,
  onInterrupt,
  onClear,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AgentMode>('default');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashActive, setSlashActive] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSwitchNotice, setModelSwitchNotice] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [effort, setEffort] = useState<EffortOption>(CLAUDE_EFFORT_OPTIONS[2]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [plusPanel, setPlusPanel] = useState<'root' | 'issue' | 'workspaces'>(
    'root',
  );
  const [issueOptions, setIssueOptions] = useState<ComposerIssue[]>([]);
  const [selectedHarness, setSelectedHarness] = useState<HarnessId | undefined>(
    undefined,
  );
  const [selectedProviderModel, setSelectedProviderModel] = useState<
    string | undefined
  >(undefined);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const effortPickerRef = useRef<HTMLDivElement>(null);
  const plusPickerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const sentTextHistoryRef = useRef<string[]>([]);
  const sentTextHistoryIndexRef = useRef(-1);
  const preHistoryDraftRef = useRef('');
  const modelSelectionInitializedRef = useRef(false);
  const activeDraftWorkspaceRef = useRef<string | null>(null);
  const activeModeContextRef = useRef<string | null>(null);
  const modesByContextRef = useRef<Record<string, AgentMode>>({});
  const draftsByWorkspaceRef = useRef<
    Record<
      string,
      {
        text: string;
        attachments: Attachment[];
      }
    >
  >({});

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

  // Persist edits against the workspace that supplied the currently displayed draft.
  // This effect intentionally runs before the workspace-switch effect below: during a
  // switch render, it captures the outgoing values before that effect loads the incoming
  // workspace's cached draft.
  useEffect(() => {
    const workspace = activeDraftWorkspaceRef.current;
    if (workspace === null) return;
    draftsByWorkspaceRef.current[workspace] = {
      text,
      attachments,
    };
  }, [text, attachments, selectedWorkspaceId]);

  // Plan mode is an explicit choice for one chat context, not a workspace-wide
  // default. Capture the outgoing context before loading the destination so an
  // existing context restores its choice without seeding newly created contexts.
  useEffect(() => {
    const context = activeModeContextRef.current;
    if (context === null) return;
    modesByContextRef.current[context] = mode;
  }, [contextId, mode, selectedWorkspaceId]);

  useEffect(() => {
    const context =
      selectedWorkspaceId === null || contextId === undefined
        ? null
        : `${selectedWorkspaceId}\u0000${contextId}`;
    activeModeContextRef.current = context;
    setMode(
      context === null
        ? 'default'
        : (modesByContextRef.current[context] ?? 'default'),
    );
  }, [contextId, selectedWorkspaceId]);

  // Composer state belongs to one workspace. The component itself survives navigation,
  // so swap in the destination workspace's cached draft and close transient UI. A
  // one-time seeded prompt (e.g. "From issue") takes precedence over cached text.
  useEffect(() => {
    const cached =
      selectedWorkspaceId === null
        ? undefined
        : draftsByWorkspaceRef.current[selectedWorkspaceId];
    activeDraftWorkspaceRef.current = selectedWorkspaceId;

    setText(cached?.text ?? '');
    setAttachments(cached?.attachments ?? []);
    setSlashCommands([]);
    setSlashLoading(false);
    setSlashActive(0);
    setModelOpen(false);
    setEffortOpen(false);
    setPlusOpen(false);
    setPlusPanel('root');
    setIssueOptions([]);
    setIsDraggingFiles(false);
    dragDepthRef.current = 0;

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
    setModelSwitchNotice(false);
  }, [contextId, selectedWorkspaceId]);

  useEffect(() => {
    sentTextHistoryRef.current = [];
    sentTextHistoryIndexRef.current = -1;
    preHistoryDraftRef.current = '';
  }, [selectedWorkspaceId]);

  useEffect(() => {
    const persisted = (turns ?? []).flatMap((turn) =>
      turn.events.flatMap((event) =>
        event.kind === 'user_message' ? [event.text] : [],
      ),
    );
    const current = sentTextHistoryRef.current;
    const currentIsPersistedPrefix = current.every(
      (entry, index) => persisted[index] === entry,
    );
    if (
      persisted.length > 0 &&
      (current.length === 0 ||
        (persisted.length > current.length && currentIsPersistedPrefix))
    ) {
      sentTextHistoryRef.current = persisted;
    }
  }, [turns]);

  useEffect(() => {
    if (!modelSwitchNotice) return;
    const timeout = window.setTimeout(() => setModelSwitchNotice(false), 5_000);
    return () => window.clearTimeout(timeout);
  }, [modelSwitchNotice]);

  useEffect(() => {
    const preferences = readModelPreferences();
    const preferred = PROVIDER_MODEL_GROUPS.flatMap(
      (group) => group.options,
    ).find(
      (option) =>
        option.id === preferences.defaultModel ||
        option.model === preferences.defaultModel,
    );
    const harness = preferred?.harness ?? selectedWorkspace?.harness;
    const initialProviderModel =
      preferred?.id ?? defaultModelIdForHarness(selectedWorkspace?.harness);
    // The saved preference seeds a newly mounted composer, but an explicit model
    // choice is sticky while navigating between chat contexts and workspaces. Those
    // transitions reuse this component and must not silently restore the default.
    if (
      !modelSelectionInitializedRef.current &&
      initialProviderModel !== undefined
    ) {
      modelSelectionInitializedRef.current = true;
      setSelectedHarness(harness);
      setSelectedProviderModel(initialProviderModel);
    }
    const preferredEffort = (
      harness === 'codex' ? CODEX_EFFORT_OPTIONS : CLAUDE_EFFORT_OPTIONS
    ).find((option) => option.id === preferences.defaultEffort);
    if (preferredEffort) setEffort(preferredEffort);
  }, [contextId, selectedWorkspace?.id, selectedWorkspace?.harness]);

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
      (group.id !== 'opencode' || isOpenCodeConfigured()) &&
      (group.harness === undefined ||
        availableHarnessIds.has(group.harness) ||
        group.harness === selectedModel),
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
  const context = useMemo(
    () => contextStats(turns, selectedModelLabel),
    [turns, selectedModelLabel],
  );
  const totalCostMicros = useMemo(
    () =>
      (turns ?? []).reduce((total, turn) => total + (turn.costMicros ?? 0), 0),
    [turns],
  );
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

  useEffect(() => {
    if (!effortOpen) return;

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (effortPickerRef.current?.contains(target)) return;
      setEffortOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [effortOpen]);

  useEffect(() => {
    if (!plusOpen) return;

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (plusPickerRef.current?.contains(target)) return;
      setPlusOpen(false);
      setPlusPanel('root');
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [plusOpen]);

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
    // Keep expanded provider instructions out of the transcript. The original slash
    // invocation remains in composer history and is the only user message rendered.
    const displayPrompt = command === undefined ? undefined : text.trim();
    sentTextHistoryRef.current.push(text);
    sentTextHistoryIndexRef.current = -1;
    preHistoryDraftRef.current = '';
    void onSend(
      prompt,
      attachments,
      mode,
      selectedHarness,
      selectedProviderModelOption
        ? runtimeProviderModel(selectedProviderModelOption)
        : selectedProviderModel,
      effort.id,
      displayPrompt,
    );
    setText('');
    setAttachments([]);
  }

  function togglePlanMode(): void {
    if (!supportsPlan) return;
    setMode((previous) => {
      const next = previous === 'plan' ? 'default' : 'plan';
      const context = activeModeContextRef.current;
      if (context !== null) modesByContextRef.current[context] = next;
      return next;
    });
  }

  function chooseSlash(command: SlashCommand): void {
    setText(`/${command.name} `);
  }

  function appendDraft(fragment: string): void {
    setText((prev) => {
      const separator = prev.trim().length === 0 ? '' : '\n';
      return `${prev}${separator}${fragment}`;
    });
    setPlusOpen(false);
    setPlusPanel('root');
  }

  function attachFile(): void {
    void invoke('workspace:pickFile', undefined)
      .then((path) => {
        if (typeof path === 'string' && path.trim() !== '') {
          addFileAttachments([path]);
        }
      })
      .catch(() => {
        /* picker cancellation/failure leaves attachments unchanged */
      })
      .finally(() => {
        setPlusOpen(false);
        setPlusPanel('root');
      });
  }

  function addFileAttachments(paths: readonly string[]): void {
    setAttachments((prev) => {
      const existingPaths = new Set(
        prev.flatMap((attachment) =>
          attachment.type === 'file' ? [attachment.path] : [],
        ),
      );
      const additions: Attachment[] = [];
      for (const path of paths) {
        if (path.trim() === '' || existingPaths.has(path)) continue;
        existingPaths.add(path);
        additions.push({ type: 'file', path });
      }
      return additions.length === 0 ? prev : [...prev, ...additions];
    });
  }

  function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (disabled || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (disabled || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    if (disabled || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    addFileAttachments(
      Array.from(event.dataTransfer.files).flatMap((file) => {
        try {
          return [window.api.getPathForFile(file)];
        } catch {
          return [];
        }
      }),
    );
  }

  // The composer owns staged attachments, but users naturally drop onto the transcript
  // as well. Capture file drags from the containing chat panel and feed them through the
  // same attachment updater used by the picker and the local drop target.
  useEffect(() => {
    const chatPanel = composerRef.current?.closest(
      '[data-testid="chat-panel"]',
    );
    if (!(chatPanel instanceof HTMLElement)) return;

    const containsFiles = (event: globalThis.DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const dragOver = (event: globalThis.DragEvent): void => {
      if (disabled || !containsFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setIsDraggingFiles(true);
    };
    const dragLeave = (event: globalThis.DragEvent): void => {
      if (!containsFiles(event) || event.relatedTarget !== null) return;
      setIsDraggingFiles(false);
    };
    const drop = (event: globalThis.DragEvent): void => {
      if (disabled || !containsFiles(event)) return;
      event.preventDefault();
      setIsDraggingFiles(false);
      addFileAttachments(
        Array.from(event.dataTransfer?.files ?? []).flatMap((file) => {
          try {
            return [window.api.getPathForFile(file)];
          } catch {
            return [];
          }
        }),
      );
    };

    chatPanel.addEventListener('dragover', dragOver);
    chatPanel.addEventListener('dragleave', dragLeave);
    chatPanel.addEventListener('drop', drop);
    return () => {
      chatPanel.removeEventListener('dragover', dragOver);
      chatPanel.removeEventListener('dragleave', dragLeave);
      chatPanel.removeEventListener('drop', drop);
    };
  }, [disabled]);

  function openPlusPanel(panel: 'issue' | 'workspaces'): void {
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
    <div
      ref={composerRef}
      className="relative z-40 shrink-0 bg-surface-app px-6 pb-5 pt-4"
      data-testid="composer"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="relative mx-auto w-full max-w-[1120px]">
        {modelSwitchNotice ? (
          <div
            className="mb-3 flex items-start gap-3 rounded-4 border border-border-2 bg-surface-panel px-4 py-3 text-sm text-fg-1 shadow-3"
            data-testid="composer-model-switch-notice"
            role="status"
          >
            <Info className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1 leading-5">
              <span className="font-semibold">FYI:</span> When you switch models
              mid-chat, your next response may be slower and use more tokens.
            </p>
            <button
              type="button"
              className="rounded-1 p-1 text-fg-3 hover:bg-bg-3 hover:text-fg-1"
              aria-label="Dismiss model switch notice"
              data-testid="composer-model-switch-notice-dismiss"
              onClick={() => setModelSwitchNotice(false)}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : null}
        {slashOpen ? (
          <div
            className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-[360px] overflow-y-auto rounded-4 border border-border-1 bg-surface-panel shadow-4"
            data-testid="slash-menu"
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
                  data-testid={`slash-command-${command.name}`}
                  onMouseDown={(e) => e.preventDefault()}
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
        <div
          className={`composer-responsive relative rounded-4 border bg-surface-panel shadow-3 transition-colors duration-fast ${
            isDraggingFiles
              ? 'border-accent ring-2 ring-accent-border'
              : 'border-border-1'
          }`}
        >
          {isDraggingFiles ? (
            <div
              className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-4 bg-surface-panel/90 text-base font-medium text-fg-1"
              data-testid="composer-drop-target"
            >
              Drop files to attach
            </div>
          ) : null}
          <AttachmentBar
            attachments={attachments}
            onRemove={(i) =>
              setAttachments((prev) => prev.filter((_, idx) => idx !== i))
            }
          />
          <Textarea
            className="min-h-[118px] w-full resize-none border-0 bg-transparent px-5 py-4 text-[19px] leading-7 shadow-none focus:border-transparent focus:shadow-none"
            style={{ resize: 'none' }}
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
              if (
                e.key === 'ArrowUp' &&
                (e.currentTarget.value.length === 0 ||
                  sentTextHistoryIndexRef.current >= 0) &&
                sentTextHistoryRef.current.length > 0
              ) {
                e.preventDefault();
                if (sentTextHistoryIndexRef.current === -1) {
                  preHistoryDraftRef.current = e.currentTarget.value;
                }
                sentTextHistoryIndexRef.current = Math.min(
                  sentTextHistoryIndexRef.current + 1,
                  sentTextHistoryRef.current.length - 1,
                );
                setText(
                  sentTextHistoryRef.current[
                    sentTextHistoryRef.current.length -
                      1 -
                      sentTextHistoryIndexRef.current
                  ],
                );
                return;
              }
              if (
                e.key === 'ArrowDown' &&
                sentTextHistoryIndexRef.current >= 0
              ) {
                e.preventDefault();
                sentTextHistoryIndexRef.current -= 1;
                setText(
                  sentTextHistoryIndexRef.current === -1
                    ? preHistoryDraftRef.current
                    : sentTextHistoryRef.current[
                        sentTextHistoryRef.current.length -
                          1 -
                          sentTextHistoryIndexRef.current
                      ],
                );
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div
            className="flex min-w-0 items-center gap-3 px-4 pb-4"
            data-testid="composer-controls"
          >
            <div
              className="flex min-w-0 flex-1 items-center gap-3"
              data-testid="composer-primary-controls"
            >
              <div
                className="relative min-w-0 max-w-[22rem]"
                ref={modelPickerRef}
              >
                <Tooltip content="Select model">
                  <button
                    type="button"
                    className="flex h-9 max-w-full min-w-0 items-center gap-2 rounded-2 px-2 text-sm font-medium text-fg-2 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
                    data-testid="composer-model"
                    aria-label="Select model"
                    aria-expanded={modelOpen}
                    title="Select model"
                    onClick={() => setModelOpen((open) => !open)}
                  >
                    <Zap className="h-5 w-5 text-fg-3" aria-hidden />
                    <span className="composer-responsive-label min-w-0 truncate whitespace-nowrap">
                      {selectedModelLabel}
                    </span>
                  </button>
                </Tooltip>
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
                                  if (
                                    option.id !== selectedProviderModel &&
                                    (turns?.length ?? 0) > 0
                                  ) {
                                    setModelSwitchNotice(true);
                                  }
                                  setSelectedHarness(option.harness);
                                  setSelectedProviderModel(option.id);
                                  setModelOpen(false);
                                }}
                              >
                                <Zap
                                  className="h-4 w-4 text-fg-3"
                                  aria-hidden
                                />
                                <span className="min-w-0 flex-1 truncate text-base font-medium text-fg-1">
                                  {option.label}
                                  {option.isNew ? (
                                    <span className="ml-2 rounded border border-accent-border bg-accent-muted px-1.5 py-0.5 text-xs uppercase text-fg-2">
                                      New
                                    </span>
                                  ) : null}
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
              <div className="relative shrink-0" ref={effortPickerRef}>
                <Tooltip content="Select effort">
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
                    <span className="composer-responsive-label">
                      {effort.label}
                    </span>
                  </button>
                </Tooltip>
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
              <Tooltip content="Plan mode">
                <button
                  type="button"
                  className={`shrink-0 rounded-1 p-1.5 transition-colors duration-fast ease-out ${
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
              </Tooltip>
            </div>
            <div
              className="ml-auto flex shrink-0 items-center gap-3"
              data-testid="composer-secondary-controls"
            >
              <div
                className="composer-wide-only"
                data-testid="composer-cost-inline"
              >
                <CostIndicator turns={turns ?? []} />
              </div>
              <div
                className="composer-wide-only"
                data-testid="composer-context-inline"
              >
                <ContextIndicator stats={context} />
              </div>
              <div className="relative shrink-0" ref={plusPickerRef}>
                <Tooltip content="More composer actions">
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
                    <MoreHorizontal
                      className="composer-narrow-only h-5 w-5"
                      data-testid="composer-more-icon"
                      aria-hidden
                    />
                    <Plus
                      className="composer-wide-only h-5 w-5"
                      data-testid="composer-plus-icon"
                      aria-hidden
                    />
                  </button>
                </Tooltip>
                {plusOpen ? (
                  <div
                    className="absolute bottom-[calc(100%+10px)] right-0 z-50 w-[300px] rounded-4 border border-border-1 bg-surface-panel p-2 shadow-4"
                    data-testid="composer-plus-menu"
                  >
                    {plusPanel === 'root' ? (
                      <div className="grid gap-1">
                        <div className="composer-narrow-grid gap-1 border-b border-border-1 pb-2">
                          <div
                            className="flex items-center gap-3 rounded-2 px-3 py-2 text-sm text-fg-2"
                            data-testid="composer-overflow-cost"
                          >
                            <DollarSign
                              className="h-4 w-4 shrink-0 text-fg-3"
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1">
                              Estimated API cost
                            </span>
                            <span className="shrink-0 font-mono text-fg-3">
                              {formatUsdMicros(totalCostMicros)}
                            </span>
                          </div>
                          <div
                            className="flex items-center gap-3 rounded-2 px-3 py-2 text-sm text-fg-2"
                            data-testid="composer-overflow-context"
                          >
                            <BookOpenText
                              className="h-4 w-4 shrink-0 text-fg-3"
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1">Context</span>
                            <span className="shrink-0 font-mono text-fg-3">
                              {compactNumber(context.used)}/
                              {compactNumber(context.capacity)}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="rounded-2 px-3 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                          data-testid="composer-plus-attachment"
                          onClick={attachFile}
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
              <Tooltip content={isBusy ? 'Stop response' : 'Send message'}>
                {isBusy ? (
                  <button
                    type="button"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2 bg-danger text-white transition-colors duration-fast ease-out hover:bg-danger-hover"
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
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2 bg-accent text-accent-fg transition-colors duration-fast ease-out hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                    data-testid="composer-send"
                    disabled={!canSend}
                    onClick={send}
                    aria-label="Send"
                    title="Send"
                  >
                    <ArrowUp className="h-5 w-5" aria-hidden />
                  </button>
                )}
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
