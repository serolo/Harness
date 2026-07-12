// ChatPanel — the center-pane chat for the selected workspace. Wires `useChat`
// (history + streaming) to the Transcript, the follow-up QueueList, and the Composer.
// Renders an empty state when no workspace is selected. Owns the queue store wiring so
// QueueList/Composer stay presentational (Phase 9).

import { useEffect } from 'react';
import { History, Plus } from 'lucide-react';
import type { QueuedMessage } from '@shared/queue';
import { useQueueStore } from '@renderer/stores/queue';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { QueueList } from './QueueList';
import { useChat } from './useChat';

export interface ChatPanelProps {
  workspaceId: string | null;
}

/** Stable empty-array reference so the queue selector doesn't loop on `?? []`. */
const EMPTY_QUEUE: readonly QueuedMessage[] = [];

export function ChatPanel({ workspaceId }: ChatPanelProps): React.JSX.Element {
  const { turns, isBusy, sendTurn, interrupt, steer } = useChat(workspaceId);

  const queued = useQueueStore((s) =>
    workspaceId ? (s.byWorkspace[workspaceId] ?? EMPTY_QUEUE) : EMPTY_QUEUE,
  ) as QueuedMessage[];
  const loadQueue = useQueueStore((s) => s.load);
  const enqueue = useQueueStore((s) => s.enqueue);
  const updateQueued = useQueueStore((s) => s.update);
  const reorderQueue = useQueueStore((s) => s.reorder);
  const removeQueued = useQueueStore((s) => s.remove);

  // Hydrate the queue from the DB on open / workspace change so a restart shows the
  // persisted follow-ups. Mutations round-trip through the store (DB-authoritative).
  useEffect(() => {
    if (!workspaceId) return;
    void loadQueue(workspaceId);
  }, [workspaceId, loadQueue]);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-base text-fg-3"
        data-testid="chat-empty"
      >
        Select a workspace to begin.
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-surface-app"
      data-testid="chat-panel"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-1 bg-surface-panel px-5">
        <div className="flex h-full items-center gap-8">
          <div className="flex h-full items-center border-b-2 border-accent px-1 text-sm font-semibold text-fg-1">
            Claude
          </div>
          <button
            type="button"
            className="rounded-1 p-1 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
            aria-label="New chat"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="rounded-1 p-1 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
          aria-label="Chat history"
        >
          <History className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <Transcript turns={turns} />
      <div className="shrink-0 px-6">
        <QueueList
          messages={queued}
          onEdit={(id, prompt) => void updateQueued(id, { prompt })}
          onReorder={(orderedIds) => void reorderQueue(workspaceId, orderedIds)}
          onDelete={(id) => void removeQueued(workspaceId, id)}
          onSteerNow={(message) => {
            // Send that queued item now: drop it from the queue, then steer it (true
            // injection when supported, else interrupt+resend). Carry the row's
            // attachments/mode so the fallback resend preserves the full payload.
            void removeQueued(workspaceId, message.id).then(() =>
              steer(message.prompt, message.attachments, message.mode),
            );
          }}
        />
      </div>
      <Composer
        isBusy={isBusy}
        onSend={(prompt, attachments, mode, harness) =>
          sendTurn(prompt, attachments, mode, harness)
        }
        onInterrupt={interrupt}
        onEnqueue={(prompt, attachments, mode) =>
          enqueue(workspaceId, prompt, attachments, mode)
        }
        onSteer={steer}
      />
    </div>
  );
}
