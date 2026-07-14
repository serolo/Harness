// FileTree — the `DiffSet.files` overview: full paths, line stats, and a compact status
// glyph. Clicking a row opens the file review surface.

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
  added: {
    label: '+',
    className: 'border-diff-add-accent text-diff-add-accent',
  },
  modified: { label: '•', className: 'border-warn text-warn' },
  deleted: {
    label: '−',
    className: 'border-diff-del-accent text-diff-del-accent',
  },
  renamed: { label: '↗', className: 'border-info text-info' },
};

function PathLabel({ path }: { path: string }): React.JSX.Element {
  const splitAt = path.lastIndexOf('/') + 1;
  return (
    <span className="min-w-0 flex-1 truncate">
      <span className="text-fg-3">{path.slice(0, splitAt)}</span>
      <span className="text-fg-1">{path.slice(splitAt)}</span>
    </span>
  );
}

export function FileTree({
  files,
  selectedPath,
  onSelect,
}: FileTreeProps): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto" data-testid="diff-file-tree">
      {files.length === 0 ? (
        <p className="p-5 text-sm text-fg-3">No changed files.</p>
      ) : (
        <ul className="py-2">
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
                  className={`flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors duration-fast ease-out ${
                    active ? 'bg-bg-4' : 'hover:bg-bg-3'
                  }`}
                  title={f.path}
                >
                  <PathLabel path={f.path} />
                  <span
                    className="shrink-0 font-mono text-xs tabular-nums"
                    aria-hidden="true"
                  >
                    {f.additions > 0 ? (
                      <span className="text-diff-add-accent">
                        +{f.additions}
                      </span>
                    ) : null}{' '}
                    {f.deletions > 0 ? (
                      <span className="text-diff-del-accent">
                        -{f.deletions}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border font-mono text-[10px] font-semibold leading-none ${badge.className}`}
                    aria-label={f.change}
                  >
                    {badge.label}
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
