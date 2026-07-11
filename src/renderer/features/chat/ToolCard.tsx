// Collapsible card for a tool_use / tool_result AgentEvent.

import { useState } from 'react';

export interface ToolCardProps {
  /** 'use' for a tool_use event, 'result' for a tool_result event. */
  variant: 'use' | 'result';
  /** Tool name (tool_use only). */
  name?: string;
  /** Raw input (tool_use) or output (tool_result); rendered as pretty JSON. */
  payload: unknown;
}

/** Best-effort pretty-print of an unknown payload (string passthrough, else JSON). */
function formatPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function ToolCard({
  variant,
  name,
  payload,
}: ToolCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const title = variant === 'use' ? (name ?? 'tool') : 'tool result';
  const body = formatPayload(payload);

  return (
    <div
      className="my-1 rounded-3 border border-border-1 bg-surface-card"
      data-testid="tool-card"
      data-variant={variant}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-fg-2 hover:bg-bg-3"
        aria-expanded={open}
      >
        <span className="text-fg-3">{open ? '▾' : '▸'}</span>
        <span className="font-medium">
          {variant === 'use' ? '🔧 ' : '↩ '}
          {title}
        </span>
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-border-1 p-2 font-mono text-xs text-fg-2">
          <code>{body}</code>
        </pre>
      )}
    </div>
  );
}
