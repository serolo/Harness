// Three-pane app layout (Phase 0 scaffolding — README §3 renderer tree).
//
// Left: sidebar rail (workspace list). Center: the workspace panel — a Chat/Terminal tab
// switcher (chat from Phase 2, terminal + run scripts from Phase 3). Right: context panel
// (checks/details later) — still a labeled placeholder.
//
// The IPC-OK indicator lives in the footer of the left rail so it's always visible as
// the Phase 0 proof that the preload round trip works.
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
import { Search, Settings as SettingsIcon } from 'lucide-react';
import { invoke, onEvent } from '@renderer/ipc';
import { Sidebar } from '@renderer/features/sidebar/Sidebar';
import { IpcHealth } from '@renderer/components/IpcHealth';
import { ChatPanel } from '@renderer/features/chat/ChatPanel';
import { TerminalPanel } from '@renderer/features/terminal/TerminalPanel';
import { DiffPanel } from '@renderer/features/diff/DiffPanel';
import { ChecksPanel } from '@renderer/features/checks/ChecksPanel';
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

/** The top-level 3-pane grid: [rail | content | context]. */
export function AppLayout(): React.JSX.Element {
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const [centerTab, setCenterTab] = useState<CenterTab>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const navTarget = useNavStore((s) => s.target);
  const navigate = useNavStore((s) => s.navigate);
  const consumeNav = useNavStore((s) => s.consume);

  const togglePalette = useUiStore((s) => s.togglePalette);
  const setNewWorkspaceOpen = useUiStore((s) => s.setNewWorkspaceOpen);

  const activeWorkspaceName = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId)?.name ?? null,
    [workspaces, selectedWorkspaceId],
  );

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

  return (
    <div
      className="relative flex h-screen w-screen flex-col bg-surface-app text-fg-2"
      data-testid="app-layout"
    >
      {/* Titlebar strip — left padding reserves room for the native macOS traffic lights
          (trafficLightPosition {x:14,y:13} in src/main/index.ts); the bar itself is a drag
          region so the window can be moved from any empty area. */}
      <div
        className="relative flex h-titlebar shrink-0 items-center border-b border-border-1 bg-surface-panel pl-[70px] pr-3"
        style={DRAG_STYLE}
        data-testid="titlebar"
      >
        <span className="pointer-events-none absolute inset-x-0 truncate text-center font-display text-sm font-semibold tracking-[-0.01em] text-fg-2">
          Harness — {activeWorkspaceName ?? 'no workspace'}
        </span>
        <button
          type="button"
          onClick={togglePalette}
          style={NO_DRAG_STYLE}
          className="relative ml-auto flex items-center gap-1.5 rounded-2 px-2 py-1 text-xs text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-2"
          data-testid="titlebar-search"
          aria-label="Open command palette"
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          Search
          <Kbd keys="⌘K" />
        </button>
      </div>

      <div
        className="grid min-h-0 flex-1 grid-cols-[var(--sidebar-width)_1fr_var(--context-width)]"
        data-testid="app-panes"
      >
        {/* Left rail: sidebar + IPC health footer. */}
        <aside className="flex flex-col border-r border-border-1 bg-surface-panel">
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

        {/* Center content pane: Chat (Phase 2) / Terminal (Phase 3) tab switcher. */}
        <main className="flex min-w-0 flex-col overflow-hidden bg-surface-app">
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
        <aside className="border-l border-border-1 bg-surface-panel">
          {selectedWorkspaceId ? (
            <ChecksPanel workspaceId={selectedWorkspaceId} />
          ) : (
            <PanePlaceholder label="Context panel" />
          )}
        </aside>
      </div>

      {/* Settings overlay (Phase 6) — a global, workspace-independent surface. Uses the
          shared Dialog primitive for the scrim/panel chrome; SettingsPanel (a Batch D file)
          renders its own header/close button inside, so no `title` is passed here. */}
      {settingsOpen ? (
        <Dialog
          data-testid="settings-overlay"
          onClose={() => setSettingsOpen(false)}
          width={560}
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
