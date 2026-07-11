// Small pill badge — counts, PR state, harness label. Ported from components/display/Badge.jsx.

import type { HTMLAttributes } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-bg-4 text-fg-2',
  accent: 'bg-accent-muted text-accent',
  ok: 'bg-ok-muted text-ok',
  warn: 'bg-warn-muted text-warn',
  danger: 'bg-danger-muted text-danger',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  mono?: boolean;
}

export function Badge({
  tone = 'neutral',
  mono,
  className = '',
  ...rest
}: BadgeProps): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-px text-2xs font-medium leading-4 ${
        mono ? 'font-mono' : 'font-ui'
      } ${TONE_CLASS[tone]} ${className}`}
      {...rest}
    />
  );
}
