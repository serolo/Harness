// Git changes panel: a compact changes overview by default, with file review details
// opened on selection. Review comments and checkpoints remain available without crowding
// the always-visible file list.

import { Eye } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { FileTree } from './FileTree';
import { DiffView } from './DiffView';
import { CommentRail } from './CommentRail';
import { CommitFilter } from './CommitFilter';
import { useDiff } from './useDiff';

export interface DiffPanelProps {
  workspaceId: string | null;
}

export function DiffPanel({ workspaceId }: DiffPanelProps): React.JSX.Element {
  const {
    diffSet,
    selectedPath,
    selectFile,
    fileDiff,
    loadingFileDiff,
    menuInfo,
    scope,
    setTargetRef,
    setScope,
    comments,
    openComments,
    createComment,
    resolveComment,
    sendCommentsToAgent,
    runReview,
  } = useDiff(workspaceId);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
        data-testid="diff-empty"
      >
        Select a workspace to view its diff.
      </div>
    );
  }

  const files = diffSet?.files ?? [];
  const hasChanges = files.length > 0;

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-surface-app"
      data-testid="diff-panel"
    >
      <header
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border-1 px-3"
        data-testid="git-changes-header"
      >
        <button
          type="button"
          className="shrink-0 rounded-2 px-2 py-1 text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-1"
          onClick={() => selectFile(null)}
        >
          All files
        </button>
        <button
          type="button"
          className="flex shrink-0 items-center gap-2 rounded-3 bg-bg-4 px-3 py-1.5 text-sm font-medium text-fg-1"
          aria-pressed={selectedPath === null}
          onClick={() => selectFile(null)}
        >
          Changes <span className="text-fg-2">{files.length}</span>
        </button>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-fg-2"
            data-testid="agent-review"
            onClick={() => void runReview()}
          >
            <Eye className="h-4 w-4" aria-hidden="true" />
            Review
          </Button>
          <CommitFilter
            info={menuInfo}
            scope={scope}
            onTargetRefChange={setTargetRef}
            onScopeChange={setScope}
          />
        </div>
      </header>

      {!hasChanges ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-fg-3"
          data-testid="diff-no-changes"
        >
          No changes in this workspace.
        </div>
      ) : selectedPath ? (
        <div className="flex min-h-0 flex-1" data-testid="diff-detail">
          <div className="min-w-0 flex-1">
            <DiffView
              path={selectedPath}
              fileDiff={fileDiff}
              loading={loadingFileDiff}
              onAddComment={(input) => {
                void createComment({ filePath: selectedPath, ...input });
              }}
            />
          </div>
          <aside className="w-60 shrink-0 border-l border-border-1">
            <CommentRail
              comments={comments}
              openCount={openComments.length}
              onResolve={(id) => void resolveComment(id)}
              onSendToAgent={() => void sendCommentsToAgent()}
            />
          </aside>
        </div>
      ) : (
        <div className="min-h-0 flex-1" data-testid="diff-overview">
          <FileTree
            files={files}
            selectedPath={selectedPath}
            onSelect={selectFile}
          />
        </div>
      )}
    </div>
  );
}
