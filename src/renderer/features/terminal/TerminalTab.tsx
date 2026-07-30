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
      data-testid="terminal-surface"
      data-active={active}
      className={`terminal-surface absolute inset-0 overflow-hidden border-0 bg-[var(--terminal-bg)] p-2 pb-6 outline-none ${
        active ? '' : 'hidden'
      }`}
    >
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden bg-[var(--terminal-bg)] [&_.xterm-helper-textarea]:outline-none [&_.xterm-screen]:border-0 [&_.xterm-viewport]:border-0 [&_.xterm]:border-0 [&_.xterm]:outline-none [&_.xterm]:shadow-none"
      />
    </div>
  );
}
