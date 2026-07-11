// CommitFilter — a `base..HEAD` selector built from `diff:commits`, scoping the diff.
// Selecting a commit sets the diff store's commit filter and re-fetches `diff:get`;
// `diff:get` currently ignores the explicit ref (the UI + store are wired ahead of the
// backend catching up, per the plan's Task-10 note).

import { Select } from '@renderer/components/ui';
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
  const options = [
    { value: '', label: 'All changes (base..HEAD)' },
    ...commits.map((c) => ({
      value: c.sha,
      label: `${c.shortSha} ${c.subject}`,
    })),
  ];
  return (
    <Select
      data-testid="commit-filter"
      options={options}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    />
  );
}
