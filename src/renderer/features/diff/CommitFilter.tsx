// Git changes overflow menu: target branch, change scope, and latest commit.

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, EllipsisVertical } from 'lucide-react';
import type { DiffMenuInfo, DiffScope } from '@shared/review';
import { IconButton } from '@renderer/components/ui';

export interface CommitFilterProps {
  info: DiffMenuInfo | null;
  scope: DiffScope;
  onTargetRefChange: (targetRef: string) => Promise<void>;
  onScopeChange: (scope: DiffScope) => void;
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function CommitFilter({
  info,
  scope,
  onTargetRefChange,
  onScopeChange,
}: CommitFilterProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const chooseScope = (next: DiffScope): void => {
    onScopeChange(next);
    setOpen(false);
  };

  const chooseTarget = (targetRef: string): void => {
    void onTargetRefChange(targetRef)
      .then(() => setOpen(false))
      .catch(() => {
        /* Keep the menu open so the user can retry another available branch. */
      });
  };

  const latestCommit = info?.commits[0] ?? null;

  return (
    <div className="relative" ref={rootRef}>
      <IconButton
        label="More Git actions"
        size="md"
        active={open}
        data-testid="git-more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setBranchesOpen(false);
          setOpen((current) => !current);
        }}
      >
        <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
      </IconButton>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-4 border border-border-1 bg-surface-overlay shadow-4"
          data-testid="commit-filter-menu"
        >
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-bg-3"
            data-testid="git-target-branch"
            aria-expanded={branchesOpen}
            onClick={() => setBranchesOpen((current) => !current)}
          >
            <span className="shrink-0 text-fg-3">Target branch</span>
            <span className="ml-auto min-w-0 truncate font-medium text-fg-1">
              {info?.targetRef ?? 'Loading…'}
            </span>
            {branchesOpen ? (
              <ChevronUp className="h-4 w-4 shrink-0 text-fg-3" />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0 text-fg-3" />
            )}
          </button>

          {branchesOpen ? (
            <div className="max-h-44 overflow-y-auto border-t border-border-1 py-1">
              {(info?.branches ?? []).map((branch) => (
                <button
                  key={branch}
                  type="button"
                  role="menuitemradio"
                  aria-checked={branch === info?.targetRef}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                  data-testid={`git-target-option-${branch}`}
                  onClick={() => chooseTarget(branch)}
                >
                  <span className="min-w-0 flex-1 truncate">{branch}</span>
                  {branch === info?.targetRef ? (
                    <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          <div className="border-t border-border-1 p-2">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={scope.kind === 'all'}
              className={`flex w-full items-center rounded-3 px-3 py-2.5 text-left text-sm font-medium text-fg-1 ${
                scope.kind === 'all' ? 'bg-bg-4' : 'hover:bg-bg-3'
              }`}
              data-testid="git-scope-all"
              onClick={() => chooseScope({ kind: 'all' })}
            >
              All changes
              {scope.kind === 'all' ? (
                <Check className="ml-auto h-4 w-4" aria-hidden="true" />
              ) : null}
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={scope.kind === 'uncommitted'}
              className={`mt-1 flex w-full items-center rounded-3 px-3 py-2.5 text-left hover:bg-bg-3 ${
                scope.kind === 'uncommitted' ? 'bg-bg-4' : ''
              }`}
              data-testid="git-scope-uncommitted"
              onClick={() => chooseScope({ kind: 'uncommitted' })}
            >
              <span>
                <span className="block text-sm font-medium text-fg-1">
                  Uncommitted changes
                </span>
                <span className="mt-0.5 block text-xs text-fg-3">
                  {info?.uncommittedFileCount ?? 0}{' '}
                  {(info?.uncommittedFileCount ?? 0) === 1 ? 'file' : 'files'}{' '}
                  changed
                </span>
              </span>
              {scope.kind === 'uncommitted' ? (
                <Check
                  className="ml-auto h-4 w-4 text-fg-2"
                  aria-hidden="true"
                />
              ) : (
                <span className="ml-auto text-xs text-fg-3">⌥U</span>
              )}
            </button>
          </div>

          {latestCommit ? (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={
                scope.kind === 'commit' && scope.sha === latestCommit.sha
              }
              className={`flex w-full items-center border-t border-border-1 px-4 py-3 text-left hover:bg-bg-3 ${
                scope.kind === 'commit' && scope.sha === latestCommit.sha
                  ? 'bg-bg-4'
                  : ''
              }`}
              data-testid={`git-scope-commit-${latestCommit.sha}`}
              onClick={() =>
                chooseScope({ kind: 'commit', sha: latestCommit.sha })
              }
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg-1">
                  {latestCommit.subject}
                </span>
                <span className="mt-0.5 block truncate text-xs text-fg-3">
                  {latestCommit.shortSha} · {latestCommit.author} ·{' '}
                  {relativeTime(latestCommit.date)}
                </span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
