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
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

/** Fixed scrim + centered panel. radius-4, shadow-4, fade+rise entrance. */
export function Dialog({
  title,
  width = 460,
  onClose,
  footer,
  children,
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
        style={{ width, maxWidth: '90vw', maxHeight: '85vh' }}
        className="flex animate-[hn-rise_280ms_var(--ease-out)] flex-col overflow-hidden rounded-4 border border-border-1 bg-surface-overlay shadow-4"
      >
        {title ? (
          <div className="px-4 pt-3.5 text-md font-semibold text-fg-1">
            {title}
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-border-1 px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
