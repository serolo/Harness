import { useState } from 'react';
import { ChevronDown, ShieldAlert } from 'lucide-react';

export interface PermissionCardProps {
  title?: string;
  description?: string;
  toolName?: string;
  input?: unknown;
}

function formatInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** A safety-sensitive approval prompt; it never masquerades as a normal model question. */
export function PermissionCard({
  title,
  description,
  toolName,
  input,
}: PermissionCardProps): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasDetails = input !== undefined;

  return (
    <section
      className="overflow-hidden rounded-4 border border-warn bg-warn-muted"
      data-testid="permission-card"
      aria-label="Permission requested by the agent"
    >
      <div className="flex gap-3 px-5 py-4">
        <div className="mt-0.5 rounded-2 bg-warn-muted p-2 text-warn">
          <ShieldAlert className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg-1">
            {title ?? 'Permission requested'}
          </div>
          <p className="mt-1 text-sm leading-6 text-fg-2">
            {description ??
              'The agent needs approval before it can continue with this action.'}
          </p>
          {toolName ? (
            <div className="mt-3 inline-flex rounded-2 border border-border-2 bg-surface-panel px-2.5 py-1 font-mono text-xs text-fg-2">
              {toolName}
            </div>
          ) : null}
        </div>
      </div>
      {hasDetails ? (
        <div className="border-t border-warn">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-xs font-medium text-fg-2 hover:bg-warn-muted"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${detailsOpen ? 'rotate-180' : ''}`}
              aria-hidden
            />
            Review requested action
          </button>
          {detailsOpen ? (
            <pre className="max-h-64 overflow-auto border-t border-warn bg-surface-well p-4 font-mono text-xs leading-5 text-fg-2">
              <code>{formatInput(input)}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
