// CommitFilter — a `base..HEAD` selector built from `diff:commits`, scoping the diff.
// Selecting a commit sets the diff store's commit filter and re-fetches `diff:get`;
// `diff:get` currently ignores the explicit ref (the UI + store are wired ahead of the
// backend catching up, per the plan's Task-10 note).

import type { CommitInfo } from '@shared/review';

export interface CommitFilterProps {
  commits: CommitInfo[];
  value: string | null;
  onChange: (sha: string | null) => void;
}

export function CommitFilter({
  commits,
  value,
  onChange,
}: CommitFilterProps): React.JSX.Element {
  return (
    <select
      className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-slate-500 focus:outline-none"
      data-testid="commit-filter"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value="">All changes (base..HEAD)</option>
      {commits.map((c) => (
        <option key={c.sha} value={c.sha}>
          {c.shortSha} {c.subject}
        </option>
      ))}
    </select>
  );
}
