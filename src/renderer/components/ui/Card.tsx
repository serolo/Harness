// Surface card: bg-3 fill, hairline border, radius 8 — ported from components/display/Card.jsx.

import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'title'
> {
  title?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
}

export function Card({
  title,
  actions,
  padded = true,
  children,
  className = '',
  ...rest
}: CardProps): React.JSX.Element {
  return (
    <div
      className={`overflow-hidden rounded-3 border border-border-1 bg-surface-card ${className}`}
      {...rest}
    >
      {title ? (
        <div className="flex items-center justify-between gap-2 border-b border-border-1 px-3 py-2">
          <span className="text-sm font-semibold text-fg-1">{title}</span>
          {actions}
        </div>
      ) : null}
      <div className={padded ? 'p-3' : ''}>{children}</div>
    </div>
  );
}
