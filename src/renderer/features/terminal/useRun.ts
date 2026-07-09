// useRun — the run-scripts data hook for one workspace. Lists the configured scripts
// (`run:list`), starts one over the `run:start` stream (capturing its `runId` from the
// leading `started` frame, tailing `log` frames, and reading the terminal `exit` frame),
// and stops it (`run:stop`). Mirrors `useChat`'s AbortController discipline: every stream
// is aborted on unmount / workspace change so no listener leaks. All main access funnels
// through `@renderer/ipc` — never `window.api` (README §10).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunScriptInfo } from '@shared/ipc';
import { invoke, subscribeStream } from '@renderer/ipc';

/** The live view of a single run: its status, accumulated log, and terminal result. */
export interface RunView {
  status: 'running' | 'exited';
  runId?: string;
  log: string;
  exit?: { code: number | null; durationMs: number };
}

export interface UseRun {
  /** Configured run scripts (from `run:list`). */
  scripts: RunScriptInfo[];
  /** Live run state keyed by script name (present once started). */
  runs: Record<string, RunView>;
  /** Start a script's stream (replaces any prior run of the same script). */
  start: (name: string) => Promise<void>;
  /** Stop a running script (terminates its process tree in main) + aborts the stream. */
  stop: (name: string) => Promise<void>;
  /** Re-fetch the script list + running state. */
  refresh: () => Promise<void>;
}

/**
 * Run-script state + actions for one workspace. Loads the script list on mount / workspace
 * change; `start` streams a run and `stop` terminates it. Streams are aborted on unmount /
 * workspace change so subscriptions don't leak across workspaces.
 */
export function useRun(workspaceId: string | null): UseRun {
  const [scripts, setScripts] = useState<RunScriptInfo[]>([]);
  const [runs, setRuns] = useState<Record<string, RunView>>({});
  // One AbortController per running script, so `stop`/unmount can tear down the stream.
  const controllers = useRef<Record<string, AbortController>>({});

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    try {
      const list = await invoke('run:list', { workspaceId });
      setScripts(list);
    } catch {
      /* surfaced elsewhere; an empty/unchanged list is a safe fallback */
    }
  }, [workspaceId]);

  // Load scripts on open / workspace change; abort any in-flight streams on teardown.
  useEffect(() => {
    if (!workspaceId) {
      setScripts([]);
      setRuns({});
      return;
    }
    setRuns({});
    void refresh();
    const active = controllers.current;
    return () => {
      for (const controller of Object.values(active)) controller.abort();
      controllers.current = {};
    };
  }, [workspaceId, refresh]);

  const start = useCallback(
    async (name: string): Promise<void> => {
      if (!workspaceId) return;
      // Replace any prior run of this script (its stream, if any, is torn down here).
      controllers.current[name]?.abort();
      const controller = new AbortController();
      controllers.current[name] = controller;
      setRuns((prev) => ({
        ...prev,
        [name]: { status: 'running', log: '' },
      }));
      try {
        await subscribeStream(
          'run:start',
          { workspaceId, scriptName: name },
          (chunk) => {
            setRuns((prev) => {
              const view = prev[name] ?? { status: 'running', log: '' };
              if (chunk.kind === 'started') {
                return { ...prev, [name]: { ...view, runId: chunk.runId } };
              }
              if (chunk.kind === 'log') {
                return {
                  ...prev,
                  [name]: { ...view, log: view.log + chunk.chunk },
                };
              }
              return {
                ...prev,
                [name]: {
                  ...view,
                  status: 'exited',
                  exit: { code: chunk.code, durationMs: chunk.durationMs },
                },
              };
            });
          },
          { signal: controller.signal },
        );
      } catch (err) {
        // Stream-level failure: mark the run exited and note the reason in its log.
        const message = err instanceof Error ? err.message : 'run failed';
        setRuns((prev) => {
          const view = prev[name] ?? { status: 'running', log: '' };
          return {
            ...prev,
            [name]: {
              ...view,
              status: 'exited',
              log: `${view.log}\n[run failed: ${message}]`,
            },
          };
        });
      } finally {
        if (controllers.current[name] === controller) {
          delete controllers.current[name];
        }
        void refresh();
      }
    },
    [workspaceId, refresh],
  );

  const stop = useCallback(
    async (name: string): Promise<void> => {
      if (!workspaceId) return;
      const runId = runs[name]?.runId;
      if (runId) {
        try {
          await invoke('run:stop', { workspaceId, runId });
        } catch {
          /* the stream's exit/abort path still finalizes the UI */
        }
      }
      controllers.current[name]?.abort();
    },
    [workspaceId, runs],
  );

  return { scripts, runs, start, stop, refresh };
}
