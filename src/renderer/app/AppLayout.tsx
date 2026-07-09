// Three-pane app layout (Phase 0 scaffolding — README §3 renderer tree).
//
// Left: sidebar rail (workspace list). Center: the workspace panel — a Chat/Terminal tab
// switcher (chat from Phase 2, terminal + run scripts from Phase 3). Right: context panel
// (checks/details later) — still a labeled placeholder.
//
// The IPC-OK indicator lives in the footer of the left rail so it's always visible as
// the Phase 0 proof that the preload round trip works.

import { useEffect, useMemo, useRef, useState } from 'react';
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
    <div className="flex h-full items-center justify-center p-6 text-sm text-slate-600">
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

/** The top-level 3-pane grid: [rail | content | context]. */
export function AppLayout(): React.JSX.Element {
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const [centerTab, setCenterTab] = useState<CenterTab>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const navTarget = useNavStore((s) => s.target);
  const navigate = useNavStore((s) => s.navigate);
  const consumeNav = useNavStore((s) => s.consume);

  const togglePalette = useUiStore((s) => s.togglePalette);
  const setNewWorkspaceOpen = useUiStore((s) => s.setNewWorkspaceOpen);

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
      className="relative grid h-screen w-screen grid-cols-[240px_1fr_320px] bg-slate-950 text-slate-200"
      data-testid="app-layout"
    >
      {/* Left rail: sidebar + IPC health footer. */}
      <aside className="flex flex-col border-r border-slate-800 bg-slate-900">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Sidebar />
        </div>
        <footer className="flex items-center justify-between gap-2 border-t border-slate-800 p-3">
          <IpcHealth />
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800"
            data-testid="open-settings"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
        </footer>
      </aside>

      {/* Center content pane: Chat (Phase 2) / Terminal (Phase 3) tab switcher. */}
      <main className="flex min-w-0 flex-col overflow-hidden bg-slate-950">
        <div
          className="flex items-center gap-1 border-b border-slate-800 px-2 py-1"
          data-testid="center-tabs"
        >
          {CENTER_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                centerTab === tab.id
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-800/50'
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
      <aside className="border-l border-slate-800 bg-slate-900">
        {selectedWorkspaceId ? (
          <ChecksPanel workspaceId={selectedWorkspaceId} />
        ) : (
          <PanePlaceholder label="Context panel" />
        )}
      </aside>

      {/* Settings overlay (Phase 6) — a global, workspace-independent surface. */}
      {settingsOpen ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/50"
          data-testid="settings-overlay"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="h-[80vh] w-[560px] max-w-[90vw] overflow-hidden rounded-lg border border-slate-800 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <SettingsPanel onClose={() => setSettingsOpen(false)} />
          </div>
        </div>
      ) : null}

      {/* ⌘K command palette (Phase 6, Track H2) — renders only when open (ui store). */}
      <CommandPalette actions={actions} />

      {/* First-run onboarding + unsandboxed-exec disclosure (Phase 6, Track H3). Renders
          only until acknowledged; hidden when onboarding state is unavailable. */}
      <OnboardingWizard />
    </div>
  );
}
