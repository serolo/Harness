// CheckpointTimeline — per-turn checkpoints (`checkpoint:list`), each with a "Revert to
// here" action gated behind a confirm dialog. The dialog is the user's safety gate for
// a destructive op (plan Task 11 gotcha) — its copy explicitly states: the worktree is
// reset to that checkpoint, files added since are removed, the current state is
// auto-backed-up first, later chat turns are truncated, and the next turn starts a
// fresh session. Plain React modal (no @radix-ui/react-dialog in this project) —
// mirrors `NewWorkspaceDialog`'s fixed-overlay + centered-panel pattern.

import { useState } from 'react';
import type { Checkpoint } from '@shared/review';

export interface CheckpointTimelineProps {
  checkpoints: Checkpoint[];
  onRevert: (turnIdx: number) => void | Promise<void>;
}

/** `refs/checkpoints/<workspace>/<turn-idx>` → the trailing turn index. */
function turnIdxFromRefName(refName: string): number {
  const match = /\/(\d+)$/.exec(refName);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function CheckpointTimeline({
  checkpoints,
  onRevert,
}: CheckpointTimelineProps): React.JSX.Element {
  const [confirmTarget, setConfirmTarget] = useState<Checkpoint | null>(null);
  const [reverting, setReverting] = useState(false);

  async function confirmRevert(): Promise<void> {
    if (!confirmTarget) return;
    setReverting(true);
    try {
      await onRevert(turnIdxFromRefName(confirmTarget.refName));
      setConfirmTarget(null);
    } finally {
      setReverting(false);
    }
  }

  return (
    <div
      className="border-t border-slate-800"
      data-testid="checkpoint-timeline"
    >
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-2">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Checkpoints
        </span>
        {checkpoints.length === 0 ? (
          <span className="text-xs text-slate-600">None yet.</span>
        ) : (
          checkpoints.map((cp) => {
            const turnIdx = turnIdxFromRefName(cp.refName);
            return (
              <div
                key={cp.id}
                data-testid={`checkpoint-${turnIdx}`}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1 text-xs"
              >
                <span className="font-mono text-slate-400">#{turnIdx}</span>
                <span className="font-mono text-slate-600">
                  {cp.sha.slice(0, 7)}
                </span>
                <button
                  type="button"
                  className="rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
                  data-testid={`checkpoint-revert-${turnIdx}`}
                  onClick={() => setConfirmTarget(cp)}
                >
                  Revert to here
                </button>
              </div>
            );
          })
        )}
      </div>

      {confirmTarget && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60"
            aria-hidden="true"
            onClick={() => !reverting && setConfirmTarget(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Revert to checkpoint"
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            data-testid="checkpoint-revert-dialog"
          >
            <div
              className="relative w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="mb-2 text-sm font-semibold text-slate-100">
                Revert to checkpoint #
                {turnIdxFromRefName(confirmTarget.refName)}?
              </h2>
              <p className="mb-3 text-xs leading-relaxed text-slate-300">
                This resets the worktree to this checkpoint — files added since
                will be removed. Your current state is automatically backed up
                first. Chat turns after this point will be truncated, and the
                next turn starts a fresh session.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => setConfirmTarget(null)}
                  disabled={reverting}
                  data-testid="checkpoint-revert-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void confirmRevert()}
                  disabled={reverting}
                  data-testid="checkpoint-revert-confirm"
                >
                  {reverting ? 'Reverting…' : 'Revert'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
