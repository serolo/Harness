import { useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileText,
} from 'lucide-react';

function sourceLocation(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? 'Project knowledge root' : path.slice(0, separator);
}

function sourceFileName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export function KnowledgeContextCard({
  sources,
}: {
  sources: {
    path: string;
    title: string;
    estimatedTokens?: number;
  }[];
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  const estimatedTokenTotal = sources.reduce(
    (total, source) => total + (source.estimatedTokens ?? 0),
    0,
  );
  const hasTokenEstimate = sources.some(
    (source) => source.estimatedTokens !== undefined,
  );

  return (
    <div className="text-sm text-fg-2" data-testid="knowledge-context-card">
      <button
        type="button"
        className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-bg-2"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <BookOpen size={14} />
        <span>Knowledge used ({sources.length})</span>
        {hasTokenEstimate ? (
          <span className="text-xs tabular-nums text-fg-3">
            · ~{estimatedTokenTotal.toLocaleString()} tokens
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="ml-8 mt-2 max-w-2xl rounded-3 border border-border-1 bg-surface-card">
          <div className="border-b border-border-1 px-3 py-2">
            <div className="text-xs font-medium text-fg-1">
              Included in this turn&apos;s context
            </div>
            <p className="mt-0.5 text-xs leading-5 text-fg-3">
              Harness selected these project knowledge files before sending
              your message to the agent.
            </p>
            {hasTokenEstimate ? (
              <p className="mt-1 text-[11px] leading-4 text-fg-3">
                Token counts are estimates based on approximately four
                characters per token; actual usage varies by model.
              </p>
            ) : null}
          </div>
          <ol className="divide-y divide-border-1">
            {sources.map((source, index) => (
              <li
                key={source.path}
                className="flex min-w-0 items-start gap-2.5 px-3 py-2.5"
              >
                <FileText
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-fg-3"
                  size={14}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-fg-3">
                      Source {index + 1}
                    </span>
                    <span className="truncate text-xs font-medium text-fg-1">
                      {source.title}
                    </span>
                    {source.estimatedTokens !== undefined ? (
                      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-fg-2">
                        ~{source.estimatedTokens.toLocaleString()} tokens
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-fg-3">
                    <span className="truncate" title={sourceLocation(source.path)}>
                      {sourceLocation(source.path)}
                    </span>
                    <span aria-hidden="true">/</span>
                    <span
                      className="shrink-0 text-fg-2"
                      title={source.path}
                    >
                      {sourceFileName(source.path)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
