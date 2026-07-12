import { useEffect, useMemo, useState } from 'react';
import { Brain, Clock, FileText } from 'lucide-react';
import type { AgentEvent, Usage } from '@shared/harness';
import type { TurnStatus } from '@shared/models';

export interface TurnActivityProps {
  prompt?: string;
  status: TurnStatus;
  events: AgentEvent[];
  startedAt: number;
  endedAt?: number;
  usage?: Usage;
}

const STATUS_LABEL: Record<TurnStatus, string> = {
  streaming: 'Thinking',
  completed: 'Completed',
  interrupted: 'Interrupted',
  error: 'Error',
};

const STATUS_CLASS: Record<TurnStatus, string> = {
  streaming: 'text-fg-1',
  completed: 'text-ok',
  interrupted: 'text-fg-3',
  error: 'text-danger',
};

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function compact(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['description', 'cmd', 'command', 'path', 'file']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
  }
  return null;
}

function latestActivity(events: AgentEvent[]): {
  title: string;
  detail: string | null;
} {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === 'tool_use') {
      const detail = compact(event.input);
      if (
        event.name.toLowerCase().includes('diff') ||
        detail?.toLowerCase().includes('diff')
      ) {
        return { title: 'Workspace diff', detail: 'Full diff' };
      }
      return { title: event.name, detail };
    }
    if (event.kind === 'file_edit') {
      return { title: 'Editing files', detail: `${event.op} ${event.path}` };
    }
    if (event.kind === 'todo_update') {
      return { title: 'Updating todos', detail: null };
    }
    if (event.kind === 'text') {
      return { title: 'Responding', detail: null };
    }
    if (event.kind === 'error') {
      return { title: 'Error', detail: event.message };
    }
  }
  return {
    title: 'Thinking',
    detail: 'Understanding the request and planning the next step',
  };
}

function tokensLabel(usage: Usage | undefined): string | null {
  if (!usage || (usage.inputTokens == null && usage.outputTokens == null)) return null;
  return `${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out`;
}

export function TurnActivity({
  prompt,
  status,
  events,
  startedAt,
  endedAt,
  usage,
}: TurnActivityProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const activity = useMemo(() => latestActivity(events), [events]);
  const tokens = tokensLabel(usage);

  useEffect(() => {
    if (status !== 'streaming') return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [status]);

  const elapsed = elapsedLabel((endedAt ?? now) - startedAt);

  return (
    <div className="space-y-4" data-testid="turn-activity" data-status={status}>
      {prompt && (
        <div className="flex justify-start">
          <div
            className="max-w-[72%] rounded-4 bg-surface-card px-3 py-2 text-base leading-6 text-fg-1"
            data-testid="turn-prompt"
          >
            {prompt}
          </div>
        </div>
      )}

      <div className="flex min-w-0 items-center gap-3">
        <Brain className="h-4 w-4 shrink-0 text-fg-3" aria-hidden />
        <span className={`shrink-0 text-base font-medium ${STATUS_CLASS[status]}`}>
          {STATUS_LABEL[status]}
        </span>
        <span className="min-w-0 truncate bg-bg-3 px-2 py-0.5 font-mono text-sm text-fg-3">
          {activity.detail ?? activity.title}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-3 text-fg-3">
        <FileText className="h-4 w-4 shrink-0" aria-hidden />
        <span className="text-base text-fg-1">{activity.title}</span>
        {activity.detail && (
          <span className="min-w-0 truncate font-mono text-sm">
            {activity.detail}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 text-sm text-fg-3">
        <Clock className="h-4 w-4" aria-hidden />
        <span data-testid="turn-elapsed">{elapsed}</span>
        {tokens && (
          <>
            <span>·</span>
            <span className="uppercase tracking-caps">{tokens}</span>
          </>
        )}
      </div>
    </div>
  );
}
