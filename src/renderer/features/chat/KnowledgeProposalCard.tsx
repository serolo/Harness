import { BookOpenCheck } from 'lucide-react';
import { useNavStore } from '@renderer/stores/nav';

export function KnowledgeProposalCard({
  workspaceId,
  projectId,
  count,
}: {
  workspaceId: string;
  projectId: string;
  count: number;
}): React.JSX.Element | null {
  const navigate = useNavStore((state) => state.navigate);
  if (count === 0) return null;

  return (
    <div
      className="rounded-2 border border-accent/30 bg-accent-muted p-3"
      data-testid="knowledge-proposal-card"
    >
      <div className="flex items-start gap-2">
        <BookOpenCheck
          className="mt-0.5 h-4 w-4 shrink-0 text-accent"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg-1">
            Knowledge reconciliation complete
          </p>
          <p className="mt-1 text-xs text-fg-2">
            {count} OKF {count === 1 ? 'change is' : 'changes are'} ready for
            review.
          </p>
          <button
            type="button"
            className="mt-2 text-xs font-semibold text-accent hover:underline"
            onClick={() => navigate({ workspaceId, pane: 'knowledge' })}
            data-project-id={projectId}
          >
            Review in Knowledge →
          </button>
        </div>
      </div>
    </div>
  );
}
