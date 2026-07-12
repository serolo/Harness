// QueueList — the durable follow-up queue rendered above the Composer (Phase 9). Each row
// shows a queued prompt with inline edit, up/down reorder, delete, and a per-row "Steer
// now" that sends THAT item immediately. The parent (ChatPanel) owns the wiring: this
// component is presentational and calls back with the derived intent (new prompt, the
// reordered id list, the id to delete, the message to steer). Styling mirrors TodoList.

import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Pencil, Trash2, Zap } from 'lucide-react';
import type { QueuedMessage } from '@shared/queue';

export interface QueueListProps {
  messages: QueuedMessage[];
  /** Save an inline edit to a queued message's prompt. */
  onEdit: (id: string, prompt: string) => void;
  /** Persist a new full ordering (a permutation of the current ids). */
  onReorder: (orderedIds: string[]) => void;
  /** Remove a queued message. */
  onDelete: (id: string) => void;
  /** Send this queued message immediately ("steer now"). */
  onSteerNow: (message: QueuedMessage) => void;
}

export function QueueList({
  messages,
  onEdit,
  onReorder,
  onDelete,
  onSteerNow,
}: QueueListProps): React.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (messages.length === 0) return null;

  function beginEdit(message: QueuedMessage): void {
    setEditingId(message.id);
    setDraft(message.prompt);
  }

  function saveEdit(id: string): void {
    const next = draft.trim();
    if (next !== '') onEdit(id, next);
    setEditingId(null);
    setDraft('');
  }

  // Move the row at `index` up/down by swapping it with its neighbour, then emit the new
  // id ordering for the parent to persist via `queue:reorder`.
  function move(index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= messages.length) return;
    const ids = messages.map((m) => m.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    onReorder(ids);
  }

  return (
    <div
      className="mx-auto mb-2 w-full max-w-[1120px] rounded-3 border border-border-1 bg-surface-card p-2"
      data-testid="queue-list"
    >
      <div className="mb-1 px-1 text-xs font-medium uppercase tracking-caps text-fg-3">
        Queued ({messages.length})
      </div>
      <ul className="space-y-1">
        {messages.map((message, index) => (
          <li
            key={message.id}
            className="flex items-center gap-2 rounded-2 px-2 py-1.5 text-base text-fg-1 hover:bg-bg-3"
            data-testid="queue-row"
            data-queue-id={message.id}
          >
            <span className="w-5 shrink-0 text-right text-sm text-fg-3">
              {index + 1}
            </span>
            {editingId === message.id ? (
              <input
                className="min-w-0 flex-1 rounded-1 border border-border-1 bg-surface-panel px-2 py-1 text-base text-fg-1 focus:outline-none"
                value={draft}
                autoFocus
                data-testid="queue-edit-input"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveEdit(message.id);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditingId(null);
                    setDraft('');
                  }
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{message.prompt}</span>
            )}
            <div className="flex shrink-0 items-center gap-0.5">
              {editingId === message.id ? (
                <button
                  type="button"
                  className="rounded-1 p-1 text-fg-3 hover:bg-bg-4 hover:text-fg-1"
                  data-testid="queue-edit-save"
                  aria-label="Save edit"
                  onClick={() => saveEdit(message.id)}
                >
                  <Check className="h-4 w-4" aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-1 p-1 text-fg-3 hover:bg-bg-4 hover:text-fg-1"
                  data-testid="queue-edit"
                  aria-label="Edit queued message"
                  onClick={() => beginEdit(message)}
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                </button>
              )}
              <button
                type="button"
                className="rounded-1 p-1 text-fg-3 hover:bg-bg-4 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="queue-up"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className="rounded-1 p-1 text-fg-3 hover:bg-bg-4 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="queue-down"
                aria-label="Move down"
                disabled={index === messages.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className="rounded-1 p-1 text-fg-3 hover:bg-bg-4 hover:text-fg-1"
                data-testid="queue-steer"
                aria-label="Steer now"
                onClick={() => onSteerNow(message)}
              >
                <Zap className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className="rounded-1 p-1 text-fg-3 hover:bg-bg-4 hover:text-danger"
                data-testid="queue-delete"
                aria-label="Delete queued message"
                onClick={() => onDelete(message.id)}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
