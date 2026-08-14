import type { ReactNode } from 'react';

export interface PanelTabBarProps {
  label: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  testId?: string;
}

/** Shared tab header for the stacked Git, workspace-tools, and Terminal panels. */
export function PanelTabBar({
  label,
  children,
  actions,
  className = '',
  testId,
}: PanelTabBarProps): React.JSX.Element {
  return (
    <div
      className={`flex h-12 shrink-0 items-center gap-2 border-b border-border-1 bg-surface-panel px-3 ${className}`}
      data-testid={testId}
      data-ui="panel-tab-bar"
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        role="tablist"
        aria-label={label}
      >
        {children}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}

export interface PanelTabProps {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
  testId?: string;
  onClose?: () => void;
  closeLabel?: string;
  closeTestId?: string;
}

/** One consistently styled panel tab, optionally with a neighboring close affordance. */
export function PanelTab({
  active,
  children,
  onClick,
  testId,
  onClose,
  closeLabel,
  closeTestId,
}: PanelTabProps): React.JSX.Element {
  return (
    <div
      className={`flex h-8 shrink-0 items-center rounded-3 transition-colors duration-fast ease-out ${
        active ? 'bg-bg-3 text-fg-1' : 'text-fg-3 hover:bg-bg-3 hover:text-fg-1'
      }`}
      data-ui="panel-tab"
      data-active={active}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-pressed={active}
        className={`h-full whitespace-nowrap px-3 text-xs font-medium ${onClose ? 'pr-1.5' : ''}`}
        data-testid={testId}
        onClick={onClick}
      >
        {children}
      </button>
      {onClose ? (
        <button
          type="button"
          className="mr-1 flex h-5 w-5 items-center justify-center rounded-1 text-sm leading-none text-fg-3 hover:bg-bg-4 hover:text-fg-1"
          aria-label={closeLabel ?? 'Close tab'}
          data-testid={closeTestId}
          onClick={onClose}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
