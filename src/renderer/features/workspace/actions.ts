import type { Workspace } from '@shared/models';
import { invoke } from '@renderer/ipc';

/** Archive with the same dirty-worktree warning from every UI entry point. */
export async function archiveWorkspaceWithConfirmation(
  workspace: Workspace,
): Promise<boolean> {
  const preview = await invoke('workspace:archivePreview', {
    id: workspace.id,
  });
  const details: string[] = [];
  if (preview.hasUncommittedChanges) {
    details.push(
      preview.willDeleteWorktree
        ? `Warning: ${preview.changedFileCount} uncommitted file${preview.changedFileCount === 1 ? '' : 's'} will be permanently deleted with the worktree.`
        : `${preview.changedFileCount} uncommitted file${preview.changedFileCount === 1 ? '' : 's'} will remain in the preserved checkout.`,
    );
  }
  details.push(
    preview.willDeleteWorktree
      ? 'The managed worktree will be removed from disk.'
      : 'The checkout will be kept on disk.',
  );
  const confirmed = window.confirm(
    `Archive workspace "${workspace.name}"?\n\n${details.join('\n')}`,
  );
  if (!confirmed) return false;

  await invoke('workspace:archive', { id: workspace.id });
  return true;
}

/** Stable link understood by the app's registered deep-link resolver. */
export function workspaceDeepLink(workspaceId: string): string {
  return `harness://workspace/${encodeURIComponent(workspaceId)}`;
}
