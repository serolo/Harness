// CommentRail — the open inline review comments for a workspace, each with a per-
// comment Resolve action, plus the bulk "Send to agent" button (count of open
// comments). Mirrors the chat feature's card styling (slate borders, uppercase label).

import type { DiffComment } from '@shared/review';

export interface CommentRailProps {
  comments: DiffComment[];
  openCount: number;
  onResolve: (commentId: string) => void;
  onSendToAgent: () => void;
}

/** Badge color per comment lifecycle state (spec §3 `diff_comments.state`). */
const STATE_BADGE: Record<DiffComment['state'], string> = {
  open: 'bg-amber-900/40 text-amber-300',
  sent: 'bg-sky-900/40 text-sky-300',
  resolved: 'bg-slate-800 text-slate-500',
};

export function CommentRail({
  comments,
  openCount,
  onResolve,
  onSendToAgent,
}: CommentRailProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col" data-testid="comment-rail">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Comments
        </span>
        <button
          type="button"
          className="rounded-md bg-sky-600 px-2 py-1 text-xs font-medium text-white enabled:hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="send-to-agent"
          disabled={openCount === 0}
          onClick={onSendToAgent}
        >
          Send to agent ({openCount})
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {comments.length === 0 ? (
          <p className="p-3 text-xs text-slate-600">No comments yet.</p>
        ) : (
          <ul className="space-y-1.5 p-2">
            {comments.map((c) => (
              <li
                key={c.id}
                data-testid={`comment-item-${c.id}`}
                className="rounded-md border border-slate-800 bg-slate-900/60 p-2 text-xs"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span
                    className="truncate font-mono text-slate-400"
                    title={c.filePath}
                  >
                    {c.filePath}
                    {c.lineStart != null ? `:${c.lineStart}` : ''}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${STATE_BADGE[c.state]}`}
                  >
                    {c.state}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-slate-200">{c.body}</p>
                {c.state === 'open' && (
                  <button
                    type="button"
                    className="mt-1.5 text-[11px] text-slate-400 hover:text-slate-200"
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
