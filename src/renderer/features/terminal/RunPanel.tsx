// RunPanel — the run-scripts overlay for the selected workspace. Renders a button per
// configured script (icon + label); starting one tails its log live (autoscroll) and shows
// an exit-code/duration badge when it finishes; a Stop button terminates the process tree.
// Data + stream lifecycle live in `useRun`; this component is presentational.

import { useEffect, useRef } from 'react';
import { useRun, type RunView } from './useRun';

export interface RunPanelProps {
  workspaceId: string | null;
}

/** A scrolling log pane that keeps its view pinned to the newest output. */
function RunLog({ log }: { log: string }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <pre
      ref={ref}
      data-testid="run-log"
      className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-xs text-slate-300"
    >
      {log}
    </pre>
  );
}

/** The exit-code/duration badge shown once a run finishes. */
function RunBadge({
  name,
  exit,
}: {
  name: string;
  exit: NonNullable<RunView['exit']>;
}): React.JSX.Element {
  const ok = exit.code === 0;
  return (
    <span
      data-testid={`run-badge-${name}`}
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
        ok ? 'bg-emerald-900 text-emerald-200' : 'bg-red-900 text-red-200'
      }`}
    >
      exit {exit.code ?? 'killed'} · {exit.durationMs}ms
    </span>
  );
}

export function RunPanel({ workspaceId }: RunPanelProps): React.JSX.Element {
  const { scripts, runs, start, stop } = useRun(workspaceId);

  if (!workspaceId) {
    return (
      <div className="p-3 text-xs text-slate-600" data-testid="run-panel-empty">
        Select a workspace to run scripts.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="run-panel">
      {scripts.length === 0 ? (
        <div className="text-xs text-slate-600" data-testid="run-empty">
          No run scripts configured for this workspace.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {scripts.map((script) => {
            const view = runs[script.name];
            const running = view?.status === 'running' || script.running;
            return (
              <div key={script.name} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-md bg-sky-600 px-2.5 py-1 text-sm font-medium text-white enabled:hover:bg-sky-500 disabled:opacity-40"
                    data-testid={`run-start-${script.name}`}
                    disabled={running}
                    onClick={() => void start(script.name)}
                  >
                    {script.icon ? (
                      <span aria-hidden>{script.icon}</span>
                    ) : null}
                    <span>{script.label ?? script.name}</span>
                  </button>
                  {running ? (
                    <button
                      type="button"
                      className="rounded-md bg-red-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-red-500"
                      data-testid={`run-stop-${script.name}`}
                      onClick={() => void stop(script.name)}
                    >
                      Stop
                    </button>
                  ) : null}
                  {view?.exit ? (
                    <RunBadge name={script.name} exit={view.exit} />
                  ) : null}
                </div>
                {view ? <RunLog log={view.log} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
