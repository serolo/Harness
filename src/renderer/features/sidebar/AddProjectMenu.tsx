// Add-project menu: local directory picker + clone-URL form.
//
// Two actions:
//   1. Add local repo  — `project:pickDirectory` → OS folder picker → `project:add`
//   2. Clone URL       — text input for a git URL → `subscribeStream('project:clone', …)`
//                        with a progress bar; on `{ phase: 'done' }` the project is
//                        persisted and selected.
//
// Both actions upsert the resulting Project into the Zustand store and invalidate
// the `['projects']` TanStack query cache so the ProjectSwitcher list re-renders.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CloneProgress } from '@shared/ipc';
import { invoke, subscribeStream } from '@renderer/ipc';
import { useWorkspacesStore } from '@renderer/stores/workspaces';

type Mode = 'idle' | 'clone-form' | 'clone-progress';

export interface AddProjectMenuProps {
  /** Called after a project is successfully added so the parent can close any menus. */
  onDone?: () => void;
}

/**
 * Compact "add project" control offering a local-directory picker and a
 * clone-URL form with a streaming progress bar.
 */
export function AddProjectMenu({
  onDone,
}: AddProjectMenuProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const upsertProject = useWorkspacesStore((s) => s.upsertProject);
  const selectProject = useWorkspacesStore((s) => s.selectProject);

  const [mode, setMode] = useState<Mode>('idle');
  const [cloneUrl, setCloneUrl] = useState('');
  const [progress, setProgress] = useState<CloneProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  // Aborts the in-flight clone stream on unmount so the main-side producer (and its
  // `git clone` child) is torn down rather than leaked (README §6.2 teardown).
  const cloneAbort = useRef<AbortController | null>(null);

  useEffect(() => () => cloneAbort.current?.abort(), []);

  function invalidateProjects(): void {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }

  async function handleAddLocal(): Promise<void> {
    if (isWorking) return;
    setError(null);
    setIsWorking(true);
    try {
      const localPath = await invoke('project:pickDirectory', undefined);
      if (!localPath) return; // user cancelled the OS picker
      const project = await invoke('project:add', { localPath });
      upsertProject(project);
      invalidateProjects();
      onDone?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsWorking(false);
    }
  }

  async function handleCloneSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const url = cloneUrl.trim();
    if (!url || isWorking) return;

    setError(null);
    setIsWorking(true);
    setMode('clone-progress');
    setProgress(null);

    const controller = new AbortController();
    cloneAbort.current = controller;
    try {
      await subscribeStream(
        'project:clone',
        { url },
        (chunk) => {
          setProgress(chunk);
          if (chunk.phase === 'done') {
            upsertProject(chunk.project);
            selectProject(chunk.project.id);
            invalidateProjects();
          }
        },
        { signal: controller.signal },
      );
      onDone?.();
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setMode('clone-form');
    } finally {
      setIsWorking(false);
      cloneAbort.current = null;
    }
  }

  /** Compute the progress bar percent from the latest chunk. */
  function progressPercent(): number {
    if (!progress) return 0;
    if (progress.phase === 'done') return 100;
    return progress.percent;
  }

  /** Human-readable phase label. */
  function phaseLabel(): string {
    if (!progress) return 'Connecting…';
    if (progress.phase === 'done') return 'Done';
    const labels: Record<string, string> = {
      counting: 'Counting objects…',
      compressing: 'Compressing…',
      receiving: 'Receiving objects…',
      resolving: 'Resolving deltas…',
    };
    return labels[progress.phase] ?? progress.phase;
  }

  return (
    <div className="flex flex-col gap-1" data-testid="add-project">
      {mode === 'idle' && (
        <>
          {/* Add local repo */}
          <button
            type="button"
            onClick={() => void handleAddLocal()}
            disabled={isWorking}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
          >
            + Add local repo
          </button>

          {/* Clone URL */}
          <button
            type="button"
            onClick={() => {
              setMode('clone-form');
              setError(null);
            }}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            + Clone URL…
          </button>
        </>
      )}

      {mode === 'clone-form' && (
        <form
          onSubmit={(e) => void handleCloneSubmit(e)}
          className="flex flex-col gap-1.5"
        >
          <input
            type="url"
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
            placeholder="https://github.com/org/repo.git"
            autoFocus
            required
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder-slate-600 focus:border-slate-500 focus:outline-none"
          />
          <div className="flex gap-1">
            <button
              type="submit"
              disabled={!cloneUrl.trim()}
              className="flex-1 rounded bg-slate-700 px-2 py-1 text-xs font-medium text-slate-100 hover:bg-slate-600 disabled:opacity-50"
            >
              Clone
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('idle');
                setCloneUrl('');
                setError(null);
              }}
              className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'clone-progress' && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-slate-400">{phaseLabel()}</p>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-slate-400 transition-all"
              style={{ width: `${progressPercent()}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
