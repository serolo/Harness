import { useEffect } from 'react';
import { CheckCircle2, LoaderCircle, TerminalSquare, XCircle } from 'lucide-react';

import { useWorkspaceCreationStore } from '@renderer/stores/workspaceCreation';

export function WorkspaceCreationTerminal({
  workspaceId,
}: {
  workspaceId: string | null;
}): React.JSX.Element | null {
  const creation = useWorkspaceCreationStore((state) => state.current);
  const clear = useWorkspaceCreationStore((state) => state.clear);

  useEffect(() => {
    if (creation?.status !== 'complete') return;
    const completedRunId = creation.runId;
    const timer = window.setTimeout(() => {
      const current = useWorkspaceCreationStore.getState().current;
      if (
        current?.runId === completedRunId &&
        current.status === 'complete'
      ) {
        clear();
      }
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [clear, creation?.runId, creation?.status]);

  if (
    creation === null ||
    creation.workspaceId === null ||
    creation.workspaceId !== workspaceId
  ) {
    return null;
  }

  const StatusIcon =
    creation.status === 'creating'
      ? LoaderCircle
      : creation.status === 'complete'
        ? CheckCircle2
        : XCircle;

  return (
    <section
      className="mx-4 mb-3 max-h-56 shrink-0 overflow-hidden rounded-3 border border-border-1 bg-[#100d0d] shadow-2"
      data-testid="workspace-creation-terminal"
      aria-live="polite"
    >
      <header className="flex h-9 items-center gap-2 border-b border-white/10 px-3 text-xs text-[#b9b2ad]">
        <TerminalSquare className="h-4 w-4" aria-hidden />
        <span className="font-medium text-[#f3f0eb]">Workspace creation</span>
        <span className="min-w-0 flex-1 truncate">{creation.phase}</span>
        <StatusIcon
          className={`h-4 w-4 ${
            creation.status === 'creating'
              ? 'animate-spin text-accent'
              : creation.status === 'complete'
                ? 'text-ok'
                : 'text-danger'
          }`}
          aria-hidden
        />
        {creation.status !== 'creating' ? (
          <button
            type="button"
            className="text-[#8f8984] hover:text-[#f3f0eb]"
            aria-label="Dismiss workspace creation output"
            onClick={clear}
          >
            ×
          </button>
        ) : null}
      </header>
      <div className="max-h-44 overflow-y-auto px-3 py-2 font-mono text-xs leading-5 text-[#d6d0ca]">
        {creation.lines.length === 0 && creation.error === null ? (
          <div className="text-[#8f8984]">$ {creation.phase}</div>
        ) : (
          creation.lines.map((line, index) => (
            <div key={index} className="whitespace-pre-wrap">
              {line || '\u00a0'}
            </div>
          ))
        )}
        {creation.error ? (
          <div className="whitespace-pre-wrap text-danger">
            {creation.error}
          </div>
        ) : null}
      </div>
    </section>
  );
}
