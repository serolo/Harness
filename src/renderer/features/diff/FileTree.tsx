// FileTree — the `DiffSet.files` list: an A/M/D/R change badge + `+adds/-dels` stats
// per file, click to select. Mirrors the slate-palette list styling used by the
// sidebar's workspace list (dense rows, `data-testid` hooks, active-row highlight).

import type { DiffFileEntry } from '@shared/review';

export interface FileTreeProps {
  files: DiffFileEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

/** Badge glyph + color per change kind (spec's A/M/D/R convention). */
const CHANGE_BADGE: Record<
  DiffFileEntry['change'],
  { label: string; className: string }
> = {
  added: { label: 'A', className: 'text-emerald-400' },
  modified: { label: 'M', className: 'text-amber-400' },
  deleted: { label: 'D', className: 'text-red-400' },
  renamed: { label: 'R', className: 'text-sky-400' },
};

export function FileTree({
  files,
  selectedPath,
  onSelect,
}: FileTreeProps): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto" data-testid="diff-file-tree">
      {files.length === 0 ? (
        <p className="p-3 text-xs text-slate-600">No changed files.</p>
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
                  className={`flex w-full items-center gap-2 border-b border-slate-800/60 px-2 py-1.5 text-left text-xs transition-colors ${
                    active
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-300 hover:bg-slate-800/50'
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
                    className="shrink-0 font-mono text-[11px]"
                    aria-hidden="true"
                  >
                    <span className="text-emerald-500">+{f.additions}</span>{' '}
                    <span className="text-red-500">-{f.deletions}</span>
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
