// Modal dialog on scrim — ported from components/overlay/Dialog.jsx. Matches the plain-
// `<div>` overlay pattern already used by SettingsPanel/NewWorkspaceDialog (this repo has
// no @radix-ui/react-dialog dependency; don't add one).

import type { HTMLAttributes, ReactNode } from 'react';

export interface DialogProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'title'
> {
  title?: ReactNode;
  /** Panel width in px. Defaults to the design system's 460px dialog width. */
  width?: number;
  /** Fill the entire application viewport instead of rendering a centered dialog. */
  fullScreen?: boolean;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  /** Optional body classes for full-height layouts that own their internal scrolling. */
  contentClassName?: string;
}

/** Fixed scrim + centered panel. radius-4, shadow-4, fade+rise entrance. */
export function Dialog({
  title,
  width = 460,
  fullScreen = false,
  onClose,
  footer,
  children,
  contentClassName = '',
  className = '',
  ...rest
}: DialogProps): React.JSX.Element {
  return (
    <div
      className={`fixed inset-0 z-40 flex animate-[hn-fade_180ms_var(--ease-out)] items-center justify-center bg-scrim ${className}`}
      onClick={onClose}
      {...rest}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={
          fullScreen
            ? { width: '100%', height: '100%' }
            : { width, maxWidth: '90vw', maxHeight: '85vh' }
        }
        className={`flex animate-[hn-rise_280ms_var(--ease-out)] flex-col overflow-hidden bg-surface-overlay ${
          fullScreen
            ? 'h-full w-full'
            : 'rounded-4 border border-border-1 shadow-4'
        }`}
      >
        {title ? (
          <div className="px-4 pt-3.5 text-md font-semibold text-fg-1">
            {title}
          </div>
        ) : null}
        <div
          className={`min-h-0 flex-1 ${
            contentClassName || 'overflow-y-auto p-4'
          }`}
        >
          {children}
        </div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-border-1 px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
