import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AppWindow,
  ChevronDown,
  Code2,
  FolderOpen,
  GitFork,
  Terminal,
} from 'lucide-react';
import type { WorkspaceOpenApp } from '@shared/ipc';
import { invoke } from '@renderer/ipc';

export interface OpenInAppMenuProps {
  workspaceId: string | null;
}

function AppIcon({ kind }: Pick<WorkspaceOpenApp, 'kind'>): React.JSX.Element {
  const className = 'h-4 w-4 shrink-0 text-fg-3';
  if (kind === 'finder')
    return <FolderOpen className={className} aria-hidden="true" />;
  if (kind === 'terminal')
    return <Terminal className={className} aria-hidden="true" />;
  if (kind === 'git')
    return <GitFork className={className} aria-hidden="true" />;
  return <Code2 className={className} aria-hidden="true" />;
}

/** Lists installed applications that can open the selected workspace checkout. */
export function OpenInAppMenu({
  workspaceId,
}: OpenInAppMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { data: applications = [], isLoading } = useQuery({
    queryKey: ['workspace-open-apps'],
    queryFn: () => invoke('workspace:listOpenApps', undefined),
    enabled: workspaceId !== null,
    staleTime: 60_000,
  });

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

  async function launch(application: WorkspaceOpenApp): Promise<void> {
    if (!workspaceId) return;
    setLaunchError(null);
    try {
      await invoke('workspace:openInApp', {
        workspaceId,
        appId: application.id,
      });
      setOpen(false);
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="flex h-[30px] items-center gap-1 rounded-2 border border-border-1 px-2 text-xs text-fg-2 transition-colors hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-45"
        aria-label="Open project in application"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={workspaceId === null}
        data-testid="open-app-menu"
        onClick={() => {
          setLaunchError(null);
          setOpen((value) => !value);
        }}
      >
        <AppWindow className="h-4 w-4" aria-hidden="true" />
        <span>Open in</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-60 rounded-3 border border-border-1 bg-surface-card p-1.5 shadow-4"
          data-testid="open-app-list"
        >
          {isLoading ? (
            <p className="px-2.5 py-2 text-xs text-fg-3">
              Detecting installed apps…
            </p>
          ) : applications.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-fg-3">
              No supported apps found.
            </p>
          ) : (
            applications.map((application, index) => (
              <button
                key={application.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-2 px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                data-testid={`open-app-${application.id}`}
                onClick={() => void launch(application)}
              >
                <AppIcon kind={application.kind} />
                <span className="min-w-0 flex-1 truncate">
                  {application.label}
                </span>
                <span className="text-xs tabular-nums text-fg-3">
                  {index + 1}
                </span>
              </button>
            ))
          )}
          {launchError ? (
            <p className="px-2.5 py-2 text-xs text-status-attention">
              {launchError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
