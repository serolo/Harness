// TerminalTab — the xterm surface for one open terminal tab. All tabs stay mounted so
// their shells survive tab switches; the inactive ones are hidden (not unmounted) and the
// active one fills the pane. `useTerminal` owns the xterm lifecycle for this tab.

import { useRef } from 'react';
import { useTerminal } from './useTerminal';

export interface TerminalTabProps {
  workspaceId: string;
  tabId: string;
  active: boolean;
}

export function TerminalTab({
  workspaceId,
  tabId,
  active,
}: TerminalTabProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  useTerminal(workspaceId, tabId, containerRef);
  return (
    <div
      ref={containerRef}
      data-testid="terminal-surface"
      data-active={active}
      className={`absolute inset-0 overflow-hidden bg-slate-950 p-1 ${
        active ? '' : 'hidden'
      }`}
    />
  );
}
