// CheckpointTimeline — per-turn checkpoints (`checkpoint:list`), each with a "Revert to
// here" action gated behind a confirm dialog. The dialog is the user's safety gate for
// a destructive op (plan Task 11 gotcha) — its copy explicitly states: the worktree is
// reset to that checkpoint, files added since are removed, the current state is
// auto-backed-up first, later chat turns are truncated, and the next turn starts a
// fresh session. The shared Dialog portal keeps the safety gate above every app pane.

import { useState } from 'react';
import { Button, Dialog } from '@renderer/components/ui';
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
    <div className="border-t border-border-1" data-testid="checkpoint-timeline">
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-2">
        <span className="shrink-0 text-xs font-medium uppercase tracking-caps text-fg-3">
          Checkpoints
        </span>
        {checkpoints.length === 0 ? (
          <span className="text-xs text-fg-3">None yet.</span>
        ) : (
          checkpoints.map((cp) => {
            const turnIdx = turnIdxFromRefName(cp.refName);
            return (
              <div
                key={cp.id}
                data-testid={`checkpoint-${turnIdx}`}
                className="flex shrink-0 items-center gap-1.5 rounded-2 border border-border-1 bg-surface-card px-2 py-1 text-xs"
              >
                <span className="font-mono text-fg-2">#{turnIdx}</span>
                <span className="font-mono text-fg-3">
                  {cp.sha.slice(0, 7)}
                </span>
                <Button
                  size="sm"
                  data-testid={`checkpoint-revert-${turnIdx}`}
                  onClick={() => setConfirmTarget(cp)}
                >
                  Revert to here
                </Button>
              </div>
            );
          })
        )}
      </div>

      {confirmTarget ? (
        <Dialog
          title={`Revert to checkpoint #${turnIdxFromRefName(confirmTarget.refName)}?`}
          onClose={() => !reverting && setConfirmTarget(null)}
          data-testid="checkpoint-revert-dialog"
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setConfirmTarget(null)}
                disabled={reverting}
                data-testid="checkpoint-revert-cancel"
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => void confirmRevert()}
                disabled={reverting}
                data-testid="checkpoint-revert-confirm"
              >
                {reverting ? 'Reverting…' : 'Revert'}
              </Button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-fg-2">
            This resets the worktree to this checkpoint — files added since will
            be removed. Your current state is automatically backed up first.
            Chat turns after this point will be truncated, and the next turn
            starts a fresh session.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}
