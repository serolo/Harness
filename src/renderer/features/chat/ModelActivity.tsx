import { useState, type ReactNode } from 'react';
import { Card } from '@renderer/components/ui';

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

  return (
    <Card data-testid="model-activity" padded={false}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-semibold text-fg-1"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        <span className="text-xs font-normal text-fg-3">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      <div className="space-y-2 text-sm text-fg-3">
        {toolNames.length > 0 ? <div>{toolNames.join(', ')}</div> : null}
        {open ? <div className="space-y-3">{children}</div> : null}
      </div>
    </Card>
  );
}
