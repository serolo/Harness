// MergeButton — the merge-method selector (`merge`/`squash`/`rebase`) + Merge action at
// the bottom of the Checks panel. Disabled whenever the roll-up isn't mergeable (state !==
// 'green' or a blocker exists) — the server ALSO gates the merge, so this only mirrors the
// gate for the UI. On a successful merge it surfaces the post-merge "archive this
// workspace" suggestion. Purely presentational apart from its own local method/merged state.

import { useState } from 'react';
import type { MergeMethod } from '@shared/github';
import { Button, Select } from '@renderer/components/ui';

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
        className="border-t border-border-1 px-3 py-2 text-xs text-ok"
        data-testid="merge-success"
      >
        Merged. You can now archive this workspace.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-t border-border-1 px-3 py-2">
      <Select
        options={METHODS.map((m) => ({ value: m, label: m }))}
        value={method}
        disabled={disabled || merging}
        data-testid="merge-method"
        onChange={(e) => setMethod(e.target.value as MergeMethod)}
      />
      <Button
        variant="primary"
        size="sm"
        className="flex-1"
        disabled={disabled || merging}
        data-testid="merge-button"
        onClick={() => void handleMerge()}
      >
        {merging ? 'Merging…' : 'Merge'}
      </Button>
    </div>
  );
}
