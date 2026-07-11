// Multiline text area — ported from components/core/Textarea.jsx. Chat composer, PR
// descriptions, settings scripts.

import type { TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export function Textarea({
  mono,
  rows = 3,
  className = '',
  ...rest
}: TextareaProps): React.JSX.Element {
  return (
    <textarea
      rows={rows}
      className={`box-border resize-y rounded-2 border border-border-2 bg-surface-well px-2.5 py-2 leading-normal text-fg-1 outline-none transition-[border-color,box-shadow] duration-fast ease-out focus:border-accent-border focus:shadow-[0_0_0_2px_var(--focus-ring)] ${
        mono ? 'font-mono text-sm' : 'font-ui text-base'
      } ${className}`}
      {...rest}
    />
  );
}
