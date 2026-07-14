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
import { UserMessage } from './UserMessage';
import { QuestionCard } from './QuestionCard';
import { PermissionCard } from './PermissionCard';
import { permissionFromToolResult } from './toolResults';
import { ModelActivity } from './ModelActivity';

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
  toolResult?: unknown,
): React.JSX.Element | null {
  switch (event.kind) {
    case 'user_message':
      return <UserMessage key={key} text={event.text} />;
    case 'question_request':
      return <QuestionCard key={key} questions={event.questions} />;
    case 'permission_request':
      return (
        <PermissionCard
          key={key}
          title={event.title}
          description={event.description}
          toolName={event.toolName}
          input={event.input}
        />
      );
    case 'text':
      return <TextMessage key={key} delta={event.delta} />;
    case 'tool_use':
      return (
        <ToolCard
          key={key}
          name={event.name}
          payload={event.input}
          result={toolResult}
        />
      );
    case 'tool_result': {
      // Results are internal agent↔tool protocol traffic. Hide successful results;
      // translate approval failures into the UI the user can actually react to.
      const permission = permissionFromToolResult(event.output);
      return permission ? <PermissionCard key={key} {...permission} /> : null;
    }
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

function isActivityEvent(event: AgentEvent): boolean {
  if (event.kind === 'tool_result') {
    return permissionFromToolResult(event.output) === null;
  }
  return (
    event.kind === 'text' ||
    event.kind === 'tool_use' ||
    event.kind === 'file_edit' ||
    event.kind === 'todo_update'
  );
}

function isToolActivity(event: AgentEvent): boolean {
  return (
    event.kind === 'tool_use' ||
    event.kind === 'file_edit' ||
    event.kind === 'todo_update'
  );
}

/**
 * The provider-neutral event contract does not carry tool-call ids, but both CLI
 * streams preserve call/result order. Pair successful results FIFO within one model
 * activity leg, consuming file/todo results without attaching them to a generic tool.
 */
function pairToolResults(events: AgentEvent[]): Map<number, unknown> {
  const results = new Map<number, unknown>();
  const pending: Array<number | null> = [];

  events.forEach((event, index) => {
    if (event.kind === 'tool_use') {
      pending.push(index);
      return;
    }
    if (event.kind === 'file_edit' || event.kind === 'todo_update') {
      pending.push(null);
      return;
    }
    if (event.kind === 'tool_result') {
      const toolIndex = pending.shift();
      if (
        toolIndex !== undefined &&
        toolIndex !== null &&
        permissionFromToolResult(event.output) === null
      ) {
        results.set(toolIndex, event.output);
      }
      return;
    }
    if (event.kind === 'text' || !isActivityEvent(event)) {
      pending.length = 0;
    }
  });

  return results;
}

/**
 * Keep the latest model message visible, collapsing earlier model messages and the
 * tool activity around them. Actionable questions, permissions, errors, and user
 * messages split activity into separate segments so they can never be hidden.
 */
function renderEvents(
  events: AgentEvent[],
  keyPrefix: string,
  workspaceId?: string | null,
): React.JSX.Element[] {
  const rendered: React.JSX.Element[] = [];
  const toolResults = pairToolResults(events);
  let segmentStart = 0;

  function renderActivitySegment(start: number, end: number): void {
    if (start >= end) return;
    const segment = events.slice(start, end);
    const textIndexes = segment.flatMap((event, index) =>
      event.kind === 'text' ? [index] : [],
    );

    if (textIndexes.length < 2) {
      segment.forEach((event, index) => {
        const absoluteIndex = start + index;
        const item = renderEvent(
          event,
          `${keyPrefix}-${absoluteIndex}`,
          workspaceId,
          toolResults.get(absoluteIndex),
        );
        if (item) rendered.push(item);
      });
      return;
    }

    const latestTextIndex = textIndexes[textIndexes.length - 1];
    const earlierEvents = segment.slice(0, latestTextIndex);
    const messageCount = earlierEvents.filter(
      (event) => event.kind === 'text',
    ).length;
    const toolCount = earlierEvents.filter(isToolActivity).length;
    const toolNames = earlierEvents.flatMap((event) => {
      if (event.kind === 'tool_use') return [event.name];
      if (event.kind === 'file_edit') return ['Edit'];
      if (event.kind === 'todo_update') return ['TodoWrite'];
      return [];
    });
    const children = earlierEvents.flatMap((event, index) => {
      const absoluteIndex = start + index;
      const item = renderEvent(
        event,
        `${keyPrefix}-${absoluteIndex}`,
        workspaceId,
        toolResults.get(absoluteIndex),
      );
      return item ? [item] : [];
    });

    rendered.push(
      <ModelActivity
        key={`${keyPrefix}-${start}-activity`}
        messageCount={messageCount}
        toolCount={toolCount}
        toolNames={toolNames}
      >
        {children}
      </ModelActivity>,
    );

    segment.slice(latestTextIndex).forEach((event, index) => {
      const absoluteIndex = start + latestTextIndex + index;
      const item = renderEvent(
        event,
        `${keyPrefix}-${absoluteIndex}`,
        workspaceId,
        toolResults.get(absoluteIndex),
      );
      if (item) rendered.push(item);
    });
  }

  events.forEach((event, index) => {
    if (isActivityEvent(event)) return;
    renderActivitySegment(segmentStart, index);
    const item = renderEvent(
      event,
      `${keyPrefix}-${index}`,
      workspaceId,
      toolResults.get(index),
    );
    if (item) rendered.push(item);
    segmentStart = index + 1;
  });
  renderActivitySegment(segmentStart, events.length);

  return rendered;
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
            className="space-y-4"
            data-testid="turn"
            data-status={turn.status}
          >
            <div className="space-y-3">
              {renderEvents(turn.events, turn.turnId, workspaceId)}
            </div>
            <TurnDivider status={turn.status} usage={turn.usage} />
          </div>
        ))}
      </div>
      <div ref={endRef} />
    </div>
  );
}
