// OnboardingWizard — first-run setup + the unsandboxed-execution disclosure (Phase 6,
// Track H3 / spec §7). HEIGHTENED-SCRUTINY: the disclosure copy below is the security
// contract shown to the user before any agent/run command executes.

import { useCallback, useEffect, useState } from 'react';

import type { OnboardingLoginProvider, OnboardingState } from '@shared/ipc';
import type { HarnessId } from '@shared/harness';
import {
  APPEARANCE_THEMES,
  COMPLETION_SOUNDS,
  isAppearanceTheme,
  isCompletionSound,
  type AppearanceTheme,
  type CompletionSound,
} from '@shared/settings';
import { invoke } from '@renderer/ipc';
import { useSettings } from '@renderer/features/settings/useSettings';
import { OnboardingLoginTerminal } from './OnboardingLoginTerminal';

export function OnboardingWizard(): React.JSX.Element | null {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [ackChecked, setAckChecked] = useState(false);

  const loadState = useCallback((): void => {
    void invoke('onboarding:state', undefined)
      .then((s) => setState(s))
      .catch(() => {
        /* Unavailable -> leave state null so the wizard stays hidden (never blocks). */
      });
  }, []);

  useEffect(() => {
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
  }, []);

  if (state == null || state.acknowledged) return null;

  const acknowledge = (): void => {
    if (!ackChecked) return;
    void invoke('onboarding:acknowledge', undefined)
      .then(() => setState({ ...state, acknowledged: true }))
      .catch(() => {
        // Keep the wizard visible if durable persistence fails.
      });
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
    'github' | 'claude' | 'codex' | 'qmd' | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loginProvider, setLoginProvider] =
    useState<OnboardingLoginProvider | null>(null);
  const completionSound = effective?.notifications.completionSound ?? 'none';
  const appearanceTheme = effective?.appearance.theme ?? 'dark';

  const connectGithub = async (): Promise<void> => {
    setBusyAction('github');
    setActionError(null);
    try {
      const status = await invoke('github:cliStatus', undefined);
      if (status.authenticated) {
        await invoke('github:connectGhCli', undefined);
        loadState();
      } else {
        setLoginProvider('github');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const signInProvider = async (
    provider: 'claude' | 'codex',
    harness: HarnessId,
  ): Promise<void> => {
    setBusyAction(provider);
    setActionError(null);
    try {
      const detected = await invoke('harness:detect', { id: harness });
      if (detected.installed && detected.authenticated) {
        loadState();
      } else {
        setLoginProvider(provider);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const installQmd = async (): Promise<void> => {
    setBusyAction('qmd');
    setActionError(null);
    try {
      const status = await invoke('knowledge:installQmd', undefined);
      setState({ ...state, qmdInstalled: status.installed });
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

  const updateTheme = (next: AppearanceTheme): void => {
    void setSetting('appearance.theme', next).catch((err: unknown) => {
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
            className="mt-9 grid max-w-[1180px] grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
            data-testid="onboarding-steps"
          >
            <ProviderCard
              testId="onboarding-step-github"
              done={state.githubConnected}
              icon={<GitHubMark />}
              title="GitHub"
              description="Push branches and open PRs."
              action={state.githubConnected ? 'Connected' : 'Sign in'}
              onAction={() => void connectGithub()}
              busy={busyAction === 'github'}
              status={state.githubConnected ? undefined : 'Required'}
            />
            <ProviderCard
              testId="onboarding-step-claude"
              done={state.claudeReady}
              icon={<ClaudeMark />}
              title="Claude Code"
              description="Anthropic's coding agent."
              action={state.claudeReady ? 'Signed in' : 'Sign in'}
              onAction={() => void signInProvider('claude', 'claude_code')}
              busy={busyAction === 'claude'}
              status={state.harnessReady ? undefined : 'One required'}
            />
            <ProviderCard
              testId="onboarding-step-codex"
              done={state.codexReady}
              icon={<CodexMark />}
              title="Codex"
              description="OpenAI's coding agent."
              action={state.codexReady ? 'Signed in' : 'Sign in'}
              onAction={() => void signInProvider('codex', 'codex')}
              busy={busyAction === 'codex'}
              status={state.harnessReady ? undefined : 'One required'}
            />
            <ProviderCard
              testId="onboarding-step-qmd"
              done={state.qmdInstalled}
              icon={<QmdMark />}
              title="QMD search"
              description="Local hybrid search for project knowledge."
              action={state.qmdInstalled ? 'QMD installed' : 'Install QMD'}
              onAction={() => void installQmd()}
              busy={busyAction === 'qmd'}
              status={state.qmdInstalled ? undefined : 'Optional'}
            />
          </ol>

          {loginProvider ? (
            <OnboardingLoginTerminal
              provider={loginProvider}
              onFinished={(authenticated) => {
                loadState();
                if (!authenticated) {
                  setActionError(
                    `Sign-in for ${loginProvider} was not completed.`,
                  );
                }
              }}
              onClose={() => setLoginProvider(null)}
              onError={setActionError}
            />
          ) : null}

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
              title="Theme"
              description="Choose how Harness looks. You can change this later in Settings."
            />
            <div className="flex items-center justify-end self-start">
              <select
                className="h-9 w-[206px] rounded-md border border-border-2 bg-surface-well px-3 text-sm font-medium text-fg-1 outline-none"
                value={appearanceTheme}
                onChange={(e) => {
                  if (isAppearanceTheme(e.target.value)) {
                    updateTheme(e.target.value);
                  }
                }}
                aria-label="Theme"
                data-testid="onboarding-theme"
              >
                {APPEARANCE_THEMES.map((theme) => (
                  <option key={theme} value={theme}>
                    {theme.charAt(0).toUpperCase() + theme.slice(1)}
                  </option>
                ))}
              </select>
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
            disabled={!ackChecked || !state.complete}
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
      <button
        type="button"
        className="flex min-h-[134px] w-full flex-col px-4 py-3 text-left transition-colors hover:bg-surface-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-default disabled:hover:bg-transparent"
        disabled={done || !onAction || busy}
        onClick={onAction}
        aria-label={busy ? 'Working…' : action}
      >
        <div className="flex flex-1 flex-col justify-center">
          <div className="flex items-center gap-3">
            {icon}
            <div className="text-[17px] font-semibold text-fg-1">{title}</div>
          </div>
          <div className="mt-2 text-sm font-medium text-fg-2">
            {description}
          </div>
        </div>
        <div className="mt-3 flex w-full items-center justify-between text-sm font-medium text-fg-2">
          {done ? (
            <span className="flex items-center gap-2 text-fg-2">
              <CheckMark /> {action}
            </span>
          ) : (
            <span>{busy ? 'Working…' : action}</span>
          )}
          {status ? (
            <span className="font-semibold text-danger">{status}</span>
          ) : null}
        </div>
      </button>
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

function ClaudeMark(): React.JSX.Element {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-fg-2 text-[13px] font-bold text-fg-1">
      C
    </span>
  );
}

function CodexMark(): React.JSX.Element {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-fg-2 text-[13px] font-bold text-fg-1">
      O
    </span>
  );
}

function QmdMark(): React.JSX.Element {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-fg-2 text-[10px] font-bold text-fg-1">
      QMD
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
