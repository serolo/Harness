// Three-pane app layout (Phase 0 scaffolding - README §3 renderer tree).
//
// Left: sidebar rail (workspace list). Center: the workspace chat. Right: a vertically
// stacked work area with git changes, checks, tasks, and the terminal.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  PanelLeft,
  PanelRight,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';
import { invoke, onEvent } from '@renderer/ipc';
import { Sidebar } from '@renderer/features/sidebar/Sidebar';
import { IpcHealth } from '@renderer/components/IpcHealth';
import { ChatPanel } from '@renderer/features/chat/ChatPanel';
import { TerminalPanel } from '@renderer/features/terminal/TerminalPanel';
import { DiffPanel } from '@renderer/features/diff/DiffPanel';
import { ChecksPanel } from '@renderer/features/checks/ChecksPanel';
import { TasksPanel } from '@renderer/features/tasks/TasksPanel';
import { useSchedulerTurnEvents } from '@renderer/features/tasks/useSchedulerTurnEvents';
import { SettingsPanel } from '@renderer/features/settings/SettingsPanel';
import { CommandPalette } from '@renderer/features/palette/CommandPalette';
import { OnboardingWizard } from '@renderer/features/onboarding/OnboardingWizard';
import { Dialog, IconButton, Kbd } from '@renderer/components/ui';
import {
  useCommands,
  type CommandActions,
} from '@renderer/features/palette/useCommands';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useNavStore } from '@renderer/stores/nav';
import { useUiStore } from '@renderer/stores/ui';

// `-webkit-app-region` is a WebKit/Electron-only CSS property with no Tailwind utility.
const DRAG_STYLE = { WebkitAppRegion: 'drag' } as unknown as CSSProperties;
const NO_DRAG_STYLE = {
  WebkitAppRegion: 'no-drag',
} as unknown as CSSProperties;

type SidePane = 'left' | 'right';

const PANE_LIMITS: Record<SidePane, { min: number; max: number }> = {
  left: { min: 220, max: 480 },
  right: { min: 520, max: 960 },
};
const DEFAULT_PANE_WIDTH: Record<SidePane, number> = {
  left: 280,
  right: 640,
};
const PANE_STORAGE_KEY: Record<SidePane, string> = {
  left: 'harness.layout.leftPaneWidth',
  right: 'harness.layout.rightPaneWidth',
};
const PANE_OPEN_STORAGE_KEY: Record<SidePane, string> = {
  left: 'harness.layout.leftPaneOpen',
  right: 'harness.layout.rightPaneOpen',
};

function clampPaneWidth(side: SidePane, width: number): number {
  const { min, max } = PANE_LIMITS[side];
  return Math.min(max, Math.max(min, width));
}

function readStoredPaneWidth(side: SidePane): number {
  const stored = Number(window.localStorage.getItem(PANE_STORAGE_KEY[side]));
  return Number.isFinite(stored) && stored > 0
    ? clampPaneWidth(side, stored)
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

function PaneResizeHandle({
  side,
  width,
  onResize,
}: PaneResizeHandleProps): React.JSX.Element {
  const cleanupRef = useRef<(() => void) | null>(null);
  const { min, max } = PANE_LIMITS[side];

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
      onResize(clampPaneWidth(side, startWidth + paneDelta));
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
    onResize(clampPaneWidth(side, width + paneDelta));
  };

  return (
    <div
      role="separator"
      aria-label={`Resize ${side} pane`}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
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

export function AppLayout(): React.JSX.Element {
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const navTarget = useNavStore((s) => s.target);
  const navigate = useNavStore((s) => s.navigate);
  const consumeNav = useNavStore((s) => s.consume);

  const togglePalette = useUiStore((s) => s.togglePalette);
  const setNewWorkspaceOpen = useUiStore((s) => s.setNewWorkspaceOpen);

  useSchedulerTurnEvents();

  const activeWorkspaceName = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId)?.name ?? null,
    [workspaces, selectedWorkspaceId],
  );

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
            /* A menu action must not throw into the renderer. */
          },
        );
      },
      selectWorkspace: (id) => selectWorkspace(id),
    }),
    [selectWorkspace, setNewWorkspaceOpen],
  );

  const { byId } = useCommands(actions);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  useEffect(
    () => onEvent('nav:deepLink', (target) => navigate(target)),
    [navigate],
  );

  useEffect(() => {
    if (navTarget === null) return;
    selectWorkspace(navTarget.workspaceId);
    if (navTarget.pane) setRightPaneOpen(true);
    consumeNav();
  }, [navTarget, selectWorkspace, consumeNav]);

  useEffect(
    () =>
      onEvent('menu:action', ({ actionId }) => {
        if (actionId === 'commandPalette') return togglePalette();
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
  const rightPaneControls = (
    <div className="flex items-center" style={NO_DRAG_STYLE}>
      <button
        type="button"
        onClick={togglePalette}
        className="flex items-center gap-1.5 rounded-2 px-2 py-1 text-xs text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-2"
        data-testid="titlebar-search"
        aria-label="Open command palette"
      >
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        Search
        <Kbd keys="⌘K" />
      </button>
      <IconButton
        label={rightPaneOpen ? 'Hide right pane' : 'Show right pane'}
        size="md"
        active={rightPaneOpen}
        aria-pressed={rightPaneOpen}
        className="ml-1"
        data-testid="toggle-right-pane"
        onClick={() => setRightPaneOpen((open) => !open)}
      >
        <PanelRight className="h-4 w-4" aria-hidden="true" />
      </IconButton>
    </div>
  );

  return (
    <div
      className="relative flex h-screen w-screen flex-col bg-surface-app text-fg-2"
      data-testid="app-layout"
    >
      <div className="flex min-h-0 flex-1" data-testid="app-panes">
        {leftPaneOpen ? (
          <>
            <aside
              className="flex shrink-0 flex-col bg-surface-panel"
              style={{ width: leftPaneWidth }}
              data-testid="left-pane"
            >
              <header
                className="flex h-titlebar shrink-0 items-center pl-[96px] pr-3"
                style={DRAG_STYLE}
                data-testid="left-titlebar"
              >
                {leftPaneToggle}
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Sidebar />
              </div>
              <footer className="flex items-center justify-between gap-2 border-t border-border-1 p-3">
                <IpcHealth />
                <IconButton
                  label="Open settings"
                  size="sm"
                  data-testid="open-settings"
                  onClick={() => setSettingsOpen(true)}
                >
                  <SettingsIcon className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </footer>
            </aside>
            <PaneResizeHandle
              side="left"
              width={leftPaneWidth}
              onResize={setLeftPaneWidth}
            />
          </>
        ) : null}

        <main
          className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-app"
          data-testid="center-pane"
        >
          <header
            className={`relative flex h-titlebar shrink-0 items-center border-b border-border-1 px-3 ${
              leftPaneOpen ? '' : 'pl-[96px]'
            }`}
            style={DRAG_STYLE}
            data-testid="center-titlebar"
          >
            {!leftPaneOpen ? leftPaneToggle : null}
            <span
              className="pointer-events-none absolute inset-x-28 truncate text-center font-display text-sm font-semibold text-fg-2"
              data-testid="workspace-title"
            >
              Harness - {activeWorkspaceName ?? 'no workspace'}
            </span>
            <div
              className="ml-auto flex items-center gap-2"
              style={NO_DRAG_STYLE}
            >
              {!rightPaneOpen ? rightPaneControls : null}
            </div>
          </header>
          <div className="min-h-0 flex-1">
            <ChatPanel workspaceId={selectedWorkspaceId} />
          </div>
        </main>

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
              <header
                className="flex h-titlebar shrink-0 items-center justify-end px-3"
                style={DRAG_STYLE}
                data-testid="right-titlebar"
              >
                {rightPaneControls}
              </header>
              <div
                className={`grid min-h-0 flex-1 ${
                  terminalCollapsed
                    ? 'grid-rows-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]'
                    : 'grid-rows-4'
                }`}
                data-testid="right-work-area"
                data-terminal-collapsed={terminalCollapsed}
              >
                <section
                  className="min-h-0 overflow-hidden"
                  aria-label="Git changes"
                  data-testid="right-git-pane"
                >
                  <DiffPanel workspaceId={selectedWorkspaceId} />
                </section>
                <section
                  className="min-h-0 overflow-hidden border-t border-border-1"
                  aria-label="Checks"
                  data-testid="right-checks-pane"
                >
                  <ChecksPanel workspaceId={selectedWorkspaceId} />
                </section>
                <section
                  className="min-h-0 overflow-hidden border-t border-border-1"
                  aria-label="Tasks"
                  data-testid="right-tasks-pane"
                >
                  <TasksPanel workspaceId={selectedWorkspaceId} />
                </section>
                <section
                  className="min-h-0 overflow-hidden border-t border-border-1"
                  aria-label="Terminal"
                  data-testid="right-terminal-pane"
                >
                  <TerminalPanel
                    workspaceId={selectedWorkspaceId}
                    collapsed={terminalCollapsed}
                    onToggleCollapsed={() =>
                      setTerminalCollapsed((collapsed) => !collapsed)
                    }
                  />
                </section>
              </div>
            </aside>
          </>
        ) : null}
      </div>

      {settingsOpen ? (
        <Dialog
          data-testid="settings-overlay"
          onClose={() => setSettingsOpen(false)}
          width={1120}
        >
          <SettingsPanel onClose={() => setSettingsOpen(false)} />
        </Dialog>
      ) : null}

      <CommandPalette actions={actions} />
      <OnboardingWizard />
    </div>
  );
}
