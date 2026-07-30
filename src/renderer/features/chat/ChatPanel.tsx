// ChatPanel — the center-pane chat for the selected workspace. Wires `useChat`
// (history + streaming) to the Transcript + Composer. Renders an empty state when no
// workspace is selected.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, FileText, History, Pencil, Plus, X } from 'lucide-react';
import { invoke } from '@renderer/ipc';
import type { FileDiff } from '@shared/review';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { useChat } from './useChat';
import { FileReferencePill } from './FileReferencePill';
import { Markdown } from './markdown';
import { WorkspaceCreationTerminal } from './WorkspaceCreationTerminal';
import { WorkspaceArchiveTerminal } from './WorkspaceArchiveTerminal';
import { useWorkspacesStore } from '@renderer/stores/workspaces';

export interface ChatPanelProps {
  workspaceId: string | null;
  inspectFileRequest?: {
    id: number;
    workspaceId: string;
    path: string;
    mode?: 'edit' | 'diff';
  } | null;
}

interface FileTab {
  id: string;
  path: string;
  content: string | null;
  error: string | null;
  loading: boolean;
  mode: 'edit' | 'diff';
  fileDiff: FileDiff | null;
  diffError: string | null;
  loadingDiff: boolean;
  diffStatus: 'unknown' | 'loading' | 'available' | 'none' | 'error';
}

interface ChatContext {
  id: string;
  label: string;
  turnIds: string[];
  /** `null` means this window must begin a fresh agent session. */
  initialSessionId?: string | null;
}

type ActiveTab = 'chat' | string;

function labelForPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
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
}: {
  file: FileTab;
  onModeChange: (mode: FileTab['mode']) => void;
}): React.JSX.Element {
  const isMarkdown = /\.(?:md|markdown)$/i.test(file.path);
  const lines = (file.content ?? '').split('\n');
  if (lines.at(-1) === '') lines.pop();

  const copyFile = (): void => {
    if (file.content === null) return;
    void navigator.clipboard?.writeText(file.content);
  };

  return (
    <div
      className="min-h-0 flex-1 overflow-hidden"
      data-testid="chat-file-viewer"
    >
      <div className="flex h-full min-h-0 flex-col bg-surface-app">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-1 px-5 py-3">
          <div className="min-w-0">
            <FileReferencePill
              path={file.path}
              label={file.path}
              onOpenFile={undefined}
            />
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
            className="min-h-0 flex-1 overflow-auto bg-surface-app px-6 py-6 sm:px-10"
            data-testid="chat-markdown-viewer"
          >
            <div className="mx-auto w-full max-w-3xl">
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
  const [chatContexts, setChatContexts] = useState<ChatContext[]>([
    { id: 'chat', label: 'Untitled', turnIds: [] },
  ]);
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat');
  const [editingContextId, setEditingContextId] = useState<string | null>(null);
  const [contextNameDraft, setContextNameDraft] = useState('');
  const handledInspectRequests = useRef(new Set<number>());

  useEffect(() => {
    setFileTabs([]);
    setChatContexts([{ id: 'chat', label: 'Untitled', turnIds: [] }]);
    setActiveTab('chat');
    setEditingContextId(null);
  }, [workspaceId]);

  useEffect(() => {
    setChatContexts((contexts) => {
      const owned = new Set(contexts.flatMap((context) => context.turnIds));
      const unowned = turns
        .map((turn) => turn.turnId)
        .filter((turnId) => !owned.has(turnId));
      if (unowned.length === 0) return contexts;
      return contexts.map((context) =>
        context.id === activeTab
          ? { ...context, turnIds: [...context.turnIds, ...unowned] }
          : context,
      );
    });
  }, [activeTab, turns]);

  const fetchFileDiff = useCallback(
    (id: string, path: string): void => {
      if (!workspaceId) return;
      setFileTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === id && tab.diffStatus === 'unknown'
            ? {
                ...tab,
                diffStatus: 'loading',
                loadingDiff: tab.mode === 'diff',
              }
            : tab,
        ),
      );
      void invoke('diff:file', { workspaceId, path })
        .then((fileDiff) => {
          const hasHunks = fileDiff.hunks.length > 0;
          setFileTabs((tabs) =>
            tabs.map((tab) =>
              tab.id === id
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
              tab.id === id
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
    (path: string, mode: FileTab['mode'] = 'edit'): void => {
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
                  mode:
                    mode === 'diff' && tab.diffStatus === 'none'
                      ? 'edit'
                      : mode,
                }
              : tab,
          );
        }
        return [
          ...tabs,
          {
            id,
            path,
            content: null,
            error: null,
            loading: true,
            mode,
            fileDiff: null,
            diffError: null,
            loadingDiff: mode === 'diff',
            diffStatus: 'unknown',
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
        fetchFileDiff(id, path);
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
    openFile(inspectFileRequest.path, inspectFileRequest.mode ?? 'edit');
  }, [inspectFileRequest, openFile, workspaceId]);

  const closeFileTab = (id: string): void => {
    setFileTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    setActiveTab((current) => (current === id ? 'chat' : current));
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
      fetchFileDiff(file.id, file.path);
    }
  };

  const startNewChat = (): void => {
    const id = `chat:${Date.now()}:${chatContexts.length}`;
    setChatContexts((contexts) => [
      ...contexts,
      {
        id,
        label: 'Untitled',
        turnIds: [],
        initialSessionId: null,
      },
    ]);
    setActiveTab(id);
  };

  const closeChatContext = (id: string): void => {
    if (isBusy) return;
    const closingIndex = chatContexts.findIndex((context) => context.id === id);
    if (closingIndex < 0) return;
    if (chatContexts.length === 1) {
      const replacement: ChatContext = {
        id: `chat:${Date.now()}:replacement`,
        label: 'Untitled',
        turnIds: [],
        initialSessionId: null,
      };
      setChatContexts([replacement]);
      setActiveTab(replacement.id);
      return;
    }
    const remaining = chatContexts.filter((context) => context.id !== id);
    setChatContexts(remaining);
    setActiveTab((current) => {
      if (current !== id) return current;
      return (
        remaining[Math.min(closingIndex, remaining.length - 1)]?.id ?? 'chat'
      );
    });
  };

  const beginRenameContext = (context: ChatContext): void => {
    setEditingContextId(context.id);
    setContextNameDraft(context.label);
  };

  const finishRenameContext = (): void => {
    if (editingContextId === null) return;
    const label = contextNameDraft.trim() || 'Untitled';
    setChatContexts((contexts) =>
      contexts.map((context) =>
        context.id === editingContextId ? { ...context, label } : context,
      ),
    );
    setEditingContextId(null);
  };

  const activeFile = fileTabs.find((tab) => tab.id === activeTab) ?? null;
  const activeContext =
    chatContexts.find((context) => context.id === activeTab) ?? chatContexts[0];
  const activeTurnIds = new Set(activeContext?.turnIds ?? []);
  const contextTurns = turns.filter((turn) => activeTurnIds.has(turn.turnId));
  const contextSessionId =
    contextTurns.at(-1)?.sessionId ?? activeContext?.initialSessionId;

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
                  onBlur={finishRenameContext}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') finishRenameContext();
                    if (event.key === 'Escape') setEditingContextId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="h-full max-w-32 truncate"
                  title={`${context.label} — double-click to rename`}
                  onClick={() => setActiveTab(context.id)}
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
                onClick={() => closeChatContext(context.id)}
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
            onClick={startNewChat}
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
      {activeFile ? (
        <FileViewer
          file={activeFile}
          onModeChange={(mode) => setFileMode(activeFile, mode)}
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
              )
            }
            onApprovePlan={() =>
              sendTurn(
                'The plan is approved. Start implementing it now.',
                [],
                'default',
                undefined,
                contextSessionId,
              )
            }
          />
          <WorkspaceCreationTerminal workspaceId={workspaceId} />
          <WorkspaceArchiveTerminal workspaceId={workspaceId} />
          <Composer
            isBusy={isBusy}
            workspaceId={workspaceId}
            contextId={activeContext?.id}
            turns={contextTurns}
            onSend={(prompt, attachments, mode, harness, model) =>
              sendTurn(
                prompt,
                attachments,
                mode,
                harness,
                contextSessionId,
                model,
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
