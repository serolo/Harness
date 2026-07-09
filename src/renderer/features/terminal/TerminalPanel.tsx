// TerminalPanel — the terminal + run-scripts surface for the selected workspace.
//
// Layout: a toolbar (new terminal, big-terminal toggle, open-in-IDE), the run-scripts
// overlay (`RunPanel`), a tab bar, and the stacked terminal surfaces (all tabs stay mounted
// so their shells survive tab switches — see `TerminalTab`). Tab identity + the big-terminal
// toggle live in the client-side `terminalStore`; the shells themselves live in main.
//
// Big-terminal mode maximizes the pane as a full-window overlay. This exposes the toggle
// state + command; a keyboard shortcut for it is wired in a later phase.

import type { IdeName } from '@shared/ipc';
import { invoke } from '@renderer/ipc';
import { RunPanel } from './RunPanel';
import { TerminalTab } from './TerminalTab';
import { useTerminalStore, type TerminalTabInfo } from './terminalStore';

/** Stable empty-array reference so the `tabs` selector doesn't loop on `?? []`. */
const EMPTY_TABS: readonly TerminalTabInfo[] = [];

const IDES: { id: IdeName; label: string }[] = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'code', label: 'VS Code' },
];

export interface TerminalPanelProps {
  workspaceId: string | null;
}

export function TerminalPanel({
  workspaceId,
}: TerminalPanelProps): React.JSX.Element {
  const tabs = useTerminalStore((s) =>
    workspaceId ? (s.tabsByWorkspace[workspaceId] ?? EMPTY_TABS) : EMPTY_TABS,
  ) as TerminalTabInfo[];
  const activeTabId = useTerminalStore((s) =>
    workspaceId ? (s.activeTabByWorkspace[workspaceId] ?? null) : null,
  );
  const bigTerminal = useTerminalStore((s) => s.bigTerminal);
  const openTab = useTerminalStore((s) => s.openTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const toggleBigTerminal = useTerminalStore((s) => s.toggleBigTerminal);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-slate-600"
        data-testid="terminal-empty"
      >
        Select a workspace to open a terminal.
      </div>
    );
  }

  const openIde = (ide: IdeName): void => {
    void invoke('ide:open', { workspaceId, ide }).catch(() => {});
  };

  const containerClass = bigTerminal
    ? 'fixed inset-0 z-50 flex flex-col bg-slate-950'
    : 'flex h-full flex-col bg-slate-950';

  return (
    <div className={containerClass} data-testid="terminal-panel">
      {/* Toolbar: new terminal, big-terminal toggle, open-in-IDE. */}
      <div className="flex items-center gap-2 border-b border-slate-800 p-2">
        <button
          type="button"
          className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
          data-testid="terminal-new"
          onClick={() => openTab(workspaceId)}
        >
          + Terminal
        </button>
        <button
          type="button"
          className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
          data-testid="terminal-big-toggle"
          aria-pressed={bigTerminal}
          onClick={() => toggleBigTerminal()}
        >
          {bigTerminal ? 'Exit Big Terminal' : 'Big Terminal'}
        </button>
        <div className="ml-auto flex items-center gap-1">
          {IDES.map((ide) => (
            <button
              key={ide.id}
              type="button"
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
              data-testid={`ide-open-${ide.id}`}
              onClick={() => openIde(ide.id)}
            >
              Open in {ide.label}
            </button>
          ))}
        </div>
      </div>

      {/* Run-scripts overlay. */}
      <div className="border-b border-slate-800">
        <RunPanel workspaceId={workspaceId} />
      </div>

      {/* Tab bar. */}
      <div
        className="flex items-center gap-1 overflow-x-auto border-b border-slate-800 px-2 py-1"
        data-testid="terminal-tabs"
      >
        {tabs.length === 0 ? (
          <span className="px-1 text-xs text-slate-600">
            No terminals open.
          </span>
        ) : (
          tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ${
                  active
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-800/50'
                }`}
              >
                <button
                  type="button"
                  data-testid={`terminal-tab-${tab.id}`}
                  onClick={() => setActiveTab(workspaceId, tab.id)}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  className="text-slate-500 hover:text-slate-200"
                  data-testid={`terminal-tab-close-${tab.id}`}
                  aria-label={`Close ${tab.title}`}
                  onClick={() => closeTab(workspaceId, tab.id)}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Terminal surfaces: all mounted, only the active one visible. */}
      <div className="relative min-h-0 flex-1" data-testid="terminal-surfaces">
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-600">
            Open a terminal to get a shell in this workspace.
          </div>
        ) : (
          tabs.map((tab) => (
            <TerminalTab
              key={tab.id}
              workspaceId={workspaceId}
              tabId={tab.id}
              active={tab.id === activeTabId}
            />
          ))
        )}
      </div>
    </div>
  );
}
