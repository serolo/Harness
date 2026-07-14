import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Check,
  ChevronRight,
  CircleDashed,
  Link,
  Mail,
  MailOpen,
  Pencil,
  Pin,
  PinOff,
} from 'lucide-react';
import type { Workspace, WorkspaceStatus } from '@shared/models';

interface Point {
  x: number;
  y: number;
}

export interface WorkspaceContextMenuProps {
  workspace: Workspace;
  point: Point;
  onClose: () => void;
  onToggleUnread: () => void;
  onTogglePin: () => void;
  onSetStatus: (status: WorkspaceStatus) => void;
  onRename: () => void;
  onCopyLink: () => void;
  onArchive: () => void;
}

const STATUS_OPTIONS: Array<{
  status: Exclude<WorkspaceStatus, 'archived'>;
  label: string;
  dotClass: string;
}> = [
  { status: 'idle', label: 'Ready', dotClass: 'bg-status-idle' },
  { status: 'working', label: 'Working', dotClass: 'bg-status-working' },
  {
    status: 'needs_attention',
    label: 'Needs attention',
    dotClass: 'bg-status-attention',
  },
  { status: 'running', label: 'Running', dotClass: 'bg-status-running' },
];

const MENU_ITEM =
  'flex w-full items-center gap-3 rounded-2 px-3 py-2 text-left text-sm text-fg-1 outline-none transition-colors hover:bg-bg-4 focus:bg-bg-4';

/** Screenshot-matched right-click menu for one live workspace. */
export function WorkspaceContextMenu({
  workspace,
  point,
  onClose,
  onToggleUnread,
  onTogglePin,
  onSetStatus,
  onRename,
  onCopyLink,
  onArchive,
}: WorkspaceContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(point);
  const [statusOpen, setStatusOpen] = useState(false);
  const submenuOnLeft = point.x > window.innerWidth - 520;

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    setPosition({
      x: Math.max(
        margin,
        Math.min(point.x, window.innerWidth - rect.width - margin),
      ),
      y: Math.max(
        margin,
        Math.min(point.y, window.innerHeight - rect.height - margin),
      ),
    });
  }, [point]);

  useEffect(() => {
    const closeOnPointer = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') return onClose();
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        onToggleUnread();
        onClose();
      } else if (event.key.toLowerCase() === 'p') {
        event.preventDefault();
        onTogglePin();
        onClose();
      }
    };
    document.addEventListener('mousedown', closeOnPointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', closeOnPointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, onTogglePin, onToggleUnread]);

  function run(action: () => void): void {
    onClose();
    action();
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Workspace actions for ${workspace.name}`}
      data-testid="workspace-context-menu"
      className="fixed z-50 w-72 rounded-4 border border-border-2 bg-surface-overlay p-1.5 shadow-4"
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        data-testid="workspace-menu-unread"
        onClick={() => run(onToggleUnread)}
      >
        {workspace.isUnread ? (
          <MailOpen className="h-5 w-5 text-fg-2" aria-hidden="true" />
        ) : (
          <Mail className="h-5 w-5 text-fg-2" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          {workspace.isUnread ? 'Mark as read' : 'Mark as unread'}
        </span>
        <span className="text-xs text-fg-3">R</span>
      </button>

      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        data-testid="workspace-menu-pin"
        onClick={() => run(onTogglePin)}
      >
        {workspace.isPinned ? (
          <PinOff className="h-5 w-5 text-fg-2" aria-hidden="true" />
        ) : (
          <Pin className="h-5 w-5 text-fg-2" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          {workspace.isPinned ? 'Unpin' : 'Pin'}
        </span>
        <span className="text-xs text-fg-3">P</span>
      </button>

      <div
        className="relative"
        onMouseEnter={() => setStatusOpen(true)}
        onMouseLeave={() => setStatusOpen(false)}
      >
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={statusOpen}
          className={MENU_ITEM}
          data-testid="workspace-menu-status"
          onClick={() => setStatusOpen((open) => !open)}
        >
          <CircleDashed className="h-5 w-5 text-fg-2" aria-hidden="true" />
          <span className="min-w-0 flex-1">Set status</span>
          <ChevronRight className="h-4 w-4 text-fg-3" aria-hidden="true" />
        </button>

        {statusOpen ? (
          <div
            role="menu"
            data-testid="workspace-status-submenu"
            className={`absolute top-0 w-52 rounded-3 border border-border-2 bg-surface-overlay p-1.5 shadow-4 ${
              submenuOnLeft ? 'right-[calc(100%-4px)]' : 'left-[calc(100%-4px)]'
            }`}
          >
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.status}
                type="button"
                role="menuitemradio"
                aria-checked={workspace.status === option.status}
                className={MENU_ITEM}
                data-testid={`workspace-status-${option.status}`}
                onClick={() =>
                  run(() => onSetStatus(option.status as WorkspaceStatus))
                }
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${option.dotClass}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">{option.label}</span>
                {workspace.status === option.status ? (
                  <Check className="h-4 w-4 text-accent" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        data-testid="workspace-menu-rename"
        onClick={() => run(onRename)}
      >
        <Pencil className="h-5 w-5 text-fg-2" aria-hidden="true" />
        <span>Rename</span>
      </button>

      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        data-testid="workspace-menu-copy-link"
        onClick={() => run(onCopyLink)}
      >
        <Link className="h-5 w-5 text-fg-2" aria-hidden="true" />
        <span>Copy link</span>
      </button>

      <div className="my-1 border-t border-border-1" role="separator" />

      <button
        type="button"
        role="menuitem"
        className={`${MENU_ITEM} text-fg-2 hover:text-fg-1`}
        data-testid="workspace-menu-archive"
        onClick={() => run(onArchive)}
      >
        <Archive className="h-5 w-5 text-fg-2" aria-hidden="true" />
        <span className="min-w-0 flex-1">Archive</span>
        <span className="text-xs text-fg-3">⌘⇧A</span>
      </button>
    </div>,
    document.body,
  );
}
