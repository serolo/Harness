// PrCard — the pull-request summary block in the Checks panel. Renders the PR
// number/title/draft badge/mergeable state from the `pr` check's details. The PR link
// opens EXTERNALLY via a plain anchor (`target="_blank" rel="noreferrer"`) — the renderer
// is sandboxed and must NOT import electron's `shell`; this mirrors how chat markdown
// links open (`src/renderer/features/chat/markdown.tsx`).

import type { CheckDetails } from '@shared/checks';

/** The `pr`-source variant of the `CheckDetails` union. */
type PrDetails = Extract<CheckDetails, { source: 'pr' }>;

export interface PrCardProps {
  details: PrDetails;
}

export function PrCard({ details }: PrCardProps): React.JSX.Element {
  // No PR opened yet — the "Create PR" affordance lives in the BlockerList, so keep this
  // to a simple empty note.
  if (details.number === undefined) {
    return (
      <div
        className="px-3 py-2 text-xs text-slate-500"
        data-testid="pr-card-empty"
      >
        No pull request yet.
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-1 border-b border-slate-800 px-3 py-2"
      data-testid="pr-card"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-slate-400">
          #{details.number}
        </span>
        {details.draft ? (
          <span
            className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] uppercase text-slate-300"
            data-testid="pr-draft-badge"
          >
            Draft
          </span>
        ) : null}
        {details.mergeableState ? (
          <span
            className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400"
            data-testid="pr-mergeable-state"
          >
            {details.mergeableState}
          </span>
        ) : null}
      </div>
      <div className="truncate text-xs text-slate-200" title={details.title}>
        {details.title ?? 'Untitled PR'}
      </div>
      {details.url ? (
        <a
          href={details.url}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-sky-400 underline"
          data-testid="pr-link"
        >
          View on GitHub
        </a>
      ) : null}
    </div>
  );
}
