// Compact disclosure for intermediate model messages and their tool activity.
// The latest model message stays outside this component so the transcript's answer
// remains readable without expanding implementation details.

import { useState, type ReactNode } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import { ToolIcon } from './ToolCard';

export interface ModelActivityProps {
  messageCount: number;
  toolCount: number;
  toolNames?: string[];
  children: ReactNode;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function ModelActivity({
  messageCount,
  toolCount,
  toolNames = [],
  children,
}: ModelActivityProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const labels = [
    toolCount > 0 ? countLabel(toolCount, 'tool call') : null,
    countLabel(messageCount, 'message'),
  ].filter((label): label is string => label !== null);
  const uniqueToolNames = [...new Set(toolNames)].slice(0, 5);

  return (
    <div data-testid="model-activity">
      <button
        type="button"
        className="group flex min-h-7 max-w-full items-center gap-2 rounded-2 px-1.5 text-left text-xs text-fg-2 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-fast ease-out ${open ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <span className="truncate font-medium">{labels.join(', ')}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-fg-3">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          {uniqueToolNames.map((name) => (
            <ToolIcon key={name} name={name} className="h-3.5 w-3.5" />
          ))}
        </span>
      </button>
      {open && (
        <div
          className="mt-3 space-y-3 border-l border-border-1 pl-5"
          data-testid="model-activity-content"
        >
          {children}
        </div>
      )}
    </div>
  );
}
