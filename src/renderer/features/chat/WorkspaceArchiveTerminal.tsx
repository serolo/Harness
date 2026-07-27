import { Archive, CheckCircle2, LoaderCircle, XCircle } from 'lucide-react';

import { useWorkspaceArchiveStore } from '@renderer/stores/workspaceArchive';

export function WorkspaceArchiveTerminal({
  workspaceId,
}: {
  workspaceId: string;
}): React.JSX.Element | null {
  const archive = useWorkspaceArchiveStore((state) => state.current);
  const clear = useWorkspaceArchiveStore((state) => state.clear);
  if (archive === null || archive.workspaceId !== workspaceId) return null;

  const StatusIcon =
    archive.status === 'running'
      ? LoaderCircle
      : archive.status === 'complete'
        ? CheckCircle2
        : XCircle;

  return (
    <section
      className="mx-4 mb-3 max-h-56 shrink-0 overflow-hidden rounded-3 border border-border-1 bg-[#100d0d] shadow-2"
      data-testid="workspace-archive-terminal"
      aria-live="polite"
    >
      <header className="flex h-9 items-center gap-2 border-b border-white/10 px-3 text-xs text-[#b9b2ad]">
        <Archive className="h-4 w-4" aria-hidden />
        <span className="font-medium text-[#f3f0eb]">
          Archiving {archive.workspaceName}
        </span>
        <span className="min-w-0 flex-1 truncate">{archive.phase}</span>
        <StatusIcon
          className={`h-4 w-4 ${
            archive.status === 'running'
              ? 'animate-spin text-accent'
              : archive.status === 'complete'
                ? 'text-ok'
                : 'text-danger'
          }`}
          aria-hidden
        />
        {archive.status !== 'running' ? (
          <button
            type="button"
            className="text-[#8f8984] hover:text-[#f3f0eb]"
            aria-label="Dismiss archive output"
            onClick={clear}
          >
            ×
          </button>
        ) : null}
      </header>
      <div className="max-h-44 overflow-y-auto px-3 py-2 font-mono text-xs leading-5 text-[#d6d0ca]">
        {archive.lines.length === 0 && archive.error === null ? (
          <div className="text-[#8f8984]">$ {archive.phase}</div>
        ) : (
          archive.lines.map((line, index) => (
            <div key={index} className="whitespace-pre-wrap">
              {line || '\u00a0'}
            </div>
          ))
        )}
        {archive.error ? (
          <div className="whitespace-pre-wrap text-danger">{archive.error}</div>
        ) : null}
      </div>
    </section>
  );
}
