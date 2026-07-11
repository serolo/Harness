// Harness design-system Button — src/renderer/components/ui/* are the shared UI
// primitives ported from the Claude Design "harness-app" kit (see components/core/Button.jsx
// there). Re-authored as className-based TSX (this repo's convention) instead of the
// source kit's inline `style` objects — same visual spec, different mechanism.

import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'bg-bg-3 text-fg-1 border border-border-2 hover:bg-bg-4',
  ghost: 'bg-transparent text-fg-2 hover:bg-bg-3 hover:text-fg-1',
  danger: 'bg-danger text-white hover:bg-danger-hover',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-control text-2xs px-2.5',
  md: 'h-control text-sm px-2.5',
  lg: 'h-control-lg text-base px-3.5',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

/** Harness button. variant: primary | secondary | ghost | danger; size: sm | md | lg. */
export function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-2 font-medium transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...rest}
    />
  );
}
