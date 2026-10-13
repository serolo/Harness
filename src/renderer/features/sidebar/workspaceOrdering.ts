import type { PrSummary } from '@shared/github';
import type { Workspace } from '@shared/models';

/** Terminal states always win over stale draft/merge-queue metadata. */
export function isActivePullRequest(
  pullRequest: PrSummary | null | undefined,
): boolean {
  if (pullRequest === null || pullRequest === undefined) return false;
  const state = pullRequest.state?.toLowerCase();
  if (state === 'closed' || state === 'merged') return false;
  return (
    state === 'open' ||
    state === 'queued' ||
    pullRequest.mergeQueueState !== undefined
  );
}

function createdAtSortValue(workspace: Workspace): number {
  return Number.isFinite(workspace.createdAt)
    ? workspace.createdAt
    : Number.NEGATIVE_INFINITY;
}

/**
 * Sidebar order: explicit pins, confirmed active PRs, newest creation time, then
 * descending id (the same deterministic tie-break used by the repository query).
 */
export function compareProjectWorkspaces(
  left: Workspace,
  right: Workspace,
  openPrByWorkspace: Readonly<Record<string, boolean>>,
): number {
  const pinOrder =
    Number(Boolean(right.isPinned)) - Number(Boolean(left.isPinned));
  if (pinOrder !== 0) return pinOrder;

  const prOrder =
    Number(openPrByWorkspace[right.id] === true) -
    Number(openPrByWorkspace[left.id] === true);
  if (prOrder !== 0) return prOrder;

  const createdOrder = createdAtSortValue(right) - createdAtSortValue(left);
  if (createdOrder !== 0) return createdOrder;
  return right.id.localeCompare(left.id);
}
