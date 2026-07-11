// FileTree — the `DiffSet.files` list: an A/M/D/R change badge + `+adds/-dels` stats
// per file, click to select. Dense-row list styling shared with the sidebar's workspace
// list (`data-testid` hooks, active-row highlight); the +adds/-dels stats and the A/D
// badges use the `diff-add-accent`/`diff-del-accent` tokens (the diff-colors spec).

import type { DiffFileEntry } from '@shared/review';

export interface FileTreeProps {
  files: DiffFileEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

/** Badge glyph + color per change kind (spec's A/M/D/R convention). Added/deleted map to
 * the diff-colors spec's add/del accents; modified/renamed use the warn/info semantics. */
const CHANGE_BADGE: Record<
  DiffFileEntry['change'],
  { label: string; className: string }
> = {
  added: { label: 'A', className: 'text-diff-add-accent' },
  modified: { label: 'M', className: 'text-warn' },
  deleted: { label: 'D', className: 'text-diff-del-accent' },
  renamed: { label: 'R', className: 'text-info' },
};

export function FileTree({
  files,
  selectedPath,
  onSelect,
}: FileTreeProps): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto" data-testid="diff-file-tree">
      {files.length === 0 ? (
        <p className="p-3 text-xs text-fg-3">No changed files.</p>
      ) : (
        <ul>
          {files.map((f) => {
            const badge = CHANGE_BADGE[f.change];
            const active = f.path === selectedPath;
            return (
              <li key={f.path}>
                <button
                  type="button"
                  data-testid={`diff-file-${f.path}`}
                  aria-pressed={active}
                  onClick={() => onSelect(f.path)}
                  className={`flex w-full items-center gap-2 border-b border-border-1 px-2 py-1.5 text-left text-xs transition-colors duration-fast ease-out ${
                    active ? 'bg-bg-4 text-fg-1' : 'text-fg-2 hover:bg-bg-3'
                  }`}
                  title={f.path}
                >
                  <span
                    className={`w-3 shrink-0 font-mono font-semibold ${badge.className}`}
                    aria-hidden="true"
                  >
                    {badge.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {f.path}
                  </span>
                  <span
                    className="shrink-0 font-mono text-xs"
                    aria-hidden="true"
                  >
                    <span className="text-diff-add-accent">+{f.additions}</span>{' '}
                    <span className="text-diff-del-accent">-{f.deletions}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
