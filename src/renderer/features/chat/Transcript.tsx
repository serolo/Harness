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

export interface TranscriptProps {
  turns: RenderedTurn[];
}

/** Render one AgentEvent to its card/component. */
function renderEvent(event: AgentEvent, key: string): React.JSX.Element | null {
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
      return <ErrorCard key={key} message={event.message} />;
    case 'turn_end':
      return null; // represented by the TurnDivider
    default:
      return null;
  }
}

export function Transcript({ turns }: TranscriptProps): React.JSX.Element {
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
      className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3"
      data-testid="transcript"
    >
      {turns.map((turn) => (
        <div key={turn.turnId} data-testid="turn" data-status={turn.status}>
          {turn.events.map((event, i) =>
            renderEvent(event, `${turn.turnId}-${i}`),
          )}
          <TurnDivider status={turn.status} usage={turn.usage} />
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
