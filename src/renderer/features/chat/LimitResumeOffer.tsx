// LimitResumeOffer — the inline "Schedule resume" offer shown beneath a chat error card
// when the turn died with a usage-limit error (Phase 12, design doc §5.7). It renders ONLY
// when `parseUsageLimitMessage(message)` matches; the click creates a `limit_resume` task
// at the parsed reset time (or untimed when unknown) and flips to a confirmation state.
//
// NOTHING is scheduled without the click. Because history hydration replays the same
// persisted error event, the offer survives app restarts (pairing with the boot-time
// `missed` flow).

import { useMemo, useState } from 'react';
import { parseUsageLimitMessage } from '@shared/usageLimit';
import { invoke } from '@renderer/ipc';
import { Button } from '@renderer/components/ui';

export interface LimitResumeOfferProps {
  workspaceId: string;
  message: string;
}

const RESUME_PROMPT = 'Continue where you left off.';

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function LimitResumeOffer({
  workspaceId,
  message,
}: LimitResumeOfferProps): React.JSX.Element | null {
  const info = useMemo(() => parseUsageLimitMessage(message), [message]);
  const [scheduled, setScheduled] = useState(false);
  const [busy, setBusy] = useState(false);

  // Not a usage-limit error → render nothing (the plain error card already shows).
  if (info === null) return null;

  const resetsAt = info.resetsAt;

  async function handleClick(): Promise<void> {
    setBusy(true);
    try {
      await invoke('task:create', {
        workspaceId,
        prompt: RESUME_PROMPT,
        origin: 'limit_resume',
        ...(resetsAt !== null ? { scheduledAt: resetsAt } : {}),
      });
      setScheduled(true);
    } catch {
      // Leave the offer in place so the user can retry; the error surfaces elsewhere.
      setBusy(false);
    }
  }

  if (scheduled) {
    return (
      <div
        className="mt-2 rounded-2 border border-border-1 bg-surface-well px-3 py-2 text-xs text-fg-2"
        data-testid="limit-resume-confirmed"
      >
        {resetsAt !== null
          ? `Scheduled for ${formatTime(resetsAt)} — edit in the Tasks tab.`
          : 'Resume task created — set a time in the Tasks tab.'}
      </div>
    );
  }

  return (
    <div
      className="mt-2 flex items-center justify-between gap-3 rounded-2 border border-border-1 bg-surface-well px-3 py-2"
      data-testid="limit-resume-offer"
    >
      <span className="text-xs text-fg-2">
        Usage limit reached
        {resetsAt !== null ? ` — resets ${formatTime(resetsAt)}` : ''}.
      </span>
      <Button
        variant="primary"
        size="sm"
        disabled={busy}
        data-testid="limit-resume-button"
        onClick={() => void handleClick()}
      >
        {resetsAt !== null ? 'Schedule resume' : 'Create resume task…'}
      </Button>
    </div>
  );
}
