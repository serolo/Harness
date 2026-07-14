// Three-pane app layout (Phase 0 scaffolding — README §3 renderer tree).
//
// Left: sidebar rail (workspace list). Center: the workspace panel — a Chat/Terminal tab
// switcher (chat from Phase 2, terminal + run scripts from Phase 3). Right: context panel
// (checks/details later) — still a labeled placeholder.
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
import { ChecksPanel } from '@renderer/features/checks/ChecksPanel';
import { SettingsPanel } from '@renderer/features/settings/SettingsPanel';
import { OpenInAppMenu } from '@renderer/features/workspace/OpenInAppMenu';
import { archiveWorkspaceWithConfirmation } from '@renderer/features/workspace/actions';
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

/** Empty-state placeholder used by the right context pane. */
function PanePlaceholder({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-fg-3">
      {label}
    </div>
  );
}

/** Which view the center pane shows for the selected workspace. */
type CenterTab = 'chat' | 'terminal' | 'diff';

const CENTER_TABS: { id: CenterTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'diff', label: 'Diff' },
];

// `-webkit-app-region` is a WebKit/Electron-only CSS property with no Tailwind utility —
// the one sanctioned inline-style use. The installed `csstype` doesn't type it, hence the
// double assertion rather than a direct `CSSProperties` literal (which would fail the
// excess-property check).
const DRAG_STYLE = { WebkitAppRegion: 'drag' } as unknown as CSSProperties;
const NO_DRAG_STYLE = {
  WebkitAppRegion: 'no-drag',
} as unknown as CSSProperties;

type SidePane = 'left' | 'right';

const PANE_LIMITS: Record<SidePane, { min: number; max: number }> = {
  left: { min: 220, max: 480 },
  right: { min: 260, max: 560 },
};
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

/** Mouse- and keyboard-accessible divider between a side pane and the center pane. */
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

/** The top-level adjustable 3-pane shell: [rail | content | context]. */
export function AppLayout(): React.JSX.Element {
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const [centerTab, setCenterTab] = useState<CenterTab>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  // The shared action registry: the ⌘K palette renders + runs these, and the
  // `menu:action` dispatcher below runs the SAME `byId` entries, so a keyboard
  // accelerator and a palette entry can never diverge. `openPr` publishes/opens the PR
  // for the selected workspace (spec §5.6, ⌘⇧P); it no-ops when nothing is selected and
  // swallows errors (the Checks pane surfaces PR state — a menu action must not throw).
  const actions = useMemo<CommandActions>(
    () => ({
      showPane: (pane) => setCenterTab(pane),
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

  // Act on a pending deep-link target: focus the workspace, switch to the requested
  // pane (`diff` → the Diff tab; `pr` shows in the always-visible checks pane), then
  // clear it so the same target doesn't re-fire.
  useEffect(() => {
    if (navTarget === null) return;
    selectWorkspace(navTarget.workspaceId);
    if (navTarget.pane === 'diff') setCenterTab('diff');
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
        {/* Left rail: sidebar + IPC health footer. */}
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
              <footer className="flex items-center justify-end border-t border-border-1 p-3">
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

        {/* Center content pane: Chat (Phase 2) / Terminal (Phase 3) tab switcher. */}
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
            <span
              className="pointer-events-none absolute inset-x-28 truncate text-center font-display text-sm font-semibold tracking-[-0.01em] text-fg-2"
              data-testid="workspace-title"
            >
              Harness — {activeWorkspaceName ?? 'no workspace'}
            </span>
            <div
              className="ml-auto flex items-center gap-2"
              style={NO_DRAG_STYLE}
            >
              <OpenInAppMenu workspaceId={selectedWorkspaceId} />
              {!rightPaneOpen ? rightPaneControls : null}
            </div>
          </header>
          {/*
            Visually mirrors `components/ui/Tabs` (bg-bg-4/text-fg-1 active,
            text-fg-2/hover:bg-bg-3 inactive) but stays hand-rolled: the Tabs primitive
            emits `aria-selected` with no per-tab `data-testid`, while AppLayout.nav.test.tsx
            asserts `aria-pressed` on `center-tab-<id>` — preserving that contract took
            priority over the primitive swap.
          */}
          <div
            className="flex items-center gap-1 border-b border-border-1 px-2 py-1"
            data-testid="center-tabs"
          >
            {CENTER_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`rounded-2 px-2.5 py-1 text-xs font-medium transition-colors duration-fast ease-out ${
                  centerTab === tab.id
                    ? 'bg-bg-4 text-fg-1'
                    : 'text-fg-2 hover:bg-bg-3'
                }`}
                data-testid={`center-tab-${tab.id}`}
                aria-pressed={centerTab === tab.id}
                onClick={() => setCenterTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {centerTab === 'chat' ? (
              <ChatPanel workspaceId={selectedWorkspaceId} />
            ) : centerTab === 'terminal' ? (
              <TerminalPanel workspaceId={selectedWorkspaceId} />
            ) : (
              <DiffPanel workspaceId={selectedWorkspaceId} />
            )}
          </div>
        </main>

        {/* Right context panel: merge-readiness Checks for the selected workspace
            (Phase 5). With no workspace selected the Phase-0 placeholder still shows. */}
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
              <div className="min-h-0 flex-1">
                {selectedWorkspaceId ? (
                  <ChecksPanel workspaceId={selectedWorkspaceId} />
                ) : (
                  <PanePlaceholder label="Context panel" />
                )}
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

      {/* ⌘K command palette (Phase 6, Track H2) — renders only when open (ui store). */}
      <CommandPalette actions={actions} />

      {/* First-run onboarding + unsandboxed-exec disclosure (Phase 6, Track H3). Renders
          only until acknowledged; hidden when onboarding state is unavailable. */}
      <OnboardingWizard />
    </div>
  );
}
