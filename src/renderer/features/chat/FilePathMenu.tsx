import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, FolderOpen } from 'lucide-react';
import { FileReferencePill } from './FileReferencePill';

export interface FilePathMenuProps {
  path: string;
  onOpenInFinder: () => Promise<void>;
  onCopyPath: (format: 'absolute' | 'relative') => Promise<void>;
}

/** Filename action menu for a file already validated and displayed by the chat viewer. */
export function FilePathMenu({
  path,
  onOpenInFinder,
  onCopyPath,
}: FilePathMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const runAction = (
    action: () => Promise<void>,
    successMessage?: string,
  ): void => {
    setMessage(null);
    setError(null);
    void action()
      .then(() => {
        setOpen(false);
        if (successMessage) setMessage(successMessage);
      })
      .catch((reason: unknown) => {
        setOpen(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <div className="relative min-w-0" ref={rootRef}>
      <div className="flex min-w-0 items-center gap-1">
        <FileReferencePill
          path={path}
          label={path}
          onOpenFile={() => runAction(onOpenInFinder)}
          actionLabel={`Reveal ${path} in file manager`}
        />
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-2 border border-border-2 bg-bg-3 text-fg-3 transition-colors hover:border-accent hover:bg-bg-4 hover:text-fg-1"
          aria-label={`File actions for ${path}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setError(null);
            setMessage(null);
            setOpen((current) => !current);
          }}
        >
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {open ? (
        <div
          role="menu"
          className="absolute z-50 mt-1 w-56 overflow-hidden rounded-3 border border-border-1 bg-surface-overlay p-1.5 shadow-4"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-2 px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
            onClick={() => runAction(onOpenInFinder)}
          >
            <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
            Open in Finder
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-2 px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
            onClick={() =>
              runAction(() => onCopyPath('absolute'), 'Copied absolute path')
            }
          >
            <Copy className="h-4 w-4 shrink-0" aria-hidden="true" />
            Copy absolute path
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-2 px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
            onClick={() =>
              runAction(() => onCopyPath('relative'), 'Copied relative path')
            }
          >
            <Copy className="h-4 w-4 shrink-0" aria-hidden="true" />
            Copy relative path
          </button>
        </div>
      ) : null}

      {message ? (
        <p className="mt-1 truncate text-xs text-fg-3" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="mt-1 truncate text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
