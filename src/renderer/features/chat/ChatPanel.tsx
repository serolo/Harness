// ChatPanel — the center-pane chat for the selected workspace. Wires `useChat`
// (history + streaming) to the Transcript + Composer. Renders an empty state when no
// workspace is selected.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, FileText, History, Pencil, Plus, X } from 'lucide-react';
import { invoke, onEvent } from '@renderer/ipc';
import type { ChatContextRecord } from '@shared/models';
import type { DiffQuery, FileDiff } from '@shared/review';
import type { ScheduledTask } from '@shared/tasks';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { useChat } from './useChat';
import { FileReferencePill } from './FileReferencePill';
import { Markdown } from './markdown';
import { WorkspaceCreationTerminal } from './WorkspaceCreationTerminal';
import { WorkspaceArchiveTerminal } from './WorkspaceArchiveTerminal';
import { useChatStore, type RenderedTurn } from '@renderer/stores/chat';
import { useWorkspacesStore } from '@renderer/stores/workspaces';

export interface ChatPanelProps {
  workspaceId: string | null;
  workspacePrError?: Error | null;
  workspacePrRefreshing?: boolean;
  onRetryWorkspacePr?: () => void;
  inspectFileRequest?: {
    id: number;
    workspaceId: string;
    path: string;
    mode?: 'edit' | 'diff';
    diffQuery?: Omit<DiffQuery, 'workspaceId'>;
  } | null;
}

interface FileTab {
  id: string;
  path: string;
  source: 'workspace' | 'plan';
  content: string | null;
  error: string | null;
  loading: boolean;
  mode: 'edit' | 'diff';
  fileDiff: FileDiff | null;
  diffError: string | null;
  loadingDiff: boolean;
  diffStatus: 'unknown' | 'loading' | 'available' | 'none' | 'error';
  diffQuery: Omit<DiffQuery, 'workspaceId'> | null;
  diffRequestKey: string | null;
}

interface ChatContext {
  id: string;
  label: string;
  /**
   * Turn membership for `task:` tabs only — those are reconstructed from `task:list` /
   * `task:turnStarted`. Manual tabs are persisted (`chat_contexts`) and derive their
   * membership from `turn.contextId`, so their `turnIds` stays empty.
   */
  turnIds: string[];
  /** `null` means this window must begin a fresh agent session. */
  initialSessionId?: string | null;
}

/** A tab id: a persisted chat-context id, a `task:<id>` tab, or a `file:<path>` tab. */
type ActiveTab = string;

/** Map a persisted `ChatContextRecord` onto the panel's tab shape. */
function toChatContext(record: ChatContextRecord): ChatContext {
  return {
    id: record.id,
    label: record.label,
    turnIds: [],
    initialSessionId: record.initialSessionId,
  };
}

function labelForPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function labelForTask(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 36) return `Task: ${singleLine || 'Untitled'}`;
  return `Task: ${singleLine.slice(0, 33)}…`;
}

function diffQueryKey(
  path: string,
  query?: Omit<DiffQuery, 'workspaceId'>,
): string {
  if (!query) return `${path}\0legacy`;
  const scope =
    query.scope.kind === 'commit'
      ? `commit:${query.scope.sha}`
      : query.scope.kind;
  return `${path}\0${query.targetRef}\0${scope}`;
}

function highlightedLine(line: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe =
    /\b(import|from|export|const|let|var|function|return|type|interface|class|extends|async|await)\b|('[^']*'|"[^"]*"|`[^`]*`)|(\b\d+\b)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index > lastIndex) nodes.push(line.slice(lastIndex, match.index));
    const token = match[0];
    const className = match[1]
      ? 'text-[#ff79c6]'
      : match[2]
        ? 'text-[#e5f36a]'
        : 'text-[#bd93f9]';
    nodes.push(
      <span key={key} className={className}>
        {token}
      </span>,
    );
    key += 1;
    lastIndex = tokenRe.lastIndex;
  }
  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes.length > 0 ? nodes : ['\u00a0'];
}

function DiffRows({ fileDiff }: { fileDiff: FileDiff }): React.JSX.Element {
  if (fileDiff.hunks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-fg-3">
        No changes for this file.
      </div>
    );
  }

  let oldLine = 0;
  let newLine = 0;

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[#100d0d] py-3 font-mono text-[15px] leading-7 text-[#f3f0eb]">
      {fileDiff.hunks.flatMap((hunk, hunkIndex) => {
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;
        const rows: React.JSX.Element[] = [
          <div
            key={`h-${hunkIndex}`}
            className="grid min-w-max grid-cols-[4.5rem_4.5rem_1fr] bg-[#1b1720] px-0 text-[#a7a0b2]"
          >
            <div className="select-none border-r border-white/10 pr-4 text-right">
              ...
            </div>
            <div className="select-none border-r border-white/10 pr-4 text-right">
              ...
            </div>
            <pre className="m-0 px-4">
              <code>
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},
                {hunk.newLines} @@
              </code>
            </pre>
          </div>,
        ];

        hunk.lines.forEach((raw, index) => {
          const marker = raw[0] ?? ' ';
          const text = raw.slice(1);
          const isAdded = marker === '+';
          const isRemoved = marker === '-';
          const rowOld = isAdded ? '' : oldLine;
          const rowNew = isRemoved ? '' : newLine;
          if (!isAdded) oldLine += 1;
          if (!isRemoved) newLine += 1;

          rows.push(
            <div
              key={`${hunkIndex}-${index}`}
              className={`grid min-w-max grid-cols-[4.5rem_4.5rem_1fr] px-0 ${
                isAdded
                  ? 'bg-[#12351f]'
                  : isRemoved
                    ? 'bg-[#3a171b]'
                    : 'hover:bg-white/[0.03]'
              }`}
            >
              <div className="select-none border-r border-white/10 pr-4 text-right text-[#8f8984]">
                {rowOld}
              </div>
              <div className="select-none border-r border-white/10 pr-4 text-right text-[#8f8984]">
                {rowNew}
              </div>
              <pre className="m-0 px-4">
                <code>
                  <span
                    className={
                      isAdded
                        ? 'text-[#50fa7b]'
                        : isRemoved
                          ? 'text-[#ff6b7a]'
                          : 'text-[#8f8984]'
                    }
                  >
                    {marker}
                  </span>
                  {highlightedLine(text)}
                </code>
              </pre>
            </div>,
          );
        });

        return rows;
      })}
    </div>
  );
}

function FileViewer({
  file,
  onModeChange,
  onRevealFile,
}: {
  file: FileTab;
  onModeChange: (mode: FileTab['mode']) => void;
  onRevealFile: () => Promise<void>;
}): React.JSX.Element {
  const [revealError, setRevealError] = useState<string | null>(null);
  const isMarkdown = /\.(?:md|markdown)$/i.test(file.path);
  const lines = (file.content ?? '').split('\n');
  if (lines.at(-1) === '') lines.pop();

  const copyFile = (): void => {
    if (file.content === null) return;
    void navigator.clipboard?.writeText(file.content);
  };

  const revealFile = (): void => {
    setRevealError(null);
    void onRevealFile().catch((error: unknown) => {
      setRevealError(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <div
      className="min-h-0 min-w-0 flex-1 overflow-hidden"
      data-testid="chat-file-viewer"
    >
      <div className="flex h-full min-h-0 flex-col bg-surface-app">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-1 px-5 py-3">
          <div className="min-w-0">
            <FileReferencePill
              path={file.path}
              label={file.path}
              onOpenFile={revealFile}
              actionLabel={`Reveal ${file.path} in Finder`}
            />
            {revealError ? (
              <p className="mt-1 truncate text-xs text-danger" role="alert">
                {revealError}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              className="rounded-2 p-1.5 text-fg-3 transition-colors hover:bg-bg-3 hover:text-fg-1 disabled:opacity-40"
              aria-label={`Copy ${file.path}`}
              disabled={file.content === null}
              onClick={copyFile}
            >
              <Copy className="h-4 w-4" aria-hidden />
            </button>
            <div className="flex rounded-3 bg-bg-3 p-0.5 text-sm font-semibold">
              <button
                type="button"
                className={`rounded-2 px-3 py-1 ${
                  file.mode === 'diff'
                    ? 'bg-bg-4 text-fg-1 shadow-sm'
                    : file.diffStatus === 'none' || file.diffStatus === 'error'
                      ? 'cursor-not-allowed text-fg-3 opacity-50'
                      : 'text-fg-3 hover:text-fg-1'
                }`}
                disabled={
                  file.diffStatus === 'none' || file.diffStatus === 'error'
                }
                title={
                  file.diffStatus === 'none'
                    ? 'No changes for this file'
                    : file.diffStatus === 'error'
                      ? (file.diffError ?? 'Diff unavailable')
                      : 'View diff'
                }
                onClick={() => onModeChange('diff')}
              >
                Diff
              </button>
              <button
                type="button"
                className={`rounded-2 px-3 py-1 ${
                  file.mode === 'edit'
                    ? 'bg-bg-4 text-fg-1 shadow-sm'
                    : 'text-fg-3 hover:text-fg-1'
                }`}
                onClick={() => onModeChange('edit')}
              >
                Edit
              </button>
            </div>
          </div>
        </div>
        {file.mode === 'diff' ? (
          file.loadingDiff ? (
            <div className="p-5 text-sm text-fg-3">Loading diff...</div>
          ) : file.diffError ? (
            <div className="m-5 rounded-2 border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {file.diffError}
            </div>
          ) : file.fileDiff ? (
            <DiffRows fileDiff={file.fileDiff} />
          ) : (
            <div className="p-5 text-sm text-fg-3">
              No diff loaded for this file.
            </div>
          )
        ) : file.loading ? (
          <div className="p-5 text-sm text-fg-3">Loading file...</div>
        ) : file.error ? (
          <div className="m-5 rounded-2 border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {file.error}
          </div>
        ) : isMarkdown ? (
          <article
            className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface-app px-6 py-6 sm:px-10"
            data-testid="chat-markdown-viewer"
          >
            <div className="w-full min-w-0" data-testid="chat-markdown-content">
              <Markdown text={file.content ?? ''} />
            </div>
          </article>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto bg-[#100d0d] py-3 font-mono text-[15px] leading-7 text-[#f3f0eb]">
            {lines.map((line, index) => (
              <div
                key={index}
                className="grid min-w-max grid-cols-[4.5rem_1fr] px-0 hover:bg-white/[0.03]"
              >
                <div className="select-none border-r border-white/10 pr-4 text-right text-[#8f8984]">
                  {index + 1}
                </div>
                <pre className="m-0 px-4">
                  <code>{highlightedLine(line)}</code>
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatPanel({
  workspaceId,
  workspacePrError = null,
  workspacePrRefreshing = false,
  onRetryWorkspacePr,
  inspectFileRequest,
}: ChatPanelProps): React.JSX.Element {
  const { turns, isBusy, sendTurn, interrupt, clear } = useChat(workspaceId);
  const workspace = useWorkspacesStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId),
  );
  const project = useWorkspacesStore((state) =>
    state.projects.find((candidate) => candidate.id === workspace?.projectId),
  );
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const [chatContexts, setChatContexts] = useState<ChatContext[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab | null>(null);
  const [editingContextId, setEditingContextId] = useState<string | null>(null);
  const [contextNameDraft, setContextNameDraft] = useState('');
  // File tabs are transient, but the chat context beneath them is workspace-local.
  // Remember it independently so closing a preview or returning to a workspace restores
  // the context the user was actually working in instead of jumping to the first tab.
  const lastActiveChatTabByWorkspace = useRef(new Map<string, string>());
  const selectChatTab = useCallback(
    (id: string): void => {
      if (workspaceId) lastActiveChatTabByWorkspace.current.set(workspaceId, id);
      setActiveTab(id);
    },
    [workspaceId],
  );
  // Mirrors `chatContexts` for reads across an `await` (e.g. in `closeChatContext`):
  // a plain closure captured before an `await` can miss a task tab that lands (via
  // `task:turnStarted`) while an IPC round trip is in flight, silently wiping it back
  // out on the other side. The ref is committed one render behind at worst, which is
  // still far fresher than the pre-`await` snapshot.
  const chatContextsRef = useRef<ChatContext[]>(chatContexts);
  useEffect(() => {
    chatContextsRef.current = chatContexts;
  }, [chatContexts]);
  const handledInspectRequests = useRef(new Set<number>());
  const registerTaskTurn = useChatStore((state) => state.registerTaskTurn);

  // Bootstrap the workspace's tab bar from the persisted `chat_contexts` rows. Main's
  // `listOrBootstrap` is the single source of truth for "at least one tab exists", so a
  // remount (or navigating away and back) rehydrates the same tabs instead of collapsing
  // them into a fresh local default.
  useEffect(() => {
    setFileTabs([]);
    setChatContexts([]);
    setActiveTab(null);
    setEditingContextId(null);
    if (!workspaceId) return;
    let active = true;
    void invoke('chat:contexts:list', { workspaceId })
      .then((records) => {
        if (!active) return;
        const manual = records.map(toChatContext);
        const remembered = lastActiveChatTabByWorkspace.current.get(workspaceId);
        const restored = manual.some((context) => context.id === remembered)
          ? remembered!
          : (manual[0]?.id ?? null);
        // The task-list hydration effect races this one; keep whatever it already added.
        setChatContexts((current) => [
          ...manual,
          ...current.filter((context) => context.id.startsWith('task:')),
        ]);
        // Likewise, don't clobber a task tab `task:turnStarted` may have just selected.
        setActiveTab((current) => {
          if (current !== null) return current;
          if (restored) {
            lastActiveChatTabByWorkspace.current.set(workspaceId, restored);
          }
          return restored;
        });
      })
      .catch(() => {
        /* Leaves an empty tab bar; the next workspace switch retries. */
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const upsertTaskContext = useCallback(
    (task: Pick<ScheduledTask, 'id' | 'prompt' | 'turnId'>): void => {
      if (!task.turnId) return;
      const turnId = task.turnId;
      const contextId = `task:${task.id}`;
      setChatContexts((contexts) => {
        const withoutTurn = contexts.map((context) => ({
          ...context,
          turnIds: context.turnIds.filter(
            (contextTurnId) => contextTurnId !== turnId,
          ),
        }));
        const existing = withoutTurn.find(
          (context) => context.id === contextId,
        );
        if (existing) {
          return withoutTurn.map((context) =>
            context.id === contextId
              ? {
                  ...context,
                  label: labelForTask(task.prompt),
                  turnIds: [turnId],
                }
              : context,
          );
        }
        return [
          ...withoutTurn,
          {
            id: contextId,
            label: labelForTask(task.prompt),
            turnIds: [turnId],
          },
        ];
      });
    },
    [],
  );

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void invoke('task:list', { workspaceId })
      .then((tasks) => {
        if (!active) return;
        for (const task of tasks) {
          if (task.turnId) {
            registerTaskTurn(workspaceId, task.id, task.turnId, task.prompt);
          }
          upsertTaskContext(task);
        }
      })
      .catch(() => {
        /* Task tabs can still be opened from the live start event. */
      });
    const unsubscribe = onEvent('task:turnStarted', (task) => {
      if (task.workspaceId !== workspaceId) return;
      upsertTaskContext({
        id: task.taskId,
        prompt: task.prompt,
        turnId: task.turnId,
      });
      selectChatTab(`task:${task.taskId}`);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [registerTaskTurn, selectChatTab, upsertTaskContext, workspaceId]);

  // NOTE: there is deliberately no effect assigning "unowned" turns to the active tab.
  // That was the bug: on remount every turn got dumped into whichever tab was active,
  // flattening previously-separate sessions. Manual-tab membership is now a pure derived
  // filter on the persisted `turn.contextId` (see `contextTurns` below).

  const fetchFileDiff = useCallback(
    (
      id: string,
      path: string,
      diffQuery?: Omit<DiffQuery, 'workspaceId'>,
    ): void => {
      if (!workspaceId) return;
      const requestKey = diffQueryKey(path, diffQuery);
      setFileTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                diffRequestKey: requestKey,
                diffStatus: 'loading',
                loadingDiff: tab.mode === 'diff',
              }
            : tab,
        ),
      );
      const request = diffQuery
        ? invoke('diff:fileQuery', {
            workspaceId,
            targetRef: diffQuery.targetRef,
            scope: diffQuery.scope,
            path,
          })
        : invoke('diff:file', { workspaceId, path });
      void request
        .then((fileDiff) => {
          const hasHunks = fileDiff.hunks.length > 0;
          setFileTabs((tabs) =>
            tabs.map((tab) =>
              tab.id === id && tab.diffRequestKey === requestKey
                ? {
                    ...tab,
                    fileDiff,
                    diffError: null,
                    loadingDiff: false,
                    diffStatus: hasHunks ? 'available' : 'none',
                    mode: hasHunks ? tab.mode : 'edit',
                  }
                : tab,
            ),
          );
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          setFileTabs((tabs) =>
            tabs.map((tab) =>
              tab.id === id && tab.diffRequestKey === requestKey
                ? {
                    ...tab,
                    fileDiff: null,
                    diffError: message,
                    loadingDiff: false,
                    diffStatus: 'error',
                    mode: 'edit',
                  }
                : tab,
            ),
          );
        });
    },
    [workspaceId],
  );

  const openFile = useCallback(
    (
      path: string,
      mode: FileTab['mode'] = 'edit',
      diffQuery?: Omit<DiffQuery, 'workspaceId'>,
    ): void => {
      if (!workspaceId) return;
      const isClaudePlan = /\/\.claude\/plans\/[^/]+\.md$/.test(path);
      const id = `file:${path}`;
      setActiveTab(id);
      setFileTabs((tabs) => {
        const existing = tabs.find((tab) => tab.id === id);
        if (existing) {
          return tabs.map((tab) =>
            tab.id === id
              ? {
                  ...tab,
                  diffQuery: diffQuery ?? null,
                  fileDiff: null,
                  diffError: null,
                  diffStatus: 'unknown',
                  diffRequestKey: null,
                  mode,
                }
              : tab,
          );
        }
        return [
          ...tabs,
          {
            id,
            path,
            source: isClaudePlan ? 'plan' : 'workspace',
            content: null,
            error: null,
            loading: true,
            mode,
            fileDiff: null,
            diffError: null,
            loadingDiff: mode === 'diff',
            diffStatus: 'unknown',
            diffQuery: diffQuery ?? null,
            diffRequestKey: null,
          },
        ];
      });

      const read = isClaudePlan
        ? invoke('plan:read', { path })
        : invoke('workspace:readFile', { workspaceId, path });
      void read
        .then((file) => {
          setFileTabs((tabs) =>
            tabs.map((tab) =>
              tab.id === id
                ? {
                    ...tab,
                    path: file.path,
                    content: file.content,
                    error: null,
                    loading: false,
                  }
                : tab,
            ),
          );
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          setFileTabs((tabs) =>
            tabs.map((tab) =>
              tab.id === id
                ? { ...tab, content: null, error: message, loading: false }
                : tab,
            ),
          );
        });
      if (!isClaudePlan) {
        fetchFileDiff(id, path, diffQuery);
      }
    },
    [fetchFileDiff, workspaceId],
  );

  useEffect(() => {
    if (
      !inspectFileRequest ||
      inspectFileRequest.workspaceId !== workspaceId ||
      handledInspectRequests.current.has(inspectFileRequest.id)
    ) {
      return;
    }
    handledInspectRequests.current.add(inspectFileRequest.id);
    openFile(
      inspectFileRequest.path,
      inspectFileRequest.mode ?? 'edit',
      inspectFileRequest.diffQuery,
    );
  }, [inspectFileRequest, openFile, workspaceId]);

  const closeFileTab = (id: string): void => {
    setFileTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    const remembered = workspaceId
      ? lastActiveChatTabByWorkspace.current.get(workspaceId)
      : undefined;
    const fallback =
      chatContexts.find((context) => context.id === remembered)?.id ??
      chatContexts[0]?.id ??
      null;
    if (workspaceId && fallback) {
      lastActiveChatTabByWorkspace.current.set(workspaceId, fallback);
    }
    setActiveTab((current) => (current === id ? fallback : current));
  };

  const setFileMode = (file: FileTab, mode: FileTab['mode']): void => {
    if (mode === 'diff' && file.diffStatus === 'none') return;
    if (mode === 'diff' && file.diffStatus === 'error') return;
    setFileTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === file.id
          ? {
              ...tab,
              mode,
              loadingDiff:
                mode === 'diff' && tab.diffStatus === 'loading'
                  ? true
                  : tab.loadingDiff,
            }
          : tab,
      ),
    );
    if (mode === 'diff' && file.diffStatus === 'unknown') {
      fetchFileDiff(file.id, file.path, file.diffQuery ?? undefined);
    }
  };

  /**
   * Create a persisted tab, adopt the server-assigned record, and select it. Returns
   * `null` if main refused the write, in which case the tab bar is left as it was rather
   * than showing a tab that does not exist on disk.
   */
  const createChatContext = async (
    workspace: string,
    label: string,
  ): Promise<ChatContext | null> => {
    let created: ChatContext;
    try {
      created = toChatContext(
        await invoke('chat:contexts:create', {
          workspaceId: workspace,
          label,
          initialSessionId: null,
        }),
      );
    } catch {
      return null;
    }
    setChatContexts((contexts) => [...contexts, created]);
    lastActiveChatTabByWorkspace.current.set(workspace, created.id);
    setActiveTab(created.id);
    return created;
  };

  const startNewChat = async (): Promise<void> => {
    if (!workspaceId) return;
    await createChatContext(workspaceId, 'Untitled');
  };

  const handoffPlan = async (plan: string): Promise<void> => {
    if (!workspaceId) return;
    const created = await createChatContext(workspaceId, 'Plan implementation');
    if (created === null) return;
    // Use `created.id`, not `activeContext` — this render tick's state is still stale.
    await sendTurn(
      `Implement the following approved plan in this workspace.\n\n${plan}`,
      [],
      'default',
      undefined,
      null,
      undefined,
      undefined,
      created.id,
    );
  };

  const closeChatContext = async (id: string): Promise<void> => {
    if (isBusy) return;
    if (!chatContexts.some((context) => context.id === id)) return;
    // Task tabs have no `chat_contexts` row — they are reconstructed from `task:list` —
    // so closing one is purely local.
    if (!id.startsWith('task:')) {
      try {
        await invoke('chat:contexts:close', { contextId: id });
      } catch {
        // The row is still there; keep showing the tab rather than losing it from the UI.
        return;
      }
    }
    // Filter and pick the fallback active tab from `chatContextsRef`, not the pre-`await`
    // `chatContexts` closure above — a task tab can land (via `task:turnStarted` or the
    // `task:list` hydration effect) while `chat:contexts:close` is in flight, and filtering
    // the stale closure would silently wipe it back out once we set state below.
    const liveContexts = chatContextsRef.current;
    const closingIndex = liveContexts.findIndex((context) => context.id === id);
    const remaining = liveContexts.filter((context) => context.id !== id);
    const fallbackId =
      remaining[Math.min(closingIndex, remaining.length - 1)]?.id ?? null;
    setChatContexts(remaining);
    if (workspaceId && lastActiveChatTabByWorkspace.current.get(workspaceId) === id) {
      if (fallbackId) {
        lastActiveChatTabByWorkspace.current.set(workspaceId, fallbackId);
      } else {
        lastActiveChatTabByWorkspace.current.delete(workspaceId);
      }
    }
    if (remaining.length === 0) {
      // Closing the last tab: let main mint the replacement so the fresh tab is a real
      // persisted context rather than a local synthetic one.
      setActiveTab(null);
      if (workspaceId) await createChatContext(workspaceId, 'Untitled');
      return;
    }
    setActiveTab((current) => (current === id ? fallbackId : current));
  };

  const beginRenameContext = (context: ChatContext): void => {
    setEditingContextId(context.id);
    setContextNameDraft(context.label);
  };

  const finishRenameContext = async (): Promise<void> => {
    if (editingContextId === null) return;
    const contextId = editingContextId;
    const label = contextNameDraft.trim() || 'Untitled';
    // Close the editor immediately so a blur can't re-enter this on the round trip.
    setEditingContextId(null);
    // Task tabs derive their label from the task prompt and have no persisted row.
    if (!contextId.startsWith('task:')) {
      try {
        // Only adopt the new label once main has persisted it.
        await invoke('chat:contexts:rename', { contextId, label });
      } catch {
        // Rename refused — leave the tab showing the label it already had.
        return;
      }
    }
    setChatContexts((contexts) =>
      contexts.map((context) =>
        context.id === contextId ? { ...context, label } : context,
      ),
    );
  };

  const activeFile = fileTabs.find((tab) => tab.id === activeTab) ?? null;
  const activeContext =
    chatContexts.find((context) => context.id === activeTab) ?? chatContexts[0];
  const activeTurnIds = new Set(activeContext?.turnIds ?? []);
  // Task tabs own their turns by id (`scheduled_tasks.turn_id`); manual tabs are the
  // persisted `chat_contexts` rows, so their turns are the ones pointing back at them.
  const contextTurns: RenderedTurn[] =
    activeContext === undefined
      ? []
      : activeContext.id.startsWith('task:')
        ? turns.filter((turn) => activeTurnIds.has(turn.turnId))
        : turns.filter((turn) => turn.contextId === activeContext.id);
  const contextSessionId =
    contextTurns.at(-1)?.sessionId ?? activeContext?.initialSessionId;
  // The `contextId` a new turn should be filed under. A `task:` tab is synthetic — it has
  // no `chat_contexts` row (scheduler-fired turns are always `context_id = NULL`) — so
  // never send its id to `turn:start`, which validates the id and would reject the turn.
  const activeContextId =
    activeContext !== undefined && !activeContext.id.startsWith('task:')
      ? activeContext.id
      : undefined;
  if (!workspaceId) {
    return (
      <div
        className="flex h-full flex-col items-stretch justify-center p-6 text-base text-fg-3"
        data-testid="chat-empty"
      >
        <span className="text-center">Select a workspace to begin.</span>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-surface-app"
      data-testid="chat-panel"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border-1 bg-surface-panel px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {chatContexts.map((context, index) => (
            <div
              key={context.id}
              className={`group flex h-7 shrink-0 items-center border-b-2 pl-2 text-xs font-medium transition-colors ${
                activeTab === context.id
                  ? 'border-accent text-fg-1'
                  : 'border-transparent text-fg-3 hover:text-fg-1'
              }`}
              data-testid={index === 0 ? 'chat-tab' : 'chat-context-tab'}
              role="tab"
              aria-selected={activeTab === context.id}
            >
              {editingContextId === context.id ? (
                <input
                  autoFocus
                  value={contextNameDraft}
                  aria-label="Chat context name"
                  data-testid="chat-context-name-input"
                  className="h-6 w-28 rounded-1 border border-border-2 bg-surface-well px-1.5 text-xs text-fg-1 outline-none focus:border-accent"
                  onChange={(event) => setContextNameDraft(event.target.value)}
                  onBlur={() => void finishRenameContext()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void finishRenameContext();
                    if (event.key === 'Escape') setEditingContextId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="h-full max-w-32 truncate"
                  title={`${context.label} — double-click to rename`}
                  onClick={() => selectChatTab(context.id)}
                  onDoubleClick={() => beginRenameContext(context)}
                >
                  {context.label}
                </button>
              )}
              <button
                type="button"
                className="ml-1 rounded-1 p-1 text-fg-3 opacity-0 transition-opacity hover:bg-bg-3 hover:text-fg-1 focus:opacity-100 group-hover:opacity-100"
                aria-label={`Rename ${context.label}`}
                onClick={() => beginRenameContext(context)}
              >
                <Pencil className="h-3 w-3" aria-hidden />
              </button>
              <button
                type="button"
                className="ml-1 rounded-1 p-1 text-fg-3 opacity-0 transition-opacity hover:bg-bg-3 hover:text-fg-1 focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
                aria-label={`Close ${context.label}`}
                data-testid={`chat-context-close-${index}`}
                disabled={isBusy}
                onClick={() => void closeChatContext(context.id)}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          ))}
          {fileTabs.map((tab) => (
            <div
              key={tab.id}
              className={`flex h-7 max-w-48 shrink-0 items-center gap-1 border-b-2 px-2 text-xs transition-colors ${
                activeTab === tab.id
                  ? 'border-accent text-fg-1'
                  : 'border-transparent text-fg-3 hover:text-fg-1'
              }`}
              data-testid="chat-file-tab"
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1"
                title={tab.path}
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{labelForPath(tab.path)}</span>
              </button>
              <button
                type="button"
                className="rounded-1 p-0.5 text-fg-3 hover:bg-bg-3 hover:text-fg-1"
                aria-label={`Close ${tab.path}`}
                onClick={() => closeFileTab(tab.id)}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ml-1 rounded-1 p-1 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="New chat"
            data-testid="chat-new"
            disabled={isBusy}
            onClick={() => void startNewChat()}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="rounded-1 p-1 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
          aria-label="Chat history"
        >
          <History className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {workspacePrError ? (
        <div
          className="flex shrink-0 items-start justify-between gap-3 border-b border-danger bg-danger-muted px-4 py-2 text-sm text-danger"
          data-testid="github-pr-error"
          role="alert"
        >
          <span className="min-w-0 whitespace-pre-wrap">
            Could not refresh the GitHub pull request:{' '}
            {workspacePrError.message}
          </span>
          {onRetryWorkspacePr ? (
            <button
              type="button"
              className="shrink-0 rounded-2 border border-danger px-2 py-1 font-medium hover:bg-surface-panel disabled:cursor-wait disabled:opacity-60"
              disabled={workspacePrRefreshing}
              onClick={onRetryWorkspacePr}
            >
              {workspacePrRefreshing ? 'Retrying…' : 'Retry'}
            </button>
          ) : null}
        </div>
      ) : null}
      {activeFile ? (
        <FileViewer
          key={activeFile.id}
          file={activeFile}
          onModeChange={(mode) => setFileMode(activeFile, mode)}
          onRevealFile={() =>
            activeFile.source === 'plan'
              ? invoke('file:revealInFinder', {
                  source: 'plan',
                  path: activeFile.path,
                })
              : invoke('file:revealInFinder', {
                  source: 'workspace',
                  workspaceId: workspaceId!,
                  path: activeFile.path,
                })
          }
        />
      ) : (
        <>
          <Transcript
            turns={contextTurns}
            workspaceId={workspaceId}
            workspace={workspace}
            project={project}
            onOpenFile={openFile}
            isBusy={isBusy}
            onAnswerQuestion={(answer) =>
              sendTurn(
                answer,
                [],
                contextTurns.at(-1)?.mode ?? 'default',
                contextTurns.at(-1)?.harness,
                contextSessionId,
                contextTurns.at(-1)?.model,
                undefined,
                activeContextId,
              )
            }
            onApprovePlan={() =>
              sendTurn(
                'The plan is approved. Start implementing it now.',
                [],
                'default',
                undefined,
                contextSessionId,
                undefined,
                undefined,
                activeContextId,
              )
            }
            onHandoffPlan={(plan) => void handoffPlan(plan)}
          />
          <WorkspaceCreationTerminal workspaceId={workspaceId} />
          <WorkspaceArchiveTerminal workspaceId={workspaceId} />
          <Composer
            isBusy={isBusy}
            disabled={activeContext === undefined}
            workspaceId={workspaceId}
            contextId={activeContext?.id}
            turns={contextTurns}
            onSend={(
              prompt,
              attachments,
              mode,
              harness,
              model,
              effort,
              displayPrompt,
            ) =>
              sendTurn(
                prompt,
                attachments,
                mode,
                harness,
                contextSessionId,
                model,
                effort,
                activeContextId,
                displayPrompt,
              )
            }
            onInterrupt={interrupt}
            onClear={clear}
          />
        </>
      )}
    </div>
  );
}
