// Three-pane app layout (Phase 0 scaffolding — README §3 renderer tree).
//
// Left: sidebar rail (workspace list). Center: the chat workspace. Right: context/work
// panel with checks, terminal, and Git changes for the selected workspace.
//
// Design system note (Harness Claude Design import, Batch A): a titlebar strip sits above
// the 3-pane grid — `src/main/index.ts` now sets macOS `titleBarStyle: 'hiddenInset'` +
// `trafficLightPosition`, so the strip reserves ~70px on the left for the native traffic
// lights (no fake ones drawn) and carries `-webkit-app-region: drag` so the window is
// draggable from any empty part of the bar; interactive children opt back out with
// `-webkit-app-region: no-drag`. These are the one legitimate inline-`style` exception —
// Tailwind has no utility for the WebKit app-region property.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Activity,
  PanelLeft,
  PanelRight,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';
import { invoke, onEvent } from '@renderer/ipc';
import { Sidebar } from '@renderer/features/sidebar/Sidebar';
import { ChatPanel } from '@renderer/features/chat/ChatPanel';
import { TerminalPanel } from '@renderer/features/terminal/TerminalPanel';
import { DiffPanel } from '@renderer/features/diff/DiffPanel';
import { TasksPanel } from '@renderer/features/tasks/TasksPanel';
import { SettingsPanel } from '@renderer/features/settings/SettingsPanel';
import { UsagePanel } from '@renderer/features/usage/UsagePanel';
import { OpenInAppMenu } from '@renderer/features/workspace/OpenInAppMenu';
import { archiveWorkspaceWithConfirmation } from '@renderer/features/workspace/actions';
import { CommandPalette } from '@renderer/features/palette/CommandPalette';
import { Dialog, IconButton, Kbd } from '@renderer/components/ui';
import {
  useCommands,
  type CommandActions,
} from '@renderer/features/palette/useCommands';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useNavStore } from '@renderer/stores/nav';
import { useUiStore } from '@renderer/stores/ui';

// `-webkit-app-region` is a WebKit/Electron-only CSS property with no Tailwind utility —
// the one sanctioned inline-style use. The installed `csstype` doesn't type it, hence the
// double assertion rather than a direct `CSSProperties` literal (which would fail the
// excess-property check).
const DRAG_STYLE = { WebkitAppRegion: 'drag' } as unknown as CSSProperties;
const NO_DRAG_STYLE = {
  WebkitAppRegion: 'no-drag',
} as unknown as CSSProperties;

type SidePane = 'left' | 'right';
type WorkPane = 'tasks' | 'terminal';

interface InspectFileRequest {
  id: number;
  workspaceId: string;
  path: string;
  mode: 'edit' | 'diff';
}

const DEFAULT_PANE_WIDTH: Record<SidePane, number> = {
  left: 280,
  right: 360,
};
const PANE_STORAGE_KEY: Record<SidePane, string> = {
  left: 'harness.layout.leftPaneWidth',
  right: 'harness.layout.rightPaneWidth',
};
const PANE_OPEN_STORAGE_KEY: Record<SidePane, string> = {
  left: 'harness.layout.leftPaneOpen',
  right: 'harness.layout.rightPaneOpen',
};
const WORK_PANE_RESIZE_FALLBACK_HEIGHT: Record<WorkPane, number> = {
  tasks: 224,
  terminal: 224,
};

function validSize(size: number): number {
  return Math.max(0, size);
}

function readStoredPaneWidth(side: SidePane): number {
  const stored = Number(window.localStorage.getItem(PANE_STORAGE_KEY[side]));
  return Number.isFinite(stored) && stored > 0
    ? validSize(stored)
    : DEFAULT_PANE_WIDTH[side];
}

function readStoredPaneOpen(side: SidePane): boolean {
  return window.localStorage.getItem(PANE_OPEN_STORAGE_KEY[side]) !== 'false';
}

interface PaneResizeHandleProps {
  side: SidePane;
  width: number;
  onResize: (width: number) => void;
}

/** Mouse- and keyboard-accessible divider between a side pane and the center pane. */
function PaneResizeHandle({
  side,
  width,
  onResize,
}: PaneResizeHandleProps): React.JSX.Element {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const startResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    cleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const handleMouseMove = (moveEvent: MouseEvent): void => {
      const pointerDelta = moveEvent.clientX - startX;
      const paneDelta = side === 'left' ? pointerDelta : -pointerDelta;
      onResize(validSize(startWidth + paneDelta));
    };
    const cleanup = (): void => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      cleanupRef.current = null;
    };
    cleanupRef.current = cleanup;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', cleanup);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const pointerDelta = event.key === 'ArrowRight' ? 16 : -16;
    const paneDelta = side === 'left' ? pointerDelta : -pointerDelta;
    onResize(validSize(width + paneDelta));
  };

  return (
    <div
      role="separator"
      aria-label={`Resize ${side} pane`}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuenow={width}
      tabIndex={0}
      className="group relative z-10 w-px shrink-0 cursor-col-resize bg-border-1 outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
      data-testid={`${side}-resize-handle`}
      onMouseDown={startResize}
      onKeyDown={handleKeyDown}
    >
      <span
        className="absolute inset-y-0 -left-1 -right-1"
        aria-hidden="true"
      />
    </div>
  );
}

interface WorkPaneResizeHandleProps {
  pane: WorkPane;
  height: number | null;
  onResize: (height: number) => void;
}

/** Horizontal divider for resizing stacked work panes in the right panel. */
function WorkPaneResizeHandle({
  pane,
  height,
  onResize,
}: WorkPaneResizeHandleProps): React.JSX.Element {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const currentHeight = (): number => {
    if (height !== null) return height;
    const measuredHeight = document
      .querySelector<HTMLElement>(`[data-testid="right-${pane}-pane"]`)
      ?.getBoundingClientRect().height;
    return measuredHeight && measuredHeight > 0
      ? measuredHeight
      : WORK_PANE_RESIZE_FALLBACK_HEIGHT[pane];
  };

  const startResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    cleanupRef.current?.();

    const startY = event.clientY;
    const startHeight = currentHeight();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      onResize(validSize(startHeight + startY - moveEvent.clientY));
    };
    const cleanup = (): void => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      cleanupRef.current = null;
    };

    cleanupRef.current = cleanup;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', cleanup);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? 16 : -16;
    onResize(validSize(currentHeight() + delta));
  };

  return (
    <div
      role="separator"
      aria-label={`Resize ${pane} pane`}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuenow={height ?? WORK_PANE_RESIZE_FALLBACK_HEIGHT[pane]}
      tabIndex={0}
      className="group relative z-10 h-px shrink-0 cursor-row-resize bg-border-1 outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
      data-testid={`${pane}-resize-handle`}
      onMouseDown={startResize}
      onKeyDown={handleKeyDown}
    >
      <span
        className="absolute -bottom-1 -top-1 inset-x-0"
        aria-hidden="true"
      />
    </div>
  );
}

/** The top-level adjustable 3-pane shell: [rail | content | context]. */
export function AppLayout(): React.JSX.Element {
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const selectedProjectId = useWorkspacesStore((s) => s.selectedProjectId);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const [leftPaneOpen, setLeftPaneOpen] = useState(() =>
    readStoredPaneOpen('left'),
  );
  const [rightPaneOpen, setRightPaneOpen] = useState(() =>
    readStoredPaneOpen('right'),
  );
  const [leftPaneWidth, setLeftPaneWidth] = useState(() =>
    readStoredPaneWidth('left'),
  );
  const [rightPaneWidth, setRightPaneWidth] = useState(() =>
    readStoredPaneWidth('right'),
  );
  const [tasksPaneHeight, setTasksPaneHeight] = useState<number | null>(null);
  const [terminalPaneHeight, setTerminalPaneHeight] = useState<number | null>(
    null,
  );
  const [terminalWorkspaceIds, setTerminalWorkspaceIds] = useState<string[]>(
    () => (selectedWorkspaceId ? [selectedWorkspaceId] : []),
  );
  const [inspectFileRequest, setInspectFileRequest] =
    useState<InspectFileRequest | null>(null);
  const [knowledgeReviewRequestId, setKnowledgeReviewRequestId] = useState(0);

  const navTarget = useNavStore((s) => s.target);
  const navigate = useNavStore((s) => s.navigate);
  const consumeNav = useNavStore((s) => s.consume);

  const togglePalette = useUiStore((s) => s.togglePalette);
  const setNewWorkspaceOpen = useUiStore((s) => s.setNewWorkspaceOpen);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    setTerminalWorkspaceIds((ids) =>
      ids.includes(selectedWorkspaceId) ? ids : [...ids, selectedWorkspaceId],
    );
  }, [selectedWorkspaceId]);

  useEffect(() => {
    window.localStorage.setItem(
      PANE_OPEN_STORAGE_KEY.left,
      String(leftPaneOpen),
    );
  }, [leftPaneOpen]);
  useEffect(() => {
    window.localStorage.setItem(
      PANE_OPEN_STORAGE_KEY.right,
      String(rightPaneOpen),
    );
  }, [rightPaneOpen]);
  useEffect(() => {
    window.localStorage.setItem(PANE_STORAGE_KEY.left, String(leftPaneWidth));
  }, [leftPaneWidth]);
  useEffect(() => {
    window.localStorage.setItem(PANE_STORAGE_KEY.right, String(rightPaneWidth));
  }, [rightPaneWidth]);
  // The shared action registry: the ⌘K palette renders + runs these, and the
  // `menu:action` dispatcher below runs the SAME `byId` entries, so a keyboard
  // accelerator and a palette entry can never diverge. `openPr` publishes/opens the PR
  // for the selected workspace (spec §5.6, ⌘⇧P); it no-ops when nothing is selected and
  // swallows errors (the Checks pane surfaces PR state — a menu action must not throw).
  const actions = useMemo<CommandActions>(
    () => ({
      showPane: (pane) => {
        if (pane !== 'chat') setRightPaneOpen(true);
      },
      openSettings: () => setSettingsOpen(true),
      newWorkspace: () => setNewWorkspaceOpen(true),
      openPr: () => {
        const { selectedWorkspaceId } = useWorkspacesStore.getState();
        if (!selectedWorkspaceId) return;
        void invoke('pr:open', { workspaceId: selectedWorkspaceId }).catch(
          () => {
            /* PR errors surface in the Checks pane; a menu action must not throw. */
          },
        );
      },
      selectWorkspace: (id) => selectWorkspace(id),
    }),
    [selectWorkspace, setNewWorkspaceOpen],
  );

  // Keep the current registry reachable from the (once-subscribed) menu handler without
  // re-subscribing every time the workspace list changes the switch commands.
  const { byId } = useCommands(actions);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  // Deep-link intake: a `nav:deepLink` broadcast (main resolved an `harness://…` URL)
  // becomes a pending nav target in the store. Torn down on unmount (no listener leak).
  useEffect(
    () => onEvent('nav:deepLink', (target) => navigate(target)),
    [navigate],
  );

  // Act on a pending deep-link target: focus the workspace and reveal the fixed right
  // work area for diff/PR targets, then clear it so the same target doesn't re-fire.
  useEffect(() => {
    if (navTarget === null) return;
    selectWorkspace(navTarget.workspaceId);
    if (
      navTarget.pane === 'diff' ||
      navTarget.pane === 'pr' ||
      navTarget.pane === 'knowledge'
    ) {
      setRightPaneOpen(true);
    }
    if (navTarget.pane === 'knowledge') {
      setKnowledgeReviewRequestId((id) => id + 1);
    }
    consumeNav();
  }, [navTarget, selectWorkspace, consumeNav]);

  // App-menu accelerators (spec §5.4): main broadcasts `menu:action` with an action id
  // from the keymap. ⌘K toggles the palette; the POSITIONAL `selectWorkspace:<n>` (⌘1…⌘9)
  // maps to list position; every other fixed id is dispatched through the SHARED command
  // registry (`byIdRef`) so a shortcut and a palette entry can't diverge. Subscribed once
  // (stable deps); the workspace list + registry are read via a ref / getState().
  useEffect(
    () =>
      onEvent('menu:action', ({ actionId }) => {
        if (actionId === 'commandPalette') return togglePalette();
        if (actionId === 'archiveWorkspace') {
          const { workspaces, selectedWorkspaceId } =
            useWorkspacesStore.getState();
          const workspace = workspaces.find(
            (row) =>
              row.id === selectedWorkspaceId && row.status !== 'archived',
          );
          if (workspace) {
            void archiveWorkspaceWithConfirmation(workspace).catch((error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              window.alert(`Failed to archive workspace: ${message}`);
            });
          }
          return;
        }
        const match = /^selectWorkspace:(\d+)$/.exec(actionId);
        if (match) {
          const { workspaces, selectedProjectId } =
            useWorkspacesStore.getState();
          const list = workspaces.filter(
            (w) =>
              (selectedProjectId === null ||
                w.projectId === selectedProjectId) &&
              w.status !== 'archived',
          );
          const target = list[Number(match[1]) - 1];
          if (target) selectWorkspace(target.id);
          return;
        }
        byIdRef.current.get(actionId)?.run();
      }),
    [selectWorkspace, togglePalette],
  );

  const leftPaneToggle = (
    <IconButton
      label={leftPaneOpen ? 'Hide left pane' : 'Show left pane'}
      size="lg"
      active={leftPaneOpen}
      aria-pressed={leftPaneOpen}
      style={NO_DRAG_STYLE}
      data-testid="toggle-left-pane"
      onClick={() => setLeftPaneOpen((open) => !open)}
    >
      <PanelLeft className="h-4 w-4" aria-hidden="true" />
    </IconButton>
  );
  const titlebarSearch = (
    <button
      type="button"
      onClick={togglePalette}
      className="flex h-9 w-64 items-center gap-2 rounded-2 border border-border-1 bg-bg-3 px-3 text-xs text-fg-3 transition-colors duration-fast ease-out hover:border-border-2 hover:text-fg-2"
      data-testid="titlebar-search"
      aria-label="Open command palette"
    >
      <Search className="h-4 w-4" aria-hidden="true" />
      <span className="flex-1 text-left">Search logs or agents...</span>
      <Kbd keys="⌘K" />
    </button>
  );
  const rightPaneToggle = (
    <IconButton
      label={rightPaneOpen ? 'Hide right pane' : 'Show right pane'}
      size="md"
      active={rightPaneOpen}
      aria-pressed={rightPaneOpen}
      data-testid="toggle-right-pane"
      onClick={() => setRightPaneOpen((open) => !open)}
    >
      <PanelRight className="h-4 w-4" aria-hidden="true" />
    </IconButton>
  );

  return (
    <div
      className="relative flex h-screen w-screen flex-col bg-surface-app text-fg-2"
      data-testid="app-layout"
    >
      <div className="flex min-h-0 flex-1" data-testid="app-panes">
        {/* Left rail: sidebar + IPC health footer. */}
        {leftPaneOpen ? (
          <>
            <aside
              className="flex shrink-0 flex-col border-r border-border-1 bg-surface-panel"
              style={{ width: leftPaneWidth }}
              data-testid="left-pane"
            >
              <header
                className="flex h-titlebar shrink-0 items-center border-b border-border-1 pl-[88px] pr-3"
                style={DRAG_STYLE}
                data-testid="left-titlebar"
              >
                <div className="flex-1" />
                {leftPaneToggle}
              </header>
              <div className="shrink-0 border-b border-border-1 px-3 py-4">
                <div className="flex items-center gap-2.5 px-2">
                  <img
                    src={
                      new URL('../../../build/icon.png', import.meta.url).href
                    }
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-2"
                    data-testid="sidebar-app-icon"
                  />
                  <div className="min-w-0 leading-none">
                    <div className="truncate text-sm font-bold tracking-tight text-fg-1">
                      Harness
                    </div>
                    <div className="mt-1 truncate font-mono text-[8px] uppercase tracking-[0.18em] text-fg-3">
                      Parallel Engine
                    </div>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Sidebar />
              </div>
              <footer className="space-y-1 border-t border-border-1 p-3">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-2 px-2 py-2 text-xs text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                  data-testid="open-usage"
                  onClick={() => setUsageOpen(true)}
                >
                  <Activity className="h-4 w-4" aria-hidden="true" />
                  Usage
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-2 px-2 py-2 text-xs text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                  data-testid="open-settings"
                  onClick={() => setSettingsOpen(true)}
                >
                  <SettingsIcon className="h-4 w-4" aria-hidden="true" />
                  Settings
                </button>
              </footer>
            </aside>
            <PaneResizeHandle
              side="left"
              width={leftPaneWidth}
              onResize={setLeftPaneWidth}
            />
          </>
        ) : null}

        {/* Center content pane: chat stays central; terminal and Git changes live in
            the right work area so they remain visible beside the conversation. */}
        <main
          className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-app"
          data-testid="center-pane"
        >
          {/* The workspace title belongs to the center column, so it remains centered
              over the working area rather than over the entire application window. */}
          <header
            className={`relative flex h-titlebar shrink-0 items-center border-b border-border-1 px-3 ${
              leftPaneOpen ? '' : 'pl-[96px]'
            }`}
            style={DRAG_STYLE}
            data-testid="center-titlebar"
          >
            {!leftPaneOpen ? leftPaneToggle : null}
            <span className="sr-only" data-testid="workspace-title">
              Harness
            </span>
            <div
              className="ml-auto flex items-center gap-2"
              style={NO_DRAG_STYLE}
            >
              {titlebarSearch}
              <OpenInAppMenu workspaceId={selectedWorkspaceId} />
              {rightPaneToggle}
            </div>
          </header>
          <div className="min-h-0 flex-1">
            <ChatPanel
              workspaceId={selectedWorkspaceId}
              inspectFileRequest={inspectFileRequest}
            />
          </div>
        </main>

        {/* Right work panel: Git changes above a bottom terminal. */}
        {rightPaneOpen ? (
          <>
            <PaneResizeHandle
              side="right"
              width={rightPaneWidth}
              onResize={setRightPaneWidth}
            />
            <aside
              className="flex shrink-0 flex-col overflow-hidden bg-surface-panel"
              style={{ width: rightPaneWidth }}
              data-testid="right-pane"
            >
              <div
                className="flex min-h-0 flex-1 flex-col"
                data-testid="right-work-area"
                data-terminal-collapsed={terminalCollapsed}
              >
                <section
                  className="min-h-0 flex-1 basis-0"
                  data-testid="right-git-pane"
                >
                  <DiffPanel
                    workspaceId={selectedWorkspaceId}
                    onInspectFile={(path) => {
                      if (!selectedWorkspaceId) return;
                      setInspectFileRequest({
                        id: Date.now(),
                        workspaceId: selectedWorkspaceId,
                        path,
                        mode: 'diff',
                      });
                    }}
                  />
                </section>
                <WorkPaneResizeHandle
                  pane="tasks"
                  height={tasksPaneHeight}
                  onResize={setTasksPaneHeight}
                />
                <section
                  className={
                    tasksPaneHeight === null
                      ? 'min-h-0 flex-1 basis-0'
                      : 'shrink-0'
                  }
                  style={
                    tasksPaneHeight === null
                      ? undefined
                      : { height: tasksPaneHeight }
                  }
                  data-testid="right-tasks-pane"
                >
                  <TasksPanel
                    workspaceId={selectedWorkspaceId}
                    projectId={selectedProjectId}
                    knowledgeReviewRequestId={knowledgeReviewRequestId}
                  />
                </section>
                {!terminalCollapsed ? (
                  <WorkPaneResizeHandle
                    pane="terminal"
                    height={terminalPaneHeight}
                    onResize={setTerminalPaneHeight}
                  />
                ) : null}
                <section
                  className={
                    terminalCollapsed
                      ? 'shrink-0 border-0'
                      : terminalPaneHeight === null
                        ? 'min-h-0 flex-1 basis-0'
                        : 'shrink-0'
                  }
                  style={
                    terminalCollapsed || terminalPaneHeight === null
                      ? undefined
                      : { height: terminalPaneHeight }
                  }
                  data-testid="right-terminal-pane"
                >
                  {terminalWorkspaceIds.length === 0 ? (
                    <TerminalPanel
                      workspaceId={null}
                      collapsed={terminalCollapsed}
                      onToggleCollapsed={() =>
                        setTerminalCollapsed((collapsed) => !collapsed)
                      }
                    />
                  ) : null}
                  {terminalWorkspaceIds.map((workspaceId) => (
                    <div
                      key={workspaceId}
                      className={
                        workspaceId === selectedWorkspaceId
                          ? 'h-full'
                          : 'hidden'
                      }
                    >
                      <TerminalPanel
                        workspaceId={workspaceId}
                        collapsed={terminalCollapsed}
                        onToggleCollapsed={() =>
                          setTerminalCollapsed((collapsed) => !collapsed)
                        }
                      />
                    </div>
                  ))}
                </section>
              </div>
            </aside>
          </>
        ) : null}
      </div>

      {/* Settings overlay (Phase 6) — a global, workspace-independent surface. Uses the
          shared Dialog primitive for the scrim/panel chrome; SettingsPanel (a Batch D file)
          renders its own header/close button inside, so no `title` is passed here. */}
      {settingsOpen ? (
        <Dialog
          data-testid="settings-overlay"
          onClose={() => setSettingsOpen(false)}
          width={1120}
        >
          <SettingsPanel onClose={() => setSettingsOpen(false)} />
        </Dialog>
      ) : null}
      {usageOpen ? (
        <Dialog
          data-testid="usage-overlay"
          onClose={() => setUsageOpen(false)}
          width={960}
        >
          <UsagePanel onClose={() => setUsageOpen(false)} />
        </Dialog>
      ) : null}
      {/* ⌘K command palette (Phase 6, Track H2) — renders only when open (ui store). */}
      <CommandPalette actions={actions} />
    </div>
  );
}
