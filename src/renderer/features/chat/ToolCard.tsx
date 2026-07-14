// Dense, semantic disclosure for tool activity. The collapsed row keeps the useful
// action and target visible; expanding it reveals the full input and paired output.

import { useState } from 'react';
import {
  Braces,
  FilePenLine,
  FileSearch,
  FileText,
  Globe2,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';

export interface ToolCardProps {
  name: string;
  payload: unknown;
  result?: unknown;
}

type ToolKind =
  'command' | 'read' | 'search' | 'web' | 'edit' | 'code' | 'generic';

interface ToolPresentation {
  kind: ToolKind;
  label: string;
  preview?: string;
  previewTitle?: string;
  command?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function numberValue(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function humanizeName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (character) => character.toUpperCase());
}

function toolPresentation(name: string, payload: unknown): ToolPresentation {
  const input = asRecord(payload);
  const normalized = name.toLowerCase();
  const command = stringValue(input, 'command', 'cmd');
  const description = stringValue(input, 'description');
  const path = stringValue(input, 'file_path', 'path', 'notebook_path');

  if (
    normalized === 'bash' ||
    normalized === 'shell' ||
    normalized === 'command_execution' ||
    command
  ) {
    return {
      kind: 'command',
      label:
        description ??
        (normalized === 'command_execution' ? 'Bash' : humanizeName(name)),
      preview: command,
      previewTitle: command,
      command,
    };
  }

  if (normalized === 'read' || normalized.includes('read_file')) {
    const limit = numberValue(input, 'limit');
    return {
      kind: 'read',
      label: limit ? `Read ${limit} lines` : 'Read file',
      preview: path ? fileName(path) : undefined,
      previewTitle: path,
    };
  }

  if (normalized.includes('web') || normalized.includes('fetch')) {
    const query = stringValue(input, 'query', 'url');
    return {
      kind: 'web',
      label: description ?? humanizeName(name),
      preview: query,
      previewTitle: query,
    };
  }

  if (
    normalized === 'grep' ||
    normalized === 'glob' ||
    normalized.includes('search') ||
    normalized === 'find'
  ) {
    const query = stringValue(input, 'pattern', 'query', 'glob');
    return {
      kind: 'search',
      label: description ?? (normalized === 'glob' ? 'Find files' : 'Search'),
      preview: query ?? path,
      previewTitle: query ?? path,
    };
  }

  if (
    normalized.includes('edit') ||
    normalized.includes('write') ||
    normalized.includes('patch')
  ) {
    return {
      kind: 'edit',
      label: description ?? humanizeName(name),
      preview: path ? fileName(path) : undefined,
      previewTitle: path,
    };
  }

  if (normalized.includes('code') || normalized.includes('script')) {
    return {
      kind: 'code',
      label: description ?? humanizeName(name),
      preview: path ? fileName(path) : undefined,
      previewTitle: path,
    };
  }

  const fallback =
    typeof payload === 'string'
      ? payload
      : stringValue(input, 'query', 'pattern', 'path', 'file_path');
  return {
    kind: 'generic',
    label: description ?? humanizeName(name),
    preview: fallback,
    previewTitle: fallback,
  };
}

/** Icon shared by individual tool rows and the aggregate activity summary. */
export function ToolIcon({
  name,
  className = 'h-4 w-4',
}: {
  name: string;
  className?: string;
}): React.JSX.Element {
  const kind = toolPresentation(name, undefined).kind;
  const props = { className, 'aria-hidden': true as const };
  switch (kind) {
    case 'command':
      return <Terminal {...props} />;
    case 'read':
      return <FileText {...props} />;
    case 'search':
      return <Search {...props} />;
    case 'web':
      return <Globe2 {...props} />;
    case 'edit':
      return <FilePenLine {...props} />;
    case 'code':
      return <Braces {...props} />;
    default:
      return normalizedFileTool(name) ? (
        <FileSearch {...props} />
      ) : (
        <Wrench {...props} />
      );
  }
}

function normalizedFileTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.includes('file') || normalized.includes('path');
}

function formatPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function DetailBody({
  presentation,
  payload,
  result,
}: {
  presentation: ToolPresentation;
  payload: unknown;
  result?: unknown;
}): React.JSX.Element {
  if (presentation.command) {
    return (
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-3 border border-border-2 bg-surface-well p-3 font-mono text-sm leading-6 text-fg-1">
        <code>
          <span className="text-fg-3">$ </span>
          {presentation.command}
          {result !== undefined ? `\n\n${formatPayload(result)}` : ''}
        </code>
      </pre>
    );
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 text-2xs font-medium uppercase tracking-caps text-fg-3">
          Input
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-3 border border-border-2 bg-surface-well p-3 font-mono text-sm leading-6 text-fg-1">
          <code>{formatPayload(payload)}</code>
        </pre>
      </div>
      {result !== undefined && (
        <div>
          <div className="mb-1 text-2xs font-medium uppercase tracking-caps text-fg-3">
            Output
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-3 border border-border-2 bg-surface-well p-3 font-mono text-sm leading-6 text-fg-1">
            <code>{formatPayload(result)}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

export function ToolCard({
  name,
  payload,
  result,
}: ToolCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const presentation = toolPresentation(name, payload);

  return (
    <div
      className="min-w-0"
      data-testid="tool-card"
      data-tool-kind={presentation.kind}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`flex min-h-8 w-full min-w-0 items-center gap-2 rounded-2 px-1.5 text-left text-base transition-colors duration-fast ease-out hover:bg-bg-3 ${open ? 'bg-bg-3 text-fg-1' : 'text-fg-2'}`}
        aria-expanded={open}
      >
        <ToolIcon name={name} className="h-4 w-4 shrink-0 text-fg-3" />
        <span className="max-w-[45%] shrink-0 truncate font-medium text-fg-1">
          {presentation.label}
        </span>
        {presentation.preview && (
          <code
            className="min-w-0 flex-1 truncate rounded-1 bg-bg-3 px-2 py-0.5 font-mono text-sm text-fg-2"
            title={presentation.previewTitle}
          >
            {presentation.preview}
          </code>
        )}
      </button>
      {open && (
        <div className="ml-6 mt-2" data-testid="tool-card-detail">
          <DetailBody
            presentation={presentation}
            payload={payload}
            result={result}
          />
        </div>
      )}
    </div>
  );
}
