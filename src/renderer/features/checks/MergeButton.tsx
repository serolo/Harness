// MergeButton — the merge-method selector (`merge`/`squash`/`rebase`) + Merge action at
// the bottom of the Checks panel. Disabled whenever the roll-up isn't mergeable (state !==
// 'green' or a blocker exists) — the server ALSO gates the merge, so this only mirrors the
// gate for the UI. On a successful merge it surfaces the post-merge "archive this
// workspace" suggestion. Purely presentational apart from its own local method/merged state.

import { useState } from 'react';
import type { MergeMethod } from '@shared/github';

const METHODS: MergeMethod[] = ['merge', 'squash', 'rebase'];

export interface MergeButtonProps {
  /** Disabled when the roll-up isn't green / a blocker exists (mirrors the server gate). */
  disabled: boolean;
  /** Default method (from `settings.git.mergeStrategy`, falls back to `squash`). */
  defaultMethod?: MergeMethod;
  /** Perform the merge with the selected strategy; resolves when the merge succeeds. */
  onMerge: (method: MergeMethod) => Promise<void>;
}

export function MergeButton({
  disabled,
  defaultMethod = 'squash',
  onMerge,
}: MergeButtonProps): React.JSX.Element {
  const [method, setMethod] = useState<MergeMethod>(defaultMethod);
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(false);

  async function handleMerge(): Promise<void> {
    setMerging(true);
    try {
      await onMerge(method);
      setMerged(true);
    } catch {
      // The error surfaces through the panel's roll-up refetch; keep the button usable.
    } finally {
      setMerging(false);
    }
  }

  if (merged) {
    return (
      <div
        className="border-t border-slate-800 px-3 py-2 text-xs text-emerald-400"
        data-testid="merge-success"
      >
        Merged. You can now archive this workspace.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-t border-slate-800 px-3 py-2">
      <select
        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
        value={method}
        disabled={disabled || merging}
        data-testid="merge-method"
        onChange={(e) => setMethod(e.target.value as MergeMethod)}
      >
        {METHODS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="flex-1 rounded-md bg-emerald-700 px-3 py-1 text-xs font-medium text-emerald-50 hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
        disabled={disabled || merging}
        data-testid="merge-button"
        onClick={() => void handleMerge()}
      >
        {merging ? 'Merging…' : 'Merge'}
      </button>
    </div>
  );
}
