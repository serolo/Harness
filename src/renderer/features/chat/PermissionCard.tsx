import { useState } from 'react';
import { Card } from '@renderer/components/ui';

export interface PermissionCardProps {
  title?: string;
  description?: string;
  toolName?: string;
  input?: unknown;
}

export function PermissionCard({
  title,
  description,
  toolName,
  input,
}: PermissionCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <Card
      data-testid="permission-card"
      title={title ?? 'Permission requested'}
      actions={
        <button
          type="button"
          className="text-xs text-fg-3 hover:text-fg-1"
          onClick={() => setOpen((value) => !value)}
        >
          Review requested action
        </button>
      }
    >
      <div className="space-y-2 text-sm text-fg-2">
        {description ? <p>{description}</p> : null}
        {toolName ? <p className="text-xs text-fg-3">{toolName}</p> : null}
        {open ? (
          <pre className="max-h-48 overflow-auto rounded-2 bg-bg-2 p-2 text-xs text-fg-2">
            {JSON.stringify(input, null, 2)}
          </pre>
        ) : null}
      </div>
    </Card>
  );
}
