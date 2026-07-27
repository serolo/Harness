// OnboardingWizard — first-run setup + the unsandboxed-execution disclosure (Phase 6,
// Track H3 / spec §7). HEIGHTENED-SCRUTINY: the disclosure copy below is the security
// contract shown to the user before any agent/run command executes.

import { useCallback, useEffect, useState } from 'react';

import type { OnboardingState } from '@shared/ipc';
import {
  COMPLETION_SOUNDS,
  isCompletionSound,
  type CompletionSound,
} from '@shared/settings';
import { invoke } from '@renderer/ipc';
import { useSettings } from '@renderer/features/settings/useSettings';

/** localStorage key recording that the user acknowledged the v1 execution-model disclosure. */
const ACK_KEY = 'harness.onboarding.acknowledged';
const FORCE_SHOW_ONBOARDING = import.meta.env.MODE !== 'test';

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
  const [acknowledged, setAcknowledged] = useState<boolean>(
    FORCE_SHOW_ONBOARDING ? false : readAck,
  );
  const [ackChecked, setAckChecked] = useState(false);

  const loadState = useCallback((): void => {
    void invoke('onboarding:state', undefined)
      .then((s) => setState(s))
      .catch(() => {
        /* Unavailable -> leave state null so the wizard stays hidden (never blocks). */
      });
  }, []);

  useEffect(() => {
    if (acknowledged) return;
    let active = true;
    void invoke('onboarding:state', undefined)
      .then((s) => {
        if (active) setState(s);
      })
      .catch(() => {
        /* Unavailable -> leave state null so the wizard stays hidden (never blocks). */
      });
    return () => {
      active = false;
    };
  }, [acknowledged]);

  if (acknowledged || state == null) return null;

  const acknowledge = (): void => {
    if (!ackChecked) return;
    writeAck();
    setAcknowledged(true);
  };

  return (
    <OnboardingWizardContent
      state={state}
      setState={setState}
      loadState={loadState}
      ackChecked={ackChecked}
      setAckChecked={setAckChecked}
      acknowledge={acknowledge}
    />
  );
}

function OnboardingWizardContent({
  state,
  setState,
  loadState,
  ackChecked,
  setAckChecked,
  acknowledge,
}: {
  state: OnboardingState;
  setState: (state: OnboardingState) => void;
  loadState: () => void;
  ackChecked: boolean;
  setAckChecked: (checked: boolean) => void;
  acknowledge: () => void;
}): React.JSX.Element {
  const { effective, set: setSetting } = useSettings();
  const [busyAction, setBusyAction] = useState<
    'github' | 'refresh' | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const completionSound = effective?.notifications.completionSound ?? 'none';

  const refreshState = (): void => {
    setBusyAction('refresh');
    setActionError(null);
    void invoke('onboarding:state', undefined)
      .then(setState)
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusyAction(null));
  };

  const connectGithub = async (): Promise<void> => {
    setBusyAction('github');
    setActionError(null);
    try {
      await invoke('github:connectGhCli', undefined);
      loadState();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const updateCompletionSound = (next: CompletionSound): void => {
    void setSetting('notifications.completionSound', next)
      .then(() => invoke('notifications:previewSound', { sound: next }))
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <div
      className="absolute inset-0 z-[60] overflow-hidden bg-surface-app text-fg-1"
      data-testid="onboarding-overlay"
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden border border-border-1 bg-surface-app shadow-2xl"
        data-testid="onboarding-wizard"
      >
        <div className="h-9 shrink-0" aria-hidden="true" />

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-10 sm:px-10 lg:px-[13.5vw]">
          <header className="max-w-[920px]">
            <h2 className="text-[28px] font-semibold leading-tight text-fg-1">
              Set up Harness
            </h2>
            <p className="mt-2 text-[15px] text-fg-2">
              Connect GitHub and make sure at least one agent CLI is ready.
            </p>
          </header>

          <ol
            className="mt-9 grid max-w-[760px] grid-cols-1 gap-3 md:grid-cols-2"
            data-testid="onboarding-steps"
          >
            <ProviderCard
              testId="onboarding-step-github"
              done={state.githubConnected}
              icon={<GitHubMark />}
              title="GitHub"
              description="Push branches and open PRs."
              action={state.githubConnected ? 'Connected' : 'Connect gh CLI'}
              onAction={() => void connectGithub()}
              busy={busyAction === 'github'}
              status={state.githubConnected ? undefined : 'Optional'}
            />
            <ProviderCard
              testId="onboarding-step-harness"
              done={state.harnessReady}
              icon={<HarnessMark />}
              title="Agent CLI"
              description="Claude Code, Codex, or Cursor."
              action={state.harnessReady ? 'Agent ready' : 'Detect again'}
              onAction={refreshState}
              busy={busyAction === 'refresh'}
              status={state.harnessReady ? undefined : 'Required'}
            />
          </ol>

          {actionError ? (
            <div className="mt-4 max-w-[1180px] rounded border border-danger bg-danger-muted px-3 py-2 text-sm text-danger">
              {actionError}
            </div>
          ) : null}

          <div className="mt-16 grid max-w-[760px] gap-x-16 gap-y-12 lg:grid-cols-[1fr_440px]">
            <SettingCopy
              title="Execution"
              description="Review how agent commands run before finishing setup."
            />
            <div
              className="max-w-[440px] rounded-md border border-warn bg-warn-muted p-3"
              data-testid="onboarding-disclosure"
            >
              <div className="text-xs font-semibold text-warn">
                Before you run an agent
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-fg-1">
                Agent turns and run scripts execute as{' '}
                <strong>
                  real commands with your user account’s privileges
                </strong>
                , directly inside each workspace’s worktree.{' '}
                <strong>They are not sandboxed in this version.</strong> Review
                changes in the diff before merging.
              </p>
              <label
                className="mt-2.5 flex cursor-pointer items-start gap-2 text-[12px] text-fg-1"
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

            <SettingCopy
              title="Completion sound"
              description="Choose what plays when an agent finishes."
            />
            <div className="flex items-center justify-end gap-3 self-start">
              <select
                className="h-9 w-[206px] rounded-md border border-border-2 bg-surface-well px-3 text-sm font-medium text-fg-1 outline-none"
                value={completionSound}
                onChange={(e) => {
                  if (isCompletionSound(e.target.value)) {
                    updateCompletionSound(e.target.value);
                  }
                }}
                aria-label="Completion sound"
              >
                {COMPLETION_SOUNDS.map((sound) => (
                  <option key={sound} value={sound}>
                    {sound === 'none'
                      ? 'None'
                      : sound.charAt(0).toUpperCase() + sound.slice(1)}
                  </option>
                ))}
              </select>
              <SpeakerMark />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-center px-6 pb-7 sm:px-10 lg:px-[13.5vw]">
          <div className="flex-1" />
          <button
            type="button"
            className="mr-4 flex items-center gap-2 text-sm font-semibold text-fg-2 hover:text-fg-1"
          >
            <HelpMark />
            Get support
          </button>
          <button
            type="button"
            className="h-10 rounded-md bg-accent px-5 text-sm font-semibold text-accent-fg shadow-sm hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-fg-disabled disabled:text-bg-2"
            data-testid="onboarding-continue"
            disabled={!ackChecked}
            onClick={acknowledge}
          >
            Finish setup&nbsp; ⌘↵
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  testId,
  done,
  icon,
  title,
  description,
  action,
  status,
  onAction,
  busy = false,
}: {
  testId?: string;
  done: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  action: string;
  status?: string;
  onAction?: () => void;
  busy?: boolean;
}): React.JSX.Element {
  return (
    <li
      className="overflow-hidden rounded border border-border-1 bg-surface-card"
      data-testid={testId}
      data-done={done}
    >
      <div className="flex min-h-[86px] flex-col justify-center px-4 py-3">
        <div className="flex items-center gap-3">
          {icon}
          <div className="text-[17px] font-semibold text-fg-1">{title}</div>
        </div>
        <div className="mt-2 text-sm font-medium text-fg-2">
          {description}
        </div>
      </div>
      <div className="flex h-12 items-center justify-between border-t border-border-1 bg-surface-panel px-4">
        <button
          type="button"
          className="text-left text-sm font-medium text-fg-2 hover:text-fg-1 disabled:cursor-default disabled:hover:text-fg-2"
          disabled={done || !onAction || busy}
          onClick={onAction}
        >
          {done ? (
            <span className="flex items-center gap-2 text-fg-2">
              <CheckMark /> {action}
            </span>
          ) : (
            <span>{busy ? 'Working…' : action}</span>
          )}
        </button>
        {status ? (
          <span className="text-sm font-semibold text-danger">{status}</span>
        ) : null}
      </div>
    </li>
  );
}

function SettingCopy({
  title,
  shortcut,
  description,
}: {
  title: string;
  shortcut?: string;
  description: string;
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-3 text-[18px] font-semibold text-fg-1">
        {title}
        {shortcut ? (
          <span className="text-[13px] font-semibold text-fg-3">
            {shortcut}
          </span>
        ) : null}
      </div>
      <p className="mt-2 max-w-[680px] text-[15px] font-medium leading-relaxed text-fg-2">
        {description}
      </p>
    </div>
  );
}

function GitHubMark(): React.JSX.Element {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-fg-1 text-[13px] font-black text-bg-1">
      GH
    </span>
  );
}

function HarnessMark(): React.JSX.Element {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-fg-2 text-[13px] font-bold text-fg-1">
      H
    </span>
  );
}

function CheckMark(): React.JSX.Element {
  return <span className="text-base leading-none text-emerald-500">✓</span>;
}

function HelpMark(): React.JSX.Element {
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border-2 text-xs">
      ?
    </span>
  );
}

function SpeakerMark(): React.JSX.Element {
  return <span className="text-xl text-fg-2">⌕</span>;
}
