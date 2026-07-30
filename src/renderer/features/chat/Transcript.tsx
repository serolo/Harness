// The scrolling transcript: renders each turn's AgentEvents and a status/usage divider.
// Auto-scrolls to the bottom as new content streams in, but PAUSES auto-scroll when the
// user has scrolled up (so reading history isn't yanked back down).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FolderGit2,
  GitBranch,
  GitFork,
  GitPullRequest,
  MapPin,
} from 'lucide-react';
import type { AgentEvent, AgentQuestion, Usage } from '@shared/harness';
import type { Project, Workspace } from '@shared/models';
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
import { StreamingElapsed } from './StreamingElapsed';
import { ActivityChip } from './ActivityChip';
import { PlanApproval } from './PlanApproval';
import { Markdown } from './markdown';
import { invoke } from '@renderer/ipc';
import { KnowledgeProposalCard } from './KnowledgeProposalCard';
import { KnowledgeContextCard } from './KnowledgeContextCard';

function visibleUserText(text: string): string {
  const marker = text.indexOf('\n\n<project_knowledge>');
  return marker >= 0 ? text.slice(0, marker).trimEnd() : text;
}

function visibleModelText(text: string): string {
  return text
    .replace(
      /<harness_knowledge_proposal>[\s\S]*?<\/harness_knowledge_proposal>/g,
      '',
    )
    .replace(/<harness_knowledge_proposal>[\s\S]*$/g, '')
    .trimEnd();
}

function contextUsage(events: AgentEvent[]): Usage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'context_usage') return event.usage;
  }
  return undefined;
}

export interface TranscriptProps {
  turns: RenderedTurn[];
  /** The workspace this transcript belongs to; threads into the limit-resume offer. */
  workspaceId?: string | null;
  onOpenFile?: (path: string) => void;
  onApprovePlan?: () => void;
  onAnswerQuestion?: (answer: string) => void;
  isBusy?: boolean;
  workspace?: Workspace;
  project?: Project;
}

function NewChatWorkspaceContext({
  workspace,
  project,
}: {
  workspace: Workspace;
  project?: Project;
}): React.JSX.Element {
  const source =
    workspace.prNumber !== null
      ? `PR #${workspace.prNumber}`
      : workspace.sourceKind === 'github_issue' && workspace.sourceRef
        ? `Issue #${workspace.sourceRef}`
        : workspace.sourceKind === 'linear_issue' && workspace.sourceRef
          ? workspace.sourceRef
          : null;
  const checkoutLabel =
    workspace.location === 'project' ? 'Project checkout' : 'Worktree';
  const checkoutName =
    workspace.worktreePath
      ?.split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? 'Checkout unavailable';

  return (
    <section
      className="mx-auto mt-8 w-full max-w-2xl rounded-4 border border-border-1 bg-surface-panel p-5 shadow-2"
      data-testid="new-chat-workspace-context"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-fg-3">
        New chat in
      </p>
      <h2 className="mt-1 truncate text-lg font-semibold text-fg-1">
        {workspace.name}
      </h2>
      <p className="mt-1 text-sm text-fg-3">
        This chat starts with a fresh model context for the current workspace.
      </p>

      <dl className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 items-start gap-2">
          <GitBranch
            className="mt-0.5 h-4 w-4 shrink-0 text-accent"
            aria-hidden
          />
          <div className="min-w-0">
            <dt className="text-xs text-fg-3">Branch</dt>
            <dd
              className="truncate font-mono text-sm text-fg-1"
              title={workspace.branch}
            >
              {workspace.branch}
            </dd>
          </div>
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <GitFork
            className="mt-0.5 h-4 w-4 shrink-0 text-fg-3"
            aria-hidden
          />
          <div className="min-w-0">
            <dt className="text-xs text-fg-3">Base branch</dt>
            <dd
              className="truncate font-mono text-sm text-fg-2"
              title={workspace.baseBranch}
            >
              {workspace.baseBranch}
            </dd>
          </div>
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <FolderGit2
            className="mt-0.5 h-4 w-4 shrink-0 text-fg-3"
            aria-hidden
          />
          <div className="min-w-0">
            <dt className="text-xs text-fg-3">Project</dt>
            <dd className="truncate text-sm text-fg-2">
              {project?.name ?? 'Current project'}
            </dd>
          </div>
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <MapPin
            className="mt-0.5 h-4 w-4 shrink-0 text-fg-3"
            aria-hidden
          />
          <div className="min-w-0">
            <dt className="text-xs text-fg-3">{checkoutLabel}</dt>
            <dd
              className="truncate font-mono text-sm text-fg-2"
              title={workspace.worktreePath ?? undefined}
            >
              {checkoutName}
            </dd>
          </div>
        </div>
        {source ? (
          <div className="flex min-w-0 items-start gap-2">
            <GitPullRequest
              className="mt-0.5 h-4 w-4 shrink-0 text-success"
              aria-hidden
            />
            <div className="min-w-0">
              <dt className="text-xs text-fg-3">Linked source</dt>
              <dd className="truncate text-sm text-fg-2">{source}</dd>
            </div>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function transcriptScrollKey(turns: RenderedTurn[]): string {
  return turns
    .map((turn) => {
      const eventKey = turn.events
        .map((event) => {
          switch (event.kind) {
            case 'text':
              return `text:${event.delta.length}`;
            case 'user_message':
              return `user:${event.text.length}`;
            case 'activity':
              return `activity:${event.title}:${event.detail ?? ''}`;
            case 'tool_use':
              return `tool:${event.name}`;
            case 'file_edit':
              return `edit:${event.path}:${event.op}`;
            case 'todo_update':
              return `todo:${event.todos.length}`;
            case 'error':
              return `error:${event.message.length}`;
            default:
              return event.kind;
          }
        })
        .join(',');
      return `${turn.turnId}:${turn.status}:${eventKey}`;
    })
    .join('|');
}

/** Render one AgentEvent to its card/component. */
function renderEvent(
  event: AgentEvent,
  key: string,
  workspaceId?: string | null,
  toolResult?: unknown,
  onOpenFile?: (path: string) => void,
  onAnswerQuestion?: (answer: string) => void,
  questionDisabled?: boolean,
): React.JSX.Element | null {
  switch (event.kind) {
    case 'user_message':
      return <UserMessage key={key} text={visibleUserText(event.text)} />;
    case 'question_request':
      return (
        <QuestionCard
          key={key}
          questions={event.questions}
          disabled={questionDisabled}
          onSubmit={onAnswerQuestion}
        />
      );
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
      {
        const visibleText = visibleModelText(event.delta);
        if (visibleText.trim() === '') return null;
        const directQuestion = directQuestionFallback(visibleText);
        if (directQuestion) {
          return (
            <QuestionCard
              key={key}
              questions={[{ question: directQuestion }]}
              disabled={questionDisabled}
              onSubmit={onAnswerQuestion}
            />
          );
        }
        const proseQuestions = proseQuestionFallback(visibleText);
        if (proseQuestions) {
          return (
            <div key={key} className="space-y-3">
              <TextMessage delta={visibleText} onOpenFile={onOpenFile} />
              <QuestionCard
                questions={proseQuestions}
                disabled={questionDisabled}
                onSubmit={onAnswerQuestion}
              />
            </div>
          );
        }
      }
      return (
        <TextMessage
          key={key}
          delta={visibleModelText(event.delta)}
          onOpenFile={onOpenFile}
        />
      );
    case 'activity':
      return (
        <ActivityChip key={key} title={event.title} detail={event.detail} />
      );
    case 'tool_use':
      return (
        <ToolCard
          key={key}
          name={event.name}
          payload={event.input}
          result={toolResult}
          onOpenFile={onOpenFile}
        />
      );
    case 'tool_result': {
      // Results are internal agent↔tool protocol traffic. Hide successful results;
      // translate approval failures into the UI the user can actually react to.
      const permission = permissionFromToolResult(event.output);
      return permission ? <PermissionCard key={key} {...permission} /> : null;
    }
    case 'file_edit':
      return (
        <FileEditChip
          key={key}
          path={event.path}
          op={event.op}
          onOpenFile={onOpenFile}
        />
      );
    case 'todo_update':
      return <TodoList key={key} todos={event.todos} />;
    case 'knowledge_proposal':
      return workspaceId ? (
        <KnowledgeProposalCard
          key={key}
          workspaceId={workspaceId}
          projectId={event.projectId}
          count={event.proposalIds.length}
        />
      ) : null;
    case 'knowledge_context':
      return <KnowledgeContextCard key={key} sources={event.sources} />;
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

/**
 * Headless agent CLIs sometimes replace an unavailable interaction tool with this
 * explanatory prefix. Keep the implementation detail out of chat and turn the actual
 * question into the same resumable UI used by native structured question events.
 */
function directQuestionFallback(text: string): string | null {
  const match =
    /(?:AskUserQuestion|request_user_input)\s+(?:isn't|is not)\s+available here,\s*(?:so\s+)?I(?:'ll| will)\s+just ask directly\s*(?:[:—–-]\s*)?([\s\S]+)/i.exec(
      text,
    );
  return match?.[1]?.trim() || null;
}

function cleanQuestionText(text: string): string {
  return text
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recover clickable questions when a model writes a multiple-choice prompt as prose
 * instead of emitting the structured question event. This intentionally requires
 * lettered `(a)` options plus an explicit question, keeping ordinary numbered plans
 * out of the interaction UI.
 */
function proseQuestionFallback(text: string): AgentQuestion[] | null {
  const lines = text.split('\n');
  const questionIndex = lines.findIndex(
    (line) =>
      /\?\s*$/.test(cleanQuestionText(line)) &&
      /what|which|choose|select|outcome/i.test(line),
  );
  if (questionIndex < 0) return null;

  const options: Array<{ label: string; description?: string }> = [];
  let current: { label: string; description: string } | null = null;
  let scopeQuestion = '';

  const flushOption = (): void => {
    if (!current) return;
    options.push({
      label: current.label,
      ...(cleanQuestionText(current.description)
        ? { description: cleanQuestionText(current.description) }
        : {}),
    });
    current = null;
  };

  for (const line of lines.slice(questionIndex + 1)) {
    const cleanedLine = cleanQuestionText(line);
    const option = /^\s*(?:\d+\.\s*)?\(([a-z])\)\s*(.*)$/i.exec(line);
    if (option) {
      flushOption();
      current = {
        label: option[1].toLowerCase(),
        description: option[2],
      };
      continue;
    }
    if (/^scope check\s*:/i.test(cleanedLine)) {
      flushOption();
      scopeQuestion = cleanedLine.replace(/^scope check\s*:\s*/i, '');
      continue;
    }
    if (scopeQuestion) {
      if (!/\btell me\b/i.test(line)) scopeQuestion += ` ${line}`;
      continue;
    }
    if (current && line.trim() !== '' && !/\btell me\b/i.test(line)) {
      current.description += ` ${line}`;
    }
  }
  flushOption();

  if (options.length < 2) return null;
  const questions: AgentQuestion[] = [
    {
      header: 'Outcome',
      question: cleanQuestionText(lines[questionIndex]),
      options,
    },
  ];
  const cleanedScope = cleanQuestionText(scopeQuestion);
  if (cleanedScope.includes('?')) {
    questions.push({
      header: 'Scope',
      question: cleanedScope.slice(0, cleanedScope.indexOf('?') + 1),
    });
  }
  return questions;
}

function isQuestionEvent(event: AgentEvent): boolean {
  return (
    event.kind === 'question_request' ||
    (event.kind === 'text' &&
      (directQuestionFallback(event.delta) !== null ||
        proseQuestionFallback(event.delta) !== null))
  );
}

/**
 * Some harnesses emit clarification requests as ordinary text instead of a structured
 * question event. Inspect only the tail of the final model message so questions quoted
 * inside an otherwise complete plan do not suppress approval.
 */
function endsWithUserResponseRequest(events: AgentEvent[]): boolean {
  const finalText = events
    .slice()
    .reverse()
    .find((event) => event.kind === 'text');
  if (finalText?.kind !== 'text') return false;
  const tail = finalText.delta.trim().slice(-600);
  return (
    /\b(?:tell me|let me know|reply with|respond with)\b/i.test(tail) ||
    /\bplease\s+(?:answer|choose|confirm|clarify|provide|select)\b/i.test(
      tail,
    ) ||
    /\bI need to know\b/i.test(tail)
  );
}

function savedPlanPath(events: AgentEvent[]): string | null {
  for (const event of events.slice().reverse()) {
    if (event.kind !== 'text') continue;
    const match =
      /(?:`|^|\s)(\/[^\s`]*\/\.claude\/plans\/[^\s`]+\.md)(?:`|$|\s)/m.exec(
        event.delta,
      );
    if (match?.[1]) return match[1];
  }
  return null;
}

function PlanReady({
  events,
  onApprove,
  onOpenFile,
}: {
  events: AgentEvent[];
  onApprove: () => void;
  onOpenFile?: (path: string) => void;
}): React.JSX.Element {
  const path = savedPlanPath(events);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!path) return;
    void invoke('plan:read', { path })
      .then((plan) => {
        if (active) setContent(plan.content);
      })
      .catch(() => {
        if (active) setContent(null);
      });
    return () => {
      active = false;
    };
  }, [path]);

  return (
    <div className="space-y-3">
      {path && content ? (
        <section
          className="rounded-3 border border-border-1 bg-surface-panel p-5"
          data-testid="plan-preview"
        >
          <Markdown text={content} onOpenFile={onOpenFile} />
        </section>
      ) : null}
      <PlanApproval onApprove={onApprove} />
    </div>
  );
}

function isActivityEvent(event: AgentEvent): boolean {
  if (event.kind === 'tool_result') {
    return permissionFromToolResult(event.output) === null;
  }
  return (
    event.kind === 'text' ||
    event.kind === 'activity' ||
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
 * Provider metadata is persisted in event order but has no transcript UI of its own.
 * It must not split a continuous model-activity segment when providers emit a fresh
 * context snapshot or model identity between tool calls.
 */
function isActivityMetadata(event: AgentEvent): boolean {
  return event.kind === 'context_usage' || event.kind === 'model_info';
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
    if (isActivityMetadata(event)) return;
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
  onOpenFile?: (path: string) => void,
  onAnswerQuestion?: (answer: string) => void,
  questionDisabled?: boolean,
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
          onOpenFile,
          onAnswerQuestion,
          questionDisabled,
        );
        if (item) rendered.push(item);
      });
      return;
    }

    const latestTextIndex = textIndexes[textIndexes.length - 1];
    const collapsedEvents = segment.filter(
      (_event, index) => index !== latestTextIndex,
    );
    const messageCount = collapsedEvents.filter(
      (event) => event.kind === 'text',
    ).length;
    const toolCount = collapsedEvents.filter(isToolActivity).length;
    const toolNames = collapsedEvents.flatMap((event) => {
      if (event.kind === 'tool_use') return [event.name];
      if (event.kind === 'activity') return [event.title];
      if (event.kind === 'file_edit') return ['Edit'];
      if (event.kind === 'todo_update') return ['TodoWrite'];
      return [];
    });
    const children = segment.flatMap((event, index) => {
      if (index === latestTextIndex) return [];
      const absoluteIndex = start + index;
      const item = renderEvent(
        event,
        `${keyPrefix}-${absoluteIndex}`,
        workspaceId,
        toolResults.get(absoluteIndex),
        onOpenFile,
        onAnswerQuestion,
        questionDisabled,
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

    const latestText = segment[latestTextIndex];
    const absoluteIndex = start + latestTextIndex;
    const item = renderEvent(
      latestText,
      `${keyPrefix}-${absoluteIndex}`,
      workspaceId,
      toolResults.get(absoluteIndex),
      onOpenFile,
      onAnswerQuestion,
      questionDisabled,
    );
    if (item) rendered.push(item);
  }

  events.forEach((event, index) => {
    if (isActivityEvent(event) || isActivityMetadata(event)) return;
    renderActivitySegment(segmentStart, index);
    const item = renderEvent(
      event,
      `${keyPrefix}-${index}`,
      workspaceId,
      toolResults.get(index),
      onOpenFile,
      onAnswerQuestion,
      questionDisabled,
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
  onOpenFile,
  onApprovePlan,
  onAnswerQuestion,
  isBusy = false,
  workspace,
  project,
}: TranscriptProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const scrollKey = transcriptScrollKey(turns);

  // Track whether the user is near the bottom; only auto-scroll when pinned.
  function handleScroll(): void {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottom.current = distanceFromBottom < 40;
  }

  useLayoutEffect(() => {
    if (!pinnedToBottom.current) return;
    const el = containerRef.current;
    if (!el) return;

    const scrollToBottom = (): void => {
      el.scrollTop = el.scrollHeight;
    };

    scrollToBottom();
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [scrollKey]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="scrollbar-bare min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-8"
      data-testid="transcript"
    >
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8">
        {turns.length === 0 && workspace ? (
          <NewChatWorkspaceContext workspace={workspace} project={project} />
        ) : null}
        {turns.map((turn, index) => (
          <div
            key={turn.turnId}
            className="space-y-4"
            data-testid="turn"
            data-status={turn.status}
          >
            <div className="space-y-3">
              {renderEvents(
                turn.events,
                turn.turnId,
                workspaceId,
                onOpenFile,
                index === turns.length - 1 && turn.status !== 'streaming'
                  ? onAnswerQuestion
                  : undefined,
                isBusy || turn.status === 'streaming',
              )}
            </div>
            {index === turns.length - 1 &&
            turn.mode === 'plan' &&
            turn.status === 'completed' &&
            !turn.events.some(isQuestionEvent) &&
            !endsWithUserResponseRequest(turn.events) &&
            turn.events.some(
              (event) => event.kind === 'text' && event.delta.trim() !== '',
            ) &&
            onApprovePlan ? (
              <PlanReady
                events={turn.events}
                onApprove={onApprovePlan}
                onOpenFile={onOpenFile}
              />
            ) : null}
            {turn.status === 'streaming' ? (
              <StreamingElapsed startedAt={turn.startedAt} />
            ) : (
              <TurnDivider
                status={turn.status}
                usage={contextUsage(turn.events) ?? turn.usage}
                model={turn.model}
                costMicros={turn.costMicros}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
