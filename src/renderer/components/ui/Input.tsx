// Single-line text input — ported from components/core/Input.jsx. `mono` renders the
// value in --font-mono (paths, branches).

import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
}

export function Input({
  mono,
  invalid,
  className = '',
  ...rest
}: InputProps): React.JSX.Element {
  return (
    <input
      className={`h-control box-border rounded-2 border bg-surface-well px-2.5 text-fg-1 outline-none transition-[border-color,box-shadow] duration-fast ease-out focus:shadow-[0_0_0_2px_var(--focus-ring)] ${
        mono ? 'font-mono text-sm' : 'font-ui text-base'
      } ${invalid ? 'border-danger' : 'border-border-2 focus:border-accent-border'} ${className}`}
      {...rest}
    />
  );
}
