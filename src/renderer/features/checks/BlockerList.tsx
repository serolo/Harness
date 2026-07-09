// BlockerList — the red "what's stopping this merge" list at the top of the Checks panel.
// Lists the actionable check rows (those whose `suggestedAction` maps to a wired command:
// "Commit & push"/"Create PR" → `pr:open`, "Fix failing checks" → `pr:fixChecks`,
// "Fix review comments" → `pr:fixReviews`) each with a one-click action button. The click
// handler is passed the item's `suggestedAction`; `useChecks.runBlockerAction` resolves it
// to the matching command. Purely presentational.

import type { CheckItem } from '@shared/checks';
import { blockerCommandFor } from './useChecks';

export interface BlockerListProps {
  /** The full item list; the component filters to the actionable (wired) rows itself. */
  items: CheckItem[];
  /** Run the one-click command for a row, keyed by its `suggestedAction` label. */
  onAction: (suggestedAction: string) => void;
}

export function BlockerList({
  items,
  onAction,
}: BlockerListProps): React.JSX.Element | null {
  // Only rows whose suggested action maps to a wired command get a one-click button.
  const actionable = items.filter(
    (item) =>
      item.suggestedAction !== undefined &&
      blockerCommandFor(item.suggestedAction) !== null,
  );

  if (actionable.length === 0) return null;

  return (
    <ul
      className="flex flex-col gap-1 border-b border-rose-900/40 bg-rose-950/30 p-2"
      data-testid="blocker-list"
    >
      {actionable.map((item) => (
        <li
          key={item.source}
          className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs"
          data-testid={`blocker-${item.source}`}
        >
          <span className="min-w-0 flex-1 truncate text-rose-200">
            {item.label}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-rose-700 px-2 py-0.5 text-[11px] font-medium text-rose-100 hover:bg-rose-800/50"
            data-testid={`blocker-action-${item.source}`}
            onClick={() => onAction(item.suggestedAction as string)}
          >
            {item.suggestedAction}
          </button>
        </li>
      ))}
    </ul>
  );
}
