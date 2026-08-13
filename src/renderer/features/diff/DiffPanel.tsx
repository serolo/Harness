// Git changes panel: a compact changes overview by default, with file review details
// opened on selection. Review comments and checkpoints remain available without crowding
// the always-visible file list.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, GitPullRequest } from 'lucide-react';
import type { PrSummary } from '@shared/github';
import type { DiffQuery } from '@shared/review';
import { Button, PanelTab, PanelTabBar } from '@renderer/components/ui';
import { invoke } from '@renderer/ipc';
import { FileTree } from './FileTree';
import { DiffView } from './DiffView';
import { CommentRail } from './CommentRail';
import { CommitFilter } from './CommitFilter';
import { useDiff } from './useDiff';
import { WorkspaceFileTree } from './WorkspaceFileTree';

export interface DiffPanelProps {
  workspaceId: string | null;
  workspaceBranch?: string | null;
  workspacePrNumber?: number | null;
  onInspectFile?: (
    path: string,
    comparison?: Omit<DiffQuery, 'workspaceId'>,
  ) => void;
}

export function DiffPanel({
  workspaceId,
  workspaceBranch = null,
  workspacePrNumber = null,
  onInspectFile,
}: DiffPanelProps): React.JSX.Element {
  const [view, setView] = useState<'all' | 'changes'>('changes');
  const { data: pullRequest } = useQuery<PrSummary | null>({
    queryKey: ['workspace-pr', workspaceId, workspaceBranch, workspacePrNumber],
    queryFn: async () => {
      if (!workspaceId) return null;
      return (await invoke('github:getWorkspacePr', { workspaceId })) ?? null;
    },
    enabled: workspaceId !== null,
    retry: false,
    staleTime: 15_000,
    // DiffPanel is the selected workspace's persistent observer. Keep live PR and
    // merge-queue state fresh even when the collapsible sidebar is unmounted.
    refetchInterval: (query) => {
      const state = query.state.data?.state?.toLowerCase();
      if (state === 'closed' || state === 'merged') return false;
      return 60_000;
    },
    refetchOnWindowFocus: true,
  });
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

  useEffect(() => {
    setView('changes');
  }, [workspaceId]);

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
      <PanelTabBar
        label="Git views"
        testId="git-changes-header"
        actions={
          <>
            {pullRequest?.url ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-fg-2"
                data-testid="git-open-pr"
                onClick={() => {
                  void invoke('github:openPrUrl', {
                    url: pullRequest.url,
                  }).catch(() => {
                    window.alert(
                      'Failed to open the pull request in your browser.',
                    );
                  });
                }}
              >
                <GitPullRequest className="h-4 w-4" aria-hidden="true" />
                Open PR
              </Button>
            ) : null}
            {view === 'changes' ? (
              <>
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
              </>
            ) : null}
          </>
        }
      >
        <PanelTab
          active={view === 'all'}
          onClick={() => {
            selectFile(null);
            setView('all');
          }}
        >
          All files
        </PanelTab>
        <PanelTab
          active={view === 'changes'}
          onClick={() => {
            selectFile(null);
            setView('changes');
          }}
        >
          <span className="flex items-center gap-2">
            Changes <span className="text-fg-2">{files.length}</span>
          </span>
        </PanelTab>
      </PanelTabBar>

      {view === 'all' ? (
        <div className="min-h-0 flex-1">
          <WorkspaceFileTree
            workspaceId={workspaceId}
            onSelectFile={(path) => {
              if (onInspectFile) onInspectFile(path);
              else {
                setView('changes');
                selectFile(path);
              }
            }}
          />
        </div>
      ) : !hasChanges ? (
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
            onSelect={(path) => {
              if (onInspectFile) {
                onInspectFile(
                  path,
                  menuInfo
                    ? { targetRef: menuInfo.targetRef, scope }
                    : undefined,
                );
                return;
              }
              selectFile(path);
            }}
          />
        </div>
      )}
    </div>
  );
}
