import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function ModelActivity({
  messageCount,
  toolCount,
  toolNames,
  children,
}: {
  messageCount: number;
  toolCount: number;
  toolNames: string[];
  children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const toolLabel = `${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}`;
  const messageLabel = `${messageCount} ${
    messageCount === 1 ? 'message' : 'messages'
  }`;
  const label = `${toolLabel}, ${messageLabel}`;
  const toolsPreview = Array.from(new Set(toolNames)).join(', ');

  return (
    <div className="min-w-0" data-testid="model-activity">
      <button
        type="button"
        className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-2 px-1.5 text-left text-sm text-fg-2 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-fg-3" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-fg-3" />
        )}
        <span className="shrink-0 font-medium text-fg-1">{label}</span>
        {toolsPreview ? (
          <span className="min-w-0 truncate text-xs text-fg-3">
            {toolsPreview}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="ml-3 mt-2 space-y-3 border-l border-border-1 pl-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}
