// DiffPanel — the diff-review center tab's orchestrator: [FileTree | DiffView +
// CommentRail] with a CommitFilter + "Agent review" row up top and the
// CheckpointTimeline along the bottom. Empty states cover "no workspace selected" and
// "no changes in this workspace". Wires `useDiff` + `useCheckpoints` to the presentational
// sub-components; all main access happens inside those hooks via `@renderer/ipc`.

import { FileTree } from './FileTree';
import { DiffView } from './DiffView';
import { CommentRail } from './CommentRail';
import { CommitFilter } from './CommitFilter';
import { CheckpointTimeline } from './CheckpointTimeline';
import { useDiff } from './useDiff';
import { useCheckpoints } from './useCheckpoints';

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
    commits,
    commitFilter,
    setCommitFilter,
    comments,
    openComments,
    createComment,
    resolveComment,
    sendCommentsToAgent,
    runReview,
  } = useDiff(workspaceId);
  const { checkpoints, revert } = useCheckpoints(workspaceId);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-slate-600"
        data-testid="diff-empty"
      >
        Select a workspace to view its diff.
      </div>
    );
  }

  const hasChanges = (diffSet?.files.length ?? 0) > 0;

  return (
    <div className="flex h-full flex-col" data-testid="diff-panel">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
        <CommitFilter
          commits={commits}
          value={commitFilter}
          onChange={setCommitFilter}
        />
        <button
          type="button"
          className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800"
          data-testid="agent-review"
          onClick={() => void runReview()}
        >
          Agent review
        </button>
      </div>

      {!hasChanges ? (
        <div
          className="flex flex-1 items-center justify-center p-6 text-sm text-slate-600"
          data-testid="diff-no-changes"
        >
          No changes in this workspace.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-56 shrink-0 border-r border-slate-800">
            <FileTree
              files={diffSet?.files ?? []}
              selectedPath={selectedPath}
              onSelect={selectFile}
            />
          </aside>
          <div className="min-w-0 flex-1">
            <DiffView
              path={selectedPath}
              fileDiff={fileDiff}
              loading={loadingFileDiff}
              onAddComment={(input) => {
                if (!selectedPath) return;
                void createComment({ filePath: selectedPath, ...input });
              }}
            />
          </div>
          <aside className="w-72 shrink-0 border-l border-slate-800">
            <CommentRail
              comments={comments}
              openCount={openComments.length}
              onResolve={(id) => void resolveComment(id)}
              onSendToAgent={() => void sendCommentsToAgent()}
            />
          </aside>
        </div>
      )}

      <CheckpointTimeline
        checkpoints={checkpoints}
        onRevert={(turnIdx) => revert(turnIdx)}
      />
    </div>
  );
}
