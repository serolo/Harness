// Lazy workspace filesystem browser for the Git panel's All files tab. Directory reads
// stay in main behind the typed IPC boundary; only relative paths and entry metadata
// reach this sandboxed component.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  Link,
  ListTree,
  Search,
  X,
} from 'lucide-react';
import type { WorkspaceDirectoryEntry } from '@shared/ipc';
import { invoke } from '@renderer/ipc';

export interface WorkspaceFileTreeProps {
  workspaceId: string;
  onSelectFile: (path: string) => void;
}

type EntriesByPath = Record<string, WorkspaceDirectoryEntry[]>;

function FileGlyph({
  entry,
}: {
  entry: WorkspaceDirectoryEntry;
}): React.JSX.Element {
  if (entry.kind === 'symlink') {
    return <Link className="h-4 w-4 shrink-0 text-fg-3" aria-hidden />;
  }
  if (/\.(?:md|mdx|txt|rst)$/i.test(entry.name)) {
    return <FileText className="h-4 w-4 shrink-0 text-info" aria-hidden />;
  }
  return <FileCode2 className="h-4 w-4 shrink-0 text-fg-3" aria-hidden />;
}

export function WorkspaceFileTree({
  workspaceId,
  onSelectFile,
}: WorkspaceFileTreeProps): React.JSX.Element {
  const [entriesByPath, setEntriesByPath] = useState<EntriesByPath>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  const loadDirectory = useCallback(
    async (path: string): Promise<void> => {
      setLoading((current) => new Set(current).add(path));
      setError(null);
      try {
        const entries = await invoke('workspace:listDirectory', {
          workspaceId,
          path,
        });
        setEntriesByPath((current) => ({ ...current, [path]: entries }));
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : 'Could not list files.',
        );
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    setEntriesByPath({});
    setExpanded(new Set());
    setQuery('');
    void loadDirectory('');
  }, [loadDirectory]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = useCallback(
    (path: string): WorkspaceDirectoryEntry[] => {
      const entries = entriesByPath[path] ?? [];
      if (!normalizedQuery) return entries;
      return entries.filter((entry) => {
        if (entry.name.toLocaleLowerCase().includes(normalizedQuery))
          return true;
        if (entry.kind !== 'directory') return false;
        return (entriesByPath[entry.path] ?? []).some((child) =>
          child.name.toLocaleLowerCase().includes(normalizedQuery),
        );
      });
    },
    [entriesByPath, normalizedQuery],
  );

  const rootEntries = useMemo(() => visibleEntries(''), [visibleEntries]);

  const toggleDirectory = (path: string): void => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (entriesByPath[path] === undefined) void loadDirectory(path);
    }
    setExpanded(next);
  };

  const renderEntries = (
    entries: WorkspaceDirectoryEntry[],
    depth: number,
  ): React.JSX.Element => (
    <ul role={depth === 0 ? 'tree' : 'group'}>
      {entries.map((entry) => {
        const isDirectory = entry.kind === 'directory';
        const isExpanded = expanded.has(entry.path);
        const children = visibleEntries(entry.path);
        return (
          <li
            key={entry.path}
            role="treeitem"
            aria-expanded={isDirectory ? isExpanded : undefined}
          >
            <button
              type="button"
              aria-label={entry.name}
              title={entry.path}
              disabled={entry.kind === 'symlink'}
              onClick={() => {
                if (isDirectory) toggleDirectory(entry.path);
                else if (entry.kind === 'file') onSelectFile(entry.path);
              }}
              className="flex h-9 w-full items-center gap-2 rounded-2 pr-3 text-left text-sm text-fg-1 outline-none transition-colors duration-fast hover:bg-bg-3 focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60"
              style={{ paddingLeft: `${16 + depth * 18}px` }}
            >
              {isDirectory ? (
                <>
                  {isExpanded ? (
                    <ChevronDown
                      className="h-3.5 w-3.5 shrink-0 text-fg-3"
                      aria-hidden
                    />
                  ) : (
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-fg-3"
                      aria-hidden
                    />
                  )}
                  <Folder className="h-4 w-4 shrink-0 text-fg-2" aria-hidden />
                </>
              ) : (
                <>
                  <span className="w-3.5 shrink-0" aria-hidden />
                  <FileGlyph entry={entry} />
                </>
              )}
              <span className="min-w-0 flex-1 truncate font-mono">
                {entry.name}
              </span>
            </button>
            {isDirectory && isExpanded ? (
              loading.has(entry.path) ? (
                <p
                  className="py-2 text-xs text-fg-3"
                  style={{ paddingLeft: `${52 + depth * 18}px` }}
                >
                  Loading…
                </p>
              ) : (
                renderEntries(children, depth + 1)
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="workspace-file-tree"
    >
      <div className="flex h-10 shrink-0 items-center justify-end gap-1 border-b border-border-1 px-3">
        {searchOpen ? (
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2 bg-bg-3 px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />
            <span className="sr-only">Filter files</span>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter files"
              className="h-7 min-w-0 flex-1 bg-transparent text-xs text-fg-1 outline-none placeholder:text-fg-3"
            />
            <button
              type="button"
              aria-label="Close file search"
              onClick={() => {
                setQuery('');
                setSearchOpen(false);
              }}
            >
              <X className="h-3.5 w-3.5 text-fg-3" aria-hidden />
            </button>
          </label>
        ) : null}
        <button
          type="button"
          aria-label="Collapse all folders"
          title="Collapse all folders"
          onClick={() => setExpanded(new Set())}
          className="rounded-2 p-1.5 text-fg-3 hover:bg-bg-3 hover:text-fg-1"
        >
          <ListTree className="h-4 w-4" aria-hidden />
        </button>
        {!searchOpen ? (
          <button
            type="button"
            aria-label="Search files"
            title="Search files"
            onClick={() => setSearchOpen(true)}
            className="rounded-2 p-1.5 text-fg-3 hover:bg-bg-3 hover:text-fg-1"
          >
            <Search className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {loading.has('') ? (
          <p className="p-5 text-sm text-fg-3">Loading files…</p>
        ) : error ? (
          <div className="p-5 text-sm text-danger">
            <p>{error}</p>
            <button
              type="button"
              className="mt-2 text-xs underline"
              onClick={() => void loadDirectory('')}
            >
              Try again
            </button>
          </div>
        ) : rootEntries.length === 0 ? (
          <p className="p-5 text-sm text-fg-3">
            {normalizedQuery
              ? 'No matching files.'
              : 'This workspace is empty.'}
          </p>
        ) : (
          renderEntries(rootEntries, 0)
        )}
      </div>
    </div>
  );
}
