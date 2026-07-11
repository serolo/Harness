// Square icon-only button — ported from components/core/IconButton.jsx in the design kit.

import type { ButtonHTMLAttributes } from 'react';

export type IconButtonSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<IconButtonSize, string> = {
  sm: 'h-[22px] w-[22px]',
  md: 'h-[26px] w-[26px]',
  lg: 'h-[30px] w-[30px]',
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: IconButtonSize;
  /** Accessible label — also used as the native tooltip (`title`). Required: icon-only buttons have no visible text. */
  label: string;
  active?: boolean;
}

/** Square icon-only button. Pass a Lucide icon (or any glyph) as children. */
export function IconButton({
  size = 'md',
  label,
  active,
  className = '',
  type = 'button',
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center rounded-2 transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-45 ${
        active ? 'bg-bg-4 text-fg-1' : 'text-fg-2 hover:bg-bg-3 hover:text-fg-1'
      } ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    />
  );
}
