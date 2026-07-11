// CommentRail — the open inline review comments for a workspace, each with a per-
// comment Resolve action, plus the bulk "Send to agent" button (count of open
// comments). Mirrors the chat feature's card styling (slate borders, uppercase label).

import { Badge, Button } from '@renderer/components/ui';
import type { BadgeTone } from '@renderer/components/ui';
import type { DiffComment } from '@shared/review';

export interface CommentRailProps {
  comments: DiffComment[];
  openCount: number;
  onResolve: (commentId: string) => void;
  onSendToAgent: () => void;
}

/** Badge tone per comment lifecycle state (spec §3 `diff_comments.state`). */
const STATE_BADGE: Record<DiffComment['state'], BadgeTone> = {
  open: 'warn',
  sent: 'accent',
  resolved: 'neutral',
};

export function CommentRail({
  comments,
  openCount,
  onResolve,
  onSendToAgent,
}: CommentRailProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col" data-testid="comment-rail">
      <div className="flex items-center justify-between border-b border-border-1 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-caps text-fg-3">
          Comments
        </span>
        <Button
          variant="primary"
          size="sm"
          data-testid="send-to-agent"
          disabled={openCount === 0}
          onClick={onSendToAgent}
        >
          Send to agent ({openCount})
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {comments.length === 0 ? (
          <p className="p-3 text-xs text-fg-3">No comments yet.</p>
        ) : (
          <ul className="space-y-1.5 p-2">
            {comments.map((c) => (
              <li
                key={c.id}
                data-testid={`comment-item-${c.id}`}
                className="rounded-2 border border-border-1 bg-surface-card p-2 text-xs"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span
                    className="truncate font-mono text-fg-2"
                    title={c.filePath}
                  >
                    {c.filePath}
                    {c.lineStart != null ? `:${c.lineStart}` : ''}
                  </span>
                  <Badge
                    tone={STATE_BADGE[c.state]}
                    className="shrink-0 uppercase"
                  >
                    {c.state}
                  </Badge>
                </div>
                <p className="whitespace-pre-wrap text-fg-1">{c.body}</p>
                {c.state === 'open' && (
                  <button
                    type="button"
                    className="mt-1.5 text-xs text-fg-2 hover:text-fg-1"
                    data-testid={`comment-resolve-${c.id}`}
                    onClick={() => onResolve(c.id)}
                  >
                    Resolve
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
