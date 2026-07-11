// OnboardingWizard — first-run setup + the unsandboxed-execution disclosure (Phase 6,
// Track H3 / spec §7). HEIGHTENED-SCRUTINY: the disclosure copy below is the security
// contract shown to the user before any agent/run command executes.
//
// Behaviour:
//   - Fetches `onboarding:state` (harness / GitHub / projects) and shows each step with a
//     ready/todo marker so the user knows what's left. When the state is unavailable
//     (null/undefined — e.g. a bare test harness) the wizard renders NOTHING rather than
//     nagging or crashing.
//   - Renders the **unsandboxed-execution disclosure** with an explicit acknowledgement
//     checkbox. "Get started" is DISABLED until the box is checked — the user cannot
//     dismiss the wizard (and reach a first run) without acknowledging it.
//   - The acknowledgement is persisted (localStorage) so it is shown once; a returning,
//     already-acknowledged user never sees the wizard again.
//
// Setup itself (connect GitHub, add a project) is driven from the sidebar/settings as
// today — the wizard guides + discloses; it does not re-implement those flows. It must
// never BLOCK the app when a harness isn't installed (spec §7 graceful degradation): the
// steps simply show as "to do" and the user can still acknowledge and proceed.

import { useEffect, useState } from 'react';

import type { OnboardingState } from '@shared/ipc';
import { invoke } from '@renderer/ipc';
import { Button } from '@renderer/components/ui';

/** localStorage key recording that the user acknowledged the v1 execution-model disclosure. */
const ACK_KEY = 'harness.onboarding.acknowledged';

/** Read the persisted acknowledgement flag (sandbox-safe: localStorage may be unavailable). */
function readAck(): boolean {
  try {
    return window.localStorage.getItem(ACK_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the acknowledgement flag (best-effort). */
function writeAck(): void {
  try {
    window.localStorage.setItem(ACK_KEY, '1');
  } catch {
    /* best-effort — a failed persist just re-shows the wizard next launch. */
  }
}

export function OnboardingWizard(): React.JSX.Element | null {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [acknowledged, setAcknowledged] = useState<boolean>(readAck);
  const [ackChecked, setAckChecked] = useState(false);

  // Only probe readiness when the disclosure hasn't been acknowledged yet — an
  // already-onboarded user pays no IPC cost and never sees the overlay.
  useEffect(() => {
    if (acknowledged) return;
    let active = true;
    void invoke('onboarding:state', undefined)
      .then((s) => {
        if (active) setState(s);
      })
      .catch(() => {
        /* Unavailable → leave state null so the wizard stays hidden (never blocks). */
      });
    return () => {
      active = false;
    };
  }, [acknowledged]);

  // Hidden once acknowledged, or until a real state arrives. Loose `== null` covers both
  // the pre-fetch `null` and a handler/stub that resolves `undefined` — never render (or
  // dereference) a missing state.
  if (acknowledged || state == null) return null;

  const acknowledge = (): void => {
    if (!ackChecked) return;
    writeAck();
    setAcknowledged(true);
  };

  return (
    <div
      className="absolute inset-0 z-[60] flex animate-[hn-fade_180ms_var(--ease-out)] items-center justify-center bg-scrim"
      data-testid="onboarding-overlay"
    >
      <div
        className="flex max-h-[85vh] w-[560px] max-w-[92vw] animate-[hn-rise_280ms_var(--ease-out)] flex-col overflow-hidden rounded-4 border border-border-1 bg-surface-overlay shadow-4"
        data-testid="onboarding-wizard"
      >
        <div className="border-b border-border-1 px-5 py-4">
          <h2 className="font-display text-lg font-semibold text-fg-1">
            Welcome — let’s get set up
          </h2>
          <p className="mt-1 text-sm text-fg-2">
            A couple of steps and one important thing to know before you run an
            agent.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Setup checklist — reflects onboarding:state. */}
          <ol className="flex flex-col gap-2" data-testid="onboarding-steps">
            <StepRow
              testId="onboarding-step-harness"
              done={state.harnessReady}
              title="Install & sign in to an agent CLI"
              todo="No installed, authenticated harness detected yet."
            />
            <StepRow
              testId="onboarding-step-github"
              done={state.githubConnected}
              title="Connect GitHub (optional)"
              todo="Connect an account to open PRs and read checks."
            />
            <StepRow
              testId="onboarding-step-project"
              done={state.hasProjects}
              title="Add your first project"
              todo="Add a local repo or clone one to create workspaces."
            />
          </ol>

          {/* HEIGHTENED-SCRUTINY: the v1 execution-model disclosure (spec §7). */}
          <div
            className="mt-4 rounded-3 border border-warn bg-warn-muted p-3.5"
            data-testid="onboarding-disclosure"
          >
            <div className="text-xs font-semibold uppercase tracking-caps text-warn">
              Before you run an agent — how execution works
            </div>
            <p className="mt-1.5 text-base leading-relaxed text-fg-1">
              Agent turns and run scripts execute as{' '}
              <strong>real commands with your user account’s privileges</strong>
              , directly inside each workspace’s worktree.{' '}
              <strong>They are not sandboxed in this version.</strong> A command
              an agent runs can read, modify, or delete files and reach the
              network exactly as you can from a terminal. Only run agents and
              scripts on repositories you trust, and review changes in the diff
              before merging.
            </p>
            <label
              className="mt-2.5 flex cursor-pointer items-start gap-2 text-base text-fg-1"
              data-testid="onboarding-ack-label"
            >
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-warn"
                data-testid="onboarding-ack"
                checked={ackChecked}
                onChange={(e) => setAckChecked(e.target.checked)}
              />
              <span>
                I understand that agent and run commands are not sandboxed and
                run with my user privileges.
              </span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-1 px-5 py-3">
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-testid="onboarding-continue"
            disabled={!ackChecked}
            onClick={acknowledge}
          >
            Get started
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One checklist row: a ready/todo marker + title, with a hint when not yet done. */
function StepRow({
  testId,
  done,
  title,
  todo,
}: {
  testId: string;
  done: boolean;
  title: string;
  todo: string;
}): React.JSX.Element {
  return (
    <li
      className="flex items-start gap-2"
      data-testid={testId}
      data-done={done}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs ${
          done ? 'bg-ok text-white' : 'border border-border-2 text-fg-3'
        }`}
        aria-hidden
      >
        {done ? '✓' : ''}
      </span>
      <div className="min-w-0">
        <div className="text-base text-fg-1">{title}</div>
        {!done ? <div className="text-xs text-fg-3">{todo}</div> : null}
      </div>
    </li>
  );
}
