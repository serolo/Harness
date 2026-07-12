// OnboardingWizard — first-run setup + the unsandboxed-execution disclosure (Phase 6,
// Track H3 / spec §7). HEIGHTENED-SCRUTINY: the disclosure copy below is the security
// contract shown to the user before any agent/run command executes.

import { useEffect, useState } from 'react';

import type { OnboardingState } from '@shared/ipc';
import { invoke } from '@renderer/ipc';

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
    <div
      className="absolute inset-0 z-[60] overflow-hidden bg-[#17070d] text-zinc-100"
      data-testid="onboarding-overlay"
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden border border-white/10 bg-[#17070d] shadow-2xl"
        data-testid="onboarding-wizard"
      >
        <div className="flex h-9 shrink-0 items-center gap-2 px-4">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-10 sm:px-10 lg:px-[13.5vw]">
          <header className="max-w-[920px]">
            <h2 className="text-[28px] font-semibold leading-tight text-zinc-100">
              Set up Conductor
            </h2>
            <p className="mt-2 text-[15px] text-zinc-400">
              Conductor relies on GitHub and uses your existing subscriptions.
              Configure them here.
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
              description="Clone, push, and create PRs."
              action="Sign in"
              status="Required"
            />
            <ProviderCard
              testId="onboarding-step-project"
              done={state.hasProjects}
              icon={<FolderMark />}
              title="Workspace"
              description="Add your first local repo."
              action={state.hasProjects ? 'Project ready' : 'Add project'}
              status={state.hasProjects ? undefined : 'Required'}
            />
            <ProviderCard
              testId="onboarding-step-harness"
              done={state.harnessReady}
              icon={<CodexMark />}
              title="Codex"
              description="OpenAI's coding agent."
              action={state.harnessReady ? 'Agent ready' : 'Sign in'}
            />
            <ProviderCard
              done={false}
              icon={<CloudMark />}
              title="More providers"
              description="Bedrock, Vertex, and more."
              action="Provider docs"
              external
            />
          </ol>

          <div className="mt-16 grid max-w-[1180px] gap-x-16 gap-y-12 lg:grid-cols-[1fr_440px]">
            <SettingCopy
              title="Theme"
              shortcut="⌘⌥T"
              description="Choose light, dark, or system."
            />
            <div className="grid grid-cols-3 gap-2 self-start">
              <ThemeChoice label="Light" variant="light" />
              <ThemeChoice label="Dark" variant="dark" selected />
              <ThemeChoice label="System" variant="system" />
            </div>

            <SettingCopy
              title="Message sending"
              description="Choose whether new messages queue after the current turn or steer the turn in progress."
            />
            <div className="grid grid-cols-2 gap-3 self-start justify-self-end">
              <MessageChoice label="Queue" />
              <MessageChoice label="Steer" selected />
            </div>

            <SettingCopy
              title="Execution"
              description="Review how agent commands run before finishing setup."
            />
            <div
              className="max-w-[440px] rounded-md border border-amber-700/50 bg-black/25 p-3"
              data-testid="onboarding-disclosure"
            >
              <div className="text-xs font-semibold text-amber-200">
                Before you run an agent
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-amber-100/85">
                Agent turns and run scripts execute as{' '}
                <strong>
                  real commands with your user account’s privileges
                </strong>
                , directly inside each workspace’s worktree.{' '}
                <strong>They are not sandboxed in this version.</strong> Review
                changes in the diff before merging.
              </p>
              <label
                className="mt-2.5 flex cursor-pointer items-start gap-2 text-[12px] text-amber-100"
                data-testid="onboarding-ack-label"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-amber-400"
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
                className="h-9 w-[206px] rounded-md border border-white/15 bg-black/20 px-3 text-sm font-medium text-zinc-200 outline-none"
                defaultValue="choo-choo"
                aria-label="Completion sound"
              >
                <option value="choo-choo">Choo Choo</option>
                <option value="ding">Ding</option>
                <option value="none">None</option>
              </select>
              <SpeakerMark />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-center px-6 pb-7 sm:px-10 lg:px-[13.5vw]">
          <div className="flex flex-1 items-center justify-center gap-3">
            <span className="h-3 w-3 rounded-full bg-zinc-300/90" />
            <span className="h-3 w-3 rounded-full bg-zinc-300/90" />
          </div>
          <button
            type="button"
            className="mr-4 flex items-center gap-2 text-sm font-semibold text-zinc-300 hover:text-white"
          >
            <HelpMark />
            Get support
          </button>
          <button
            type="button"
            className="h-10 rounded-md bg-zinc-200 px-5 text-sm font-semibold text-zinc-950 shadow-sm hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-500 disabled:text-zinc-800"
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
  external = false,
}: {
  testId?: string;
  done: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  action: string;
  status?: string;
  external?: boolean;
}): React.JSX.Element {
  return (
    <li
      className="overflow-hidden rounded border border-white/10 bg-black/10"
      data-testid={testId}
      data-done={done}
    >
      <div className="flex min-h-[86px] flex-col justify-center px-4 py-3">
        <div className="flex items-center gap-3">
          {icon}
          <div className="text-[17px] font-semibold text-zinc-100">{title}</div>
        </div>
        <div className="mt-2 text-sm font-medium text-zinc-400">
          {description}
        </div>
      </div>
      <div className="flex h-12 items-center justify-between border-t border-white/10 bg-[#201016] px-4">
        <span className="text-sm font-medium text-zinc-300">
          {done ? (
            <span className="flex items-center gap-2 text-zinc-300">
              <CheckMark /> {action}
            </span>
          ) : (
            action
          )}
        </span>
        {status ? (
          <span className="text-sm font-semibold text-rose-400">{status}</span>
        ) : null}
        {external ? <span className="text-lg text-zinc-400">↗</span> : null}
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
      <div className="flex items-center gap-3 text-[18px] font-semibold text-zinc-100">
        {title}
        {shortcut ? (
          <span className="text-[13px] font-semibold text-zinc-500">
            {shortcut}
          </span>
        ) : null}
      </div>
      <p className="mt-2 max-w-[680px] text-[15px] font-medium leading-relaxed text-zinc-500">
        {description}
      </p>
    </div>
  );
}

function ThemeChoice({
  label,
  variant,
  selected = false,
}: {
  label: string;
  variant: 'light' | 'dark' | 'system';
  selected?: boolean;
}): React.JSX.Element {
  return (
    <button type="button" className="group text-center">
      <div
        className={`relative h-[68px] overflow-hidden rounded-md border bg-zinc-900 ${
          selected
            ? 'border-white shadow-[0_0_0_2px_rgba(255,255,255,0.85)]'
            : 'border-white/15'
        }`}
      >
        <ThemePreview variant={variant} />
      </div>
      <div
        className={`mt-2 text-[16px] font-semibold ${
          selected ? 'text-zinc-100' : 'text-zinc-500'
        }`}
      >
        {label}
      </div>
    </button>
  );
}

function ThemePreview({
  variant,
}: {
  variant: 'light' | 'dark' | 'system';
}): React.JSX.Element {
  const dark = (
    <PreviewLines
      bg="bg-[#171312]"
      rail="bg-[#292322]"
      text="bg-zinc-600"
      accent="bg-[#51323a]"
    />
  );

  if (variant === 'dark') return dark;
  if (variant === 'system') {
    return (
      <>
        <PreviewLines
          bg="bg-zinc-50"
          rail="bg-zinc-200"
          text="bg-zinc-300"
          accent="bg-rose-200"
        />
        <div className="absolute inset-y-0 right-0 w-1/2 overflow-hidden [clip-path:polygon(100%_0,0_100%,100%_100%)]">
          {dark}
        </div>
      </>
    );
  }

  return (
    <PreviewLines
      bg="bg-zinc-50"
      rail="bg-zinc-200"
      text="bg-zinc-300"
      accent="bg-rose-200"
    />
  );
}

function PreviewLines({
  bg,
  rail,
  text,
  accent,
}: {
  bg: string;
  rail: string;
  text: string;
  accent: string;
}): React.JSX.Element {
  return (
    <div className={`h-full ${bg} p-2`}>
      <div className="grid h-full grid-cols-[20px_1fr] gap-2">
        <div className="space-y-1">
          <div className={`h-2 rounded-sm ${rail}`} />
          <div className={`h-2 rounded-sm ${rail}`} />
          <div className={`h-2 rounded-sm ${rail}`} />
        </div>
        <div className="space-y-2">
          <div className={`h-3 w-1/3 rounded-sm ${text}`} />
          <div className={`h-3 w-3/4 rounded-sm ${text}`} />
          <div className={`ml-auto h-3 w-1/2 rounded-sm ${accent}`} />
          <div className={`mx-auto h-3 w-2/3 rounded-sm ${text}`} />
        </div>
      </div>
    </div>
  );
}

function MessageChoice({
  label,
  selected = false,
}: {
  label: string;
  selected?: boolean;
}): React.JSX.Element {
  return (
    <button type="button" className="w-[136px] text-center">
      <div
        className={`h-[72px] rounded-md border bg-black/10 p-2 ${
          selected
            ? 'border-white shadow-[0_0_0_2px_rgba(255,255,255,0.85)]'
            : 'border-white/10'
        }`}
      >
        <div className="space-y-2">
          <div className="h-3 rounded-sm bg-zinc-700" />
          <div className="h-3 rounded-sm bg-zinc-700" />
          <div className="flex items-center gap-2">
            <div className="h-3 flex-1 rounded-sm bg-[#51323a]" />
            <span className="text-lg leading-none text-zinc-500">
              {selected ? '↟' : '↵'}
            </span>
          </div>
        </div>
      </div>
      <div
        className={`mt-2 text-[16px] font-semibold ${
          selected ? 'text-zinc-100' : 'text-zinc-500'
        }`}
      >
        {label}
      </div>
    </button>
  );
}

function GitHubMark(): React.JSX.Element {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 text-[13px] font-black text-[#17070d]">
      GH
    </span>
  );
}

function CodexMark(): React.JSX.Element {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 text-[13px] font-bold text-zinc-100">
      O
    </span>
  );
}

function FolderMark(): React.JSX.Element {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded bg-zinc-200 text-[13px] font-black text-[#17070d]">
      W
    </span>
  );
}

function CloudMark(): React.JSX.Element {
  return <span className="text-[13px] font-black text-zinc-200">AWS</span>;
}

function CheckMark(): React.JSX.Element {
  return <span className="text-base leading-none text-emerald-500">✓</span>;
}

function HelpMark(): React.JSX.Element {
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-500 text-xs">
      ?
    </span>
  );
}

function SpeakerMark(): React.JSX.Element {
  return <span className="text-xl text-zinc-300">⌕</span>;
}
