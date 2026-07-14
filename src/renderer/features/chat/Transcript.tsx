// The scrolling transcript: renders each turn's AgentEvents and a status/usage divider.
// Auto-scrolls to the bottom as new content streams in, but PAUSES auto-scroll when the
// user has scrolled up (so reading history isn't yanked back down).

import { useEffect, useRef } from 'react';
import type { AgentEvent } from '@shared/harness';
import type { RenderedTurn } from '@renderer/stores/chat';
import { TextMessage } from './TextMessage';
import { ToolCard } from './ToolCard';
import { FileEditChip } from './FileEditChip';
import { TodoList } from './TodoList';
import { ErrorCard } from './ErrorCard';
import { TurnDivider } from './TurnDivider';
import { LimitResumeOffer } from './LimitResumeOffer';

export interface TranscriptProps {
  turns: RenderedTurn[];
  /** The workspace this transcript belongs to; threads into the limit-resume offer. */
  workspaceId?: string | null;
}

/** Render one AgentEvent to its card/component. */
function renderEvent(
  event: AgentEvent,
  key: string,
  workspaceId?: string | null,
): React.JSX.Element | null {
  switch (event.kind) {
    case 'text':
      return <TextMessage key={key} delta={event.delta} />;
    case 'tool_use':
      return (
        <ToolCard
          key={key}
          variant="use"
          name={event.name}
          payload={event.input}
        />
      );
    case 'tool_result':
      return <ToolCard key={key} variant="result" payload={event.output} />;
    case 'file_edit':
      return <FileEditChip key={key} path={event.path} op={event.op} />;
    case 'todo_update':
      return <TodoList key={key} todos={event.todos} />;
    case 'error':
      return (
        <div key={key}>
          <ErrorCard message={event.message} />
          {workspaceId ? (
            <LimitResumeOffer
              workspaceId={workspaceId}
              message={event.message}
            />
          ) : null}
        </div>
      );
    case 'turn_end':
      return null; // represented by the TurnDivider
    default:
      return null;
  }
}

export function Transcript({
  turns,
  workspaceId,
}: TranscriptProps): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Track whether the user is near the bottom; only auto-scroll when pinned.
  function handleScroll(): void {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottom.current = distanceFromBottom < 40;
  }

  useEffect(() => {
    // `scrollIntoView` is absent under jsdom (tests) — guard so it stays a no-op there.
    const end = endRef.current;
    if (pinnedToBottom.current && typeof end?.scrollIntoView === 'function') {
      end.scrollIntoView({ block: 'end' });
    }
  }, [turns]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-8"
      data-testid="transcript"
    >
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8">
        {turns.map((turn) => (
          <div
            key={turn.turnId}
            className="space-y-5"
            data-testid="turn"
            data-status={turn.status}
          >
            <div className="space-y-5">
              {turn.events.map((event, i) =>
                renderEvent(event, `${turn.turnId}-${i}`, workspaceId),
              )}
            </div>
            <TurnDivider status={turn.status} usage={turn.usage} />
          </div>
        ))}
      </div>
      <div ref={endRef} />
    </div>
  );
}
