// TerminalPanel — the terminal + run-scripts surface for the selected workspace.
//
// Layout: a compact tab bar with new-terminal and collapse controls, followed by the
// stacked terminal surfaces. All tabs stay mounted so their shells survive tab switches
// and collapsing the section — see `TerminalTab`. Tab identity lives in the client-side
// `terminalStore`; the shells themselves live in main.

import { useEffect } from 'react';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { IconButton } from '@renderer/components/ui';
import { TerminalTab } from './TerminalTab';
import { useTerminalStore, type TerminalTabInfo } from './terminalStore';

/** Stable empty-array reference so the `tabs` selector doesn't loop on `?? []`. */
const EMPTY_TABS: readonly TerminalTabInfo[] = [];

export interface TerminalPanelProps {
  workspaceId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function TerminalPanel({
  workspaceId,
  collapsed,
  onToggleCollapsed,
}: TerminalPanelProps): React.JSX.Element {
  const tabs = useTerminalStore((s) =>
    workspaceId ? (s.tabsByWorkspace[workspaceId] ?? EMPTY_TABS) : EMPTY_TABS,
  ) as TerminalTabInfo[];
  const activeTabId = useTerminalStore((s) =>
    workspaceId ? (s.activeTabByWorkspace[workspaceId] ?? null) : null,
  );
  const openTab = useTerminalStore((s) => s.openTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);

  // Give each workspace a ready-to-use shell the first time its terminal section is
  // mounted. This only reacts to workspace changes, so closing the last tab still leaves
  // the section empty until the user opens another terminal or revisits the workspace.
  useEffect(() => {
    if (!workspaceId) return;
    const existing = useTerminalStore.getState().tabsByWorkspace[workspaceId];
    if (!existing || existing.length === 0) openTab(workspaceId);
  }, [workspaceId, openTab]);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
        data-testid="terminal-empty"
      >
        Select a workspace to open a terminal.
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col bg-surface-panel ${collapsed ? '' : 'h-full'}`}
      data-testid="terminal-panel"
      data-collapsed={collapsed}
    >
      {/* Compact tab bar: tabs, add terminal, and collapse/expand. */}
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b border-border-1 px-2"
        data-testid="terminal-tabs"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.length === 0 ? (
            <span className="px-1 text-xs text-fg-3">No terminals open.</span>
          ) : (
            tabs.map((tab) => {
              const active = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className={`flex shrink-0 items-center gap-1 rounded-2 px-2 py-0.5 text-xs transition-colors duration-fast ease-out ${
                    active ? 'bg-bg-4 text-fg-1' : 'text-fg-2 hover:bg-bg-3'
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
                    className="text-fg-3 hover:text-fg-1"
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
        <IconButton
          label="New terminal"
          size="sm"
          data-testid="terminal-new"
          onClick={() => openTab(workspaceId)}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </IconButton>
        <IconButton
          label={
            collapsed ? 'Expand terminal section' : 'Collapse terminal section'
          }
          size="sm"
          data-testid="terminal-collapse-toggle"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          )}
        </IconButton>
      </div>

      {/* Keep surfaces mounted while collapsed so live shells survive expansion. */}
      <div
        className={`relative min-h-0 flex-1 ${collapsed ? 'hidden' : ''}`}
        data-testid="terminal-surfaces"
      >
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-3">
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
