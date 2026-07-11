// BlockerList — the red "what's stopping this merge" list at the top of the Checks panel.
// Lists the actionable check rows (those whose `suggestedAction` maps to a wired command:
// "Commit & push"/"Create PR" → `pr:open`, "Fix failing checks" → `pr:fixChecks`,
// "Fix review comments" → `pr:fixReviews`) each with a one-click action button. The click
// handler is passed the item's `suggestedAction`; `useChecks.runBlockerAction` resolves it
// to the matching command. Purely presentational.

import type { CheckItem } from '@shared/checks';
import { Button } from '@renderer/components/ui';
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
      className="flex flex-col gap-1 border-b border-danger bg-danger-muted p-2"
      data-testid="blocker-list"
    >
      {actionable.map((item) => (
        <li
          key={item.source}
          className="flex items-center justify-between gap-2 rounded-2 px-2 py-1 text-xs"
          data-testid={`blocker-${item.source}`}
        >
          <span className="min-w-0 flex-1 truncate text-danger">
            {item.label}
          </span>
          <Button
            variant="danger"
            size="sm"
            className="shrink-0 text-2xs"
            data-testid={`blocker-action-${item.source}`}
            onClick={() => onAction(item.suggestedAction as string)}
          >
            {item.suggestedAction}
          </Button>
        </li>
      ))}
    </ul>
  );
}
