// IPC health indicator (Phase 0 DoD — the visible "IPC OK" proof).
//
// On mount this calls `invoke('app:ping')` through the renderer IPC funnel
// (src/renderer/ipc) — never `window.api` directly (README §10). When main answers
// `'ok'`, the dot goes GREEN; while the round trip is in flight it is amber (pending);
// if the promise rejects (or returns something unexpected) it is red (error).
//
// It is a small, self-contained component ON PURPOSE: Task 10 unit-tests it by mocking
// `window.api.invoke` and asserting the dot flips — so all IPC access stays behind the
// funnel and the states are individually observable.

import { useEffect, useState } from 'react';
import { invoke } from '@renderer/ipc';

/** The three observable states of the ping round trip. */
type PingState = 'pending' | 'ok' | 'error';

/** Presentational config per state (color token + label + a11y text). */
const STATE_META: Record<
  PingState,
  { dotClass: string; label: string; title: string }
> = {
  pending: {
    dotClass: 'bg-amber-500 animate-pulse',
    label: 'IPC…',
    title: 'Checking IPC round trip to the main process',
  },
  ok: {
    dotClass: 'bg-emerald-500',
    label: 'IPC OK',
    title: 'IPC round trip succeeded (app:ping → ok)',
  },
  error: {
    dotClass: 'bg-red-500',
    label: 'IPC error',
    title: 'IPC round trip failed — the main process did not answer app:ping',
  },
};

/**
 * Renders a colored status dot + label reflecting the `app:ping` result. Accepts no
 * props; the only input is the (possibly mocked) `window.api` behind the IPC funnel.
 */
export function IpcHealth(): React.JSX.Element {
  const [state, setState] = useState<PingState>('pending');

  useEffect(() => {
    // Guard against a state update after unmount (React 18 StrictMode double-invokes
    // effects in dev, and the promise may resolve after the first cleanup).
    let active = true;

    // `app:ping` has a `void` request; the funnel's signature still takes the arg
    // slot, so pass `undefined` explicitly.
    invoke('app:ping', undefined)
      .then((res) => {
        if (!active) return;
        // The contract pins the response to the literal 'ok'; treat anything else as
        // a failure rather than trusting the string blindly.
        setState(res === 'ok' ? 'ok' : 'error');
      })
      .catch(() => {
        if (!active) return;
        setState('error');
      });

    return () => {
      active = false;
    };
  }, []);

  const meta = STATE_META[state];

  return (
    <div
      className="flex items-center gap-2 text-xs text-slate-400"
      role="status"
      aria-live="polite"
      title={meta.title}
      data-testid="ipc-health"
      data-state={state}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${meta.dotClass}`}
      />
      <span>{meta.label}</span>
    </div>
  );
}
