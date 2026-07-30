import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Search,
} from 'lucide-react';

import type {
  AgentMemoryDiscovery,
  AgentMemoryProvider,
  AgentMemorySource,
} from '@shared/knowledge';
import { Button } from '@renderer/components/ui';
import { invoke } from '@renderer/ipc';

const PROVIDER_LABELS: Record<AgentMemoryProvider, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
};

const EXCLUSION_LABELS: Record<
  NonNullable<AgentMemorySource['exclusionReason']>,
  string
> = {
  binary: 'Binary file',
  secret_detected: 'Possible secret detected',
  too_large: 'File is too large',
  unsupported: 'Unsupported format',
  unreadable: 'File could not be read',
};

export function AgentMemoryImport({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element {
  const [provider, setProvider] = useState<AgentMemoryProvider>('claude_code');
  const [discovery, setDiscovery] = useState<AgentMemoryDiscovery | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [discovering, setDiscovering] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setDiscovery(null);
    setSelectedIds(new Set());
    setExpandedIds(new Set());
    setError(null);
    setSuccess(null);
  }, [projectId, provider]);

  const discover = async (): Promise<void> => {
    setDiscovering(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await invoke('knowledge:discoverAgentMemory', {
        projectId,
        provider,
      });
      setDiscovery(result);
      setSelectedIds(
        new Set(
          result.sources
            .filter((source) => source.eligible)
            .map((source) => source.id),
        ),
      );
      setExpandedIds(new Set());
    } catch (reason) {
      setDiscovery(null);
      setSelectedIds(new Set());
      setError(errorMessage(reason));
    } finally {
      setDiscovering(false);
    }
  };

  const createProposal = async (): Promise<void> => {
    if (discovery === null || selectedIds.size === 0) return;
    setCreating(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await invoke('knowledge:createAgentMemoryProposal', {
        projectId,
        provider,
        discoveryId: discovery.discoveryId,
        sourceIds: [...selectedIds],
      });
      setSuccess(
        result.proposal
          ? `Review proposal created with ${result.operationCount} wiki ${
              result.operationCount === 1 ? 'change' : 'changes'
            }.`
          : 'No wiki changes were needed for the selected sources.',
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCreating(false);
    }
  };

  const toggleSelected = (sourceId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
    setSuccess(null);
  };

  const toggleExpanded = (sourceId: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  return (
    <section
      className="mt-3 rounded-2 border border-border-1 bg-surface-panel"
      aria-labelledby="agent-memory-import-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border-1 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3
            id="agent-memory-import-title"
            className="text-sm font-medium text-fg-1"
          >
            Import agent memory
          </h3>
          <p className="mt-0.5 max-w-2xl text-xs text-fg-3">
            Find project instructions and choose a provider memory folder, then
            send only your selections to the wiki review queue.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-2xs font-medium uppercase tracking-caps text-fg-3">
            Provider
            <select
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as AgentMemoryProvider)
              }
              disabled={discovering || creating}
              className="mt-1 block h-control rounded-2 border border-border-1 bg-bg-3 px-2.5 text-xs font-normal normal-case tracking-normal text-fg-1"
              aria-label="Agent memory provider"
            >
              <option value="claude_code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <Button
            variant="secondary"
            size="sm"
            disabled={discovering || creating}
            onClick={() => void discover()}
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            {discovering ? 'Discovering…' : 'Choose & discover'}
          </Button>
        </div>
      </div>

      <div className="px-4 py-3">
        {error ? (
          <div
            role="alert"
            className="mb-3 rounded-2 border border-danger bg-danger-muted px-3 py-2 text-xs text-danger"
          >
            {error}
          </div>
        ) : null}
        {success ? (
          <div
            role="status"
            className="mb-3 flex items-center gap-2 rounded-2 border border-ok bg-ok-muted px-3 py-2 text-xs text-fg-1"
          >
            <CheckCircle2
              className="h-3.5 w-3.5 shrink-0 text-ok"
              aria-hidden
            />
            {success}
          </div>
        ) : null}

        {discovery === null ? (
          <p className="py-2 text-xs text-fg-3">
            Choose a provider, then select its project memory folder. Nothing is
            read until you start discovery.
          </p>
        ) : discovery.sources.length === 0 ? (
          <p className="py-2 text-xs text-fg-3" role="status">
            No {PROVIDER_LABELS[provider]} memory sources were found for this
            project.
          </p>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs text-fg-3" role="status">
                {discovery.eligibleCount} eligible · {discovery.excludedCount}{' '}
                excluded
              </p>
              <span className="text-2xs text-fg-3">
                {selectedIds.size} selected
              </span>
            </div>
            <ul className="divide-y divide-border-1 border-y border-border-1">
              {discovery.sources.map((source) => {
                const expanded = expandedIds.has(source.id);
                const hasPreview = Boolean(source.preview);
                const isAtomicClaudeBundle =
                  provider === 'claude_code' &&
                  source.kind === 'provider_memory' &&
                  source.eligible;
                return (
                  <li key={source.id} className="py-2.5">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(source.id)}
                        disabled={
                          !source.eligible || creating || isAtomicClaudeBundle
                        }
                        onChange={() => toggleSelected(source.id)}
                        aria-label={`Include ${source.label}`}
                        className="mt-1 h-3.5 w-3.5 accent-accent"
                      />
                      <FileText
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-3"
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-fg-1">
                              {source.label}
                            </div>
                            <div
                              className="truncate font-mono text-2xs text-fg-3"
                              title={source.displayPath}
                            >
                              {source.displayPath}
                            </div>
                          </div>
                          {hasPreview ? (
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => toggleExpanded(source.id)}
                              className="flex shrink-0 items-center gap-1 rounded-1 px-1.5 py-1 text-2xs text-fg-2 hover:bg-bg-3 hover:text-fg-1"
                            >
                              {expanded ? (
                                <ChevronDown className="h-3 w-3" aria-hidden />
                              ) : (
                                <ChevronRight className="h-3 w-3" aria-hidden />
                              )}
                              Preview
                            </button>
                          ) : null}
                        </div>
                        {!source.eligible ? (
                          <p className="mt-1 text-2xs text-warn">
                            Excluded:{' '}
                            {source.exclusionReason
                              ? EXCLUSION_LABELS[source.exclusionReason]
                              : 'Not eligible for import'}
                          </p>
                        ) : null}
                        {isAtomicClaudeBundle ? (
                          <p className="mt-1 text-2xs text-fg-3">
                            Imported with the complete Claude memory bundle to
                            preserve wiki links.
                          </p>
                        ) : null}
                        {expanded && source.preview ? (
                          <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-2 bg-bg-2 p-2.5 font-mono text-2xs text-fg-2">
                            {source.preview}
                          </pre>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex items-center justify-between gap-4">
              <p className="max-w-xl text-2xs text-fg-3">
                A proposal is created for human review. Selected memory never
                becomes canonical automatically.
              </p>
              <Button
                variant="primary"
                size="sm"
                disabled={selectedIds.size === 0 || creating || discovering}
                onClick={() => void createProposal()}
              >
                {creating ? 'Creating proposal…' : 'Create review proposal'}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
