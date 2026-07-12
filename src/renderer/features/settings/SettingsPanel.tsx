// SettingsPanel — the settings editor surface (Phase 6, Track B/G). Renders the
// declarative section/field catalogue (`fields.ts`) as rows, each showing the effective
// value + a provenance badge + a write-to-(user)-layer control. Data + writes come from
// `useSettings`; this component is view + wiring only (all main access is inside the
// hook via `@renderer/ipc`).

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  CheckCircle2,
  ExternalLink,
  FlaskConical,
  GitBranch,
  KeyRound,
  Laptop,
  Palette,
  RefreshCw,
  Settings2,
  Shield,
  TerminalSquare,
  UserCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { GithubAccount, GithubCliAuthStatus } from '@shared/github';
import type { SettingLayer, SettingsIssue } from '@shared/settings';
import type { GitSshKey } from '@shared/git';
import { Button, Input } from '@renderer/components/ui';
import { invoke, subscribeStream } from '@renderer/ipc';
import { useSettings } from './useSettings';
import { SETTINGS_SECTIONS, getAtPath } from './fields';
import { SettingRow } from './SettingRow';
import { RunScriptEditor } from './RunScriptEditor';

export interface SettingsPanelProps {
  /** Close affordance for the overlay host (a header button). */
  onClose?: () => void;
}

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.JSX.Element {
  const { effective, provenance, issues, loading, error, set } = useSettings();
  const [scope, setScope] = useState<'user' | 'repo'>('user');
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general');
  const [sshKeys, setSshKeys] = useState<GitSshKey[]>([]);
  const [sshError, setSshError] = useState<string | null>(null);
  const [githubAccounts, setGithubAccounts] = useState<GithubAccount[]>([]);
  const [githubCli, setGithubCli] = useState<GithubCliAuthStatus | null>(null);
  const [githubAuthError, setGithubAuthError] = useState<string | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubPat, setGithubPat] = useState('');

  useEffect(() => {
    let active = true;
    const loadGitMetadata = async (): Promise<void> => {
      const [keys, accounts, cli] = await Promise.all([
        safeSshKeys(),
        invoke('github:accounts', undefined),
        safeGithubCliStatus(),
      ]);
      if (active) {
        setSshKeys(keys);
        setGithubAccounts(accounts);
        setGithubCli(cli);
        setSshError(null);
      }
    };
    void loadGitMetadata().catch((err: unknown) => {
      if (active) {
        const message = err instanceof Error ? err.message : String(err);
        setSshError(message);
        setGithubAuthError(message);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const refreshGithubAuth = async (): Promise<void> => {
    setGithubBusy(true);
    setGithubAuthError(null);
    try {
      const [accounts, cli] = await Promise.all([
        invoke('github:accounts', undefined),
        safeGithubCliStatus(),
      ]);
      setGithubAccounts(accounts);
      setGithubCli(cli);
    } catch (err) {
      setGithubAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setGithubBusy(false);
    }
  };

  const connectGithubFromCli = async (): Promise<void> => {
    setGithubBusy(true);
    setGithubAuthError(null);
    try {
      await invoke('github:connectGhCli', undefined);
      await refreshGithubAuth();
    } catch (err) {
      setGithubAuthError(
        isMissingIpcHandler(err)
          ? 'Restart the app to enable GitHub CLI auth in this dev session.'
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setGithubBusy(false);
    }
  };

  const connectGithubPat = async (): Promise<void> => {
    const token = githubPat.trim();
    if (token === '') return;
    setGithubBusy(true);
    setGithubAuthError(null);
    try {
      await subscribeStream(
        'github:connect',
        { mode: 'pat', token },
        (chunk) => {
          if (chunk.kind === 'connected') {
            setGithubPat('');
            setGithubAccounts((prev) => [chunk.account, ...prev]);
          } else if (chunk.kind === 'error') {
            setGithubAuthError(chunk.message);
          }
        },
      );
      await refreshGithubAuth();
    } catch (err) {
      setGithubAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setGithubBusy(false);
    }
  };

  const rowsBySection = useMemo(() => {
    const all = SETTINGS_SECTIONS.flatMap((section) => section.fields);
    return {
      general: all.filter((field) => field.keyPath.startsWith('notifications.')),
      harnesses: all.filter((field) => field.keyPath.startsWith('agent.')),
      git: all.filter((field) => field.keyPath.startsWith('git.')),
    };
  }, []);

  return (
    <div
      className="flex h-[min(86vh,900px)] min-h-0 flex-col bg-surface-overlay text-fg-1"
      data-testid="settings-panel"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-1 px-5">
        <div className="flex items-center gap-5">
          {onClose ? (
            <button
              type="button"
              data-testid="settings-close"
              onClick={onClose}
              className="flex items-center gap-2 text-sm font-medium text-fg-2 hover:text-fg-1"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </button>
          ) : null}
          <div className="flex h-full items-end gap-7">
            <ScopeTab active={scope === 'user'} onClick={() => setScope('user')}>
              User
            </ScopeTab>
            <ScopeTab active={scope === 'repo'} onClick={() => setScope('repo')}>
              Repo
            </ScopeTab>
          </div>
        </div>
        <button
          type="button"
          className="flex h-9 items-center gap-2 rounded-2 border border-border-2 px-3 text-sm font-semibold text-fg-1 hover:bg-bg-3"
        >
          <Settings2 className="h-4 w-4" aria-hidden />
          <span className="font-mono">Open settings.toml</span>
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {error ? (
        <div
          className="border-b border-danger bg-danger-muted px-4 py-2 text-xs text-danger"
          data-testid="settings-error"
        >
          {error.message}
        </div>
      ) : null}

      <SettingsIssuesBanner issues={issues} />

      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr]">
        <aside className="min-h-0 overflow-y-auto border-r border-border-1 bg-surface-panel px-2 py-3">
          <SettingsNav
            active={activeSection}
            onSelect={setActiveSection}
            scope={scope}
          />
        </aside>

        <main className="min-h-0 overflow-y-auto">
        {loading && effective === null ? (
          <div
            className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
            data-testid="settings-loading"
          >
            Loading settings…
          </div>
        ) : effective === null ? (
          <div
            className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
            data-testid="settings-empty"
          >
            No settings available.
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[980px] px-10 py-10">
            {activeSection === 'general' ? (
              <SettingsSection title="General" testId="settings-section-general">
                <SettingRows
                  fields={rowsBySection.general}
                  effective={effective}
                  provenance={provenance}
                  onSet={(keyPath, value) => void set(keyPath, value)}
                />
              </SettingsSection>
            ) : null}

            {activeSection === 'harnesses' ? (
              <SettingsSection
                title="Harnesses"
                testId="settings-section-harnesses"
              >
                <SettingRows
                  fields={rowsBySection.harnesses}
                  effective={effective}
                  provenance={provenance}
                  onSet={(keyPath, value) => void set(keyPath, value)}
                />
              </SettingsSection>
            ) : null}

            {activeSection === 'git' ? (
              <SettingsSection title="Git" testId="settings-section-git">
                <GithubAuthPanel
                  accounts={githubAccounts}
                  cli={githubCli}
                  busy={githubBusy}
                  error={githubAuthError}
                  pat={githubPat}
                  onPatChange={setGithubPat}
                  onRefresh={() => void refreshGithubAuth()}
                  onConnectCli={() => void connectGithubFromCli()}
                  onConnectPat={() => void connectGithubPat()}
                />
                <SettingRows
                  fields={rowsBySection.git}
                  effective={effective}
                  provenance={provenance}
                  onSet={(keyPath, value) => void set(keyPath, value)}
                />
                <SshKeysPanel keys={sshKeys} error={sshError} />
              </SettingsSection>
            ) : null}

            {activeSection === 'environment' ? (
              <SettingsSection
                title="Environment"
                testId="settings-section-environment"
              >
                {effective ? (
                  <RunScriptEditor
                    effective={effective}
                    provenance={provenance}
                    onSet={(keyPath, value) => void set(keyPath, value)}
                  />
                ) : null}
              </SettingsSection>
            ) : null}

            {activeSection !== 'general' &&
            activeSection !== 'harnesses' &&
            activeSection !== 'git' &&
            activeSection !== 'environment' ? (
              <SettingsSection
                title={SECTION_LABELS[activeSection]}
                testId={`settings-section-${activeSection}`}
              >
                <EmptySection section={activeSection} />
              </SettingsSection>
            ) : null}
          </div>
        )}
        </main>
      </div>
    </div>
  );
}

async function safeGithubCliStatus(): Promise<GithubCliAuthStatus> {
  try {
    return await invoke('github:cliStatus', undefined);
  } catch (err) {
    if (isMissingIpcHandler(err)) {
      return {
        available: false,
        authenticated: false,
        message: 'Restart the app to enable GitHub CLI auth in this dev session.',
      };
    }
    throw err;
  }
}

async function safeSshKeys(): Promise<GitSshKey[]> {
  try {
    return await invoke('git:sshKeys', undefined);
  } catch (err) {
    if (isMissingIpcHandler(err)) return [];
    throw err;
  }
}

function isMissingIpcHandler(err: unknown): boolean {
  return err instanceof Error && /No handler registered/i.test(err.message);
}

type SettingsSectionId =
  | 'general'
  | 'account'
  | 'models'
  | 'harnesses'
  | 'environment'
  | 'git'
  | 'appearance'
  | 'experimental'
  | 'advanced';

const SECTION_LABELS: Record<SettingsSectionId, string> = {
  general: 'General',
  account: 'Account',
  models: 'Models',
  harnesses: 'Harnesses',
  environment: 'Environment',
  git: 'Git',
  appearance: 'Appearance',
  experimental: 'Experimental',
  advanced: 'Advanced',
};

const PRIMARY_NAV: Array<{
  id: SettingsSectionId;
  icon: LucideIcon;
}> = [
  { id: 'general', icon: Settings2 },
  { id: 'account', icon: UserCircle },
  { id: 'models', icon: Bot },
  { id: 'harnesses', icon: TerminalSquare },
  { id: 'environment', icon: Laptop },
  { id: 'git', icon: GitBranch },
  { id: 'appearance', icon: Palette },
];

const SECONDARY_NAV: Array<{
  id: SettingsSectionId;
  icon: LucideIcon;
}> = [
  { id: 'experimental', icon: FlaskConical },
  { id: 'advanced', icon: Shield },
];

function ScopeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-14 border-b-2 px-1 pt-1 text-sm font-semibold ${
        active
          ? 'border-fg-1 text-fg-1'
          : 'border-transparent text-fg-2 hover:text-fg-1'
      }`}
    >
      {children}
    </button>
  );
}

function SettingsNav({
  active,
  onSelect,
}: {
  active: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
  scope: 'user' | 'repo';
}): React.JSX.Element {
  return (
    <nav className="space-y-6">
      <div className="space-y-1">
        {PRIMARY_NAV.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={active === item.id}
            onClick={() => onSelect(item.id)}
          />
        ))}
      </div>
      <div>
        <div className="px-2 pb-2 text-xs font-medium uppercase tracking-caps text-fg-3">
          More
        </div>
        <div className="space-y-1">
          {SECONDARY_NAV.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={active === item.id}
              onClick={() => onSelect(item.id)}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}

function NavButton({
  item,
  active,
  onClick,
}: {
  item: (typeof PRIMARY_NAV)[number];
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-testid={`settings-nav-${item.id}`}
      onClick={onClick}
      className={`flex h-10 w-full items-center gap-3 rounded-2 px-3 text-left text-sm font-medium ${
        active
          ? 'bg-bg-4 text-fg-1'
          : 'text-fg-2 hover:bg-bg-3 hover:text-fg-1'
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {SECTION_LABELS[item.id]}
    </button>
  );
}

function SettingsSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section data-testid={testId}>
      <h1 className="mb-8 font-display text-xl font-semibold text-fg-1">
        {title}
      </h1>
      <div className="divide-y divide-border-1">{children}</div>
    </section>
  );
}

function SettingRows({
  fields,
  effective,
  provenance,
  onSet,
}: {
  fields: (typeof SETTINGS_SECTIONS)[number]['fields'][number][];
  effective: NonNullable<ReturnType<typeof useSettings>['effective']>;
  provenance: Record<string, SettingLayer>;
  onSet: (keyPath: string, value: unknown) => void;
}): React.JSX.Element {
  return (
    <>
      {fields.map((field) => (
        <SettingRow
          key={field.keyPath}
          field={field}
          value={getAtPath(effective, field.keyPath)}
          layer={provenance[field.keyPath] as SettingLayer | undefined}
          onSet={onSet}
        />
      ))}
    </>
  );
}

function GithubAuthPanel({
  accounts,
  cli,
  busy,
  error,
  pat,
  onPatChange,
  onRefresh,
  onConnectCli,
  onConnectPat,
}: {
  accounts: GithubAccount[];
  cli: GithubCliAuthStatus | null;
  busy: boolean;
  error: string | null;
  pat: string;
  onPatChange: (value: string) => void;
  onRefresh: () => void;
  onConnectCli: () => void;
  onConnectPat: () => void;
}): React.JSX.Element {
  const connected = accounts.length > 0;

  return (
    <div className="py-5" data-testid="github-auth-panel">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg-1">Local GitHub</h2>
          <p className="mt-1 text-sm leading-relaxed text-fg-2">
            Choose how Harness authenticates GitHub operations on this machine.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={busy}
          data-testid="github-auth-refresh"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Refresh
        </Button>
      </div>

      <div className="space-y-3">
        <div className="rounded-3 border border-border-1 bg-surface-well p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 gap-3">
              <RadioMark selected={cli?.authenticated === true} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-fg-1">
                    GitHub CLI auth
                  </h3>
                  {cli?.authenticated ? (
                    <StatusBadge tone="ok">Available</StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral">Not connected</StatusBadge>
                  )}
                </div>
                <p className="mt-2 text-sm text-fg-2">
                  {cli?.authenticated
                    ? `gh is authenticated${cli.login ? ` as ${cli.login}` : ''}.`
                    : (cli?.message ?? 'Install and authenticate gh to use this option.')}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onConnectCli}
              disabled={busy || cli?.authenticated !== true}
              data-testid="github-connect-gh"
            >
              Use gh auth
            </Button>
          </div>
        </div>

        {connected ? (
          <div className="rounded-3 border border-ok bg-ok-muted p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-ok" aria-hidden />
              <div>
                <div className="text-base font-semibold text-fg-1">
                  Connected account{accounts.length > 1 ? 's' : ''}
                </div>
                <div className="mt-1 text-sm text-fg-2">
                  {accounts.map((account) => account.login).join(', ')}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="rounded-3 border border-border-1 bg-surface-well p-4">
          <div className="flex items-start gap-3">
            <RadioMark selected={connected} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-base font-semibold text-fg-1">
                  Personal access token
                </h3>
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm font-medium text-link hover:text-link-hover"
                >
                  Create token
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </div>
              <p className="mt-2 text-sm text-fg-2">
                Paste a GitHub token with repository access. It is encrypted at
                rest and never stored in settings.toml.
              </p>
              <div className="mt-3 flex gap-2">
                <Input
                  type="password"
                  value={pat}
                  onChange={(e) => onPatChange(e.target.value)}
                  placeholder="github_pat_..."
                  disabled={busy}
                  data-testid="github-settings-token-input"
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  variant="primary"
                  onClick={onConnectPat}
                  disabled={busy || pat.trim() === ''}
                  data-testid="github-settings-token-submit"
                >
                  {busy ? 'Connecting...' : 'Connect'}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {error ? (
          <div
            className="rounded-2 border border-danger bg-danger-muted px-3 py-2 text-sm text-danger"
            data-testid="github-auth-error"
          >
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RadioMark({ selected }: { selected: boolean }): React.JSX.Element {
  return (
    <span
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
        selected ? 'border-accent' : 'border-border-2'
      }`}
      aria-hidden
    >
      {selected ? <span className="h-2.5 w-2.5 rounded-full bg-accent" /> : null}
    </span>
  );
}

function StatusBadge({
  tone,
  children,
}: {
  tone: 'ok' | 'neutral';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={`rounded-1 border px-2 py-0.5 text-xs font-medium ${
        tone === 'ok'
          ? 'border-ok bg-ok-muted text-ok'
          : 'border-border-2 bg-bg-3 text-fg-2'
      }`}
    >
      {children}
    </span>
  );
}

function SshKeysPanel({
  keys,
  error,
}: {
  keys: GitSshKey[];
  error: string | null;
}): React.JSX.Element {
  return (
    <div className="py-7" data-testid="git-ssh-keys">
      <div className="mb-4 flex items-center gap-3">
        <KeyRound className="h-5 w-5 text-fg-3" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-fg-1">
            SSH identities
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-fg-2">
            Discovered from ~/.ssh, ~/.gitconfig sshCommand entries, and
            ~/.ssh/config IdentityFile entries.
          </p>
        </div>
      </div>

      {error ? (
        <p className="rounded-2 border border-danger bg-danger-muted px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : keys.length === 0 ? (
        <p className="rounded-2 border border-border-1 bg-surface-well px-3 py-3 text-sm text-fg-3">
          No SSH identity files were discovered on this machine.
        </p>
      ) : (
        <ul className="space-y-2">
          {keys.map((key) => (
            <li
              key={key.path}
              className="rounded-2 border border-border-1 bg-surface-well px-3 py-3"
              data-testid="git-ssh-key"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm text-fg-1">
                    {key.path}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-3">
                    <span>{key.source}</span>
                    {key.type ? <span>{key.type}</span> : null}
                    {key.comment ? <span>{key.comment}</span> : null}
                  </div>
                </div>
                {key.fingerprint ? (
                  <span className="shrink-0 rounded-1 border border-border-1 px-2 py-1 font-mono text-xs text-fg-2">
                    {key.fingerprint}
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-fg-3">
                    no .pub file
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptySection({
  section,
}: {
  section: SettingsSectionId;
}): React.JSX.Element {
  const copy =
    section === 'advanced'
      ? 'Advanced settings will appear here as they are added.'
      : `${SECTION_LABELS[section]} settings are not available yet.`;
  return (
    <div className="rounded-2 border border-border-1 bg-surface-well px-4 py-5 text-sm text-fg-3">
      {copy}
    </div>
  );
}

/**
 * A dismissible banner listing the layer validation issues surfaced by the non-throwing
 * load (`settings:getIssues`) — a bad TOML/zod layer that was SKIPPED rather than crashing
 * the merge. Each row points at the offending `{file, keyPath?, message}` so the user can
 * fix the source file. Dismissal is per-issue-set: a new set (e.g. after a hot-reload that
 * changed the issues) re-shows the banner. Renders nothing when every layer parsed cleanly.
 */
function SettingsIssuesBanner({
  issues,
}: {
  issues: SettingsIssue[];
}): React.JSX.Element | null {
  // Key the dismissal on the issue-set signature so a *different* set of issues (a new
  // bad edit after the user dismissed the last one) surfaces the banner again.
  const signature = issues
    .map((i) => `${i.file}|${i.keyPath ?? ''}|${i.message}`)
    .join('\n');
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (issues.length === 0 || dismissed === signature) return null;

  return (
    <div
      className="border-b border-warn bg-warn-muted px-4 py-2 text-xs text-warn"
      data-testid="settings-issues"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {issues.length === 1
            ? '1 settings issue — a layer was skipped'
            : `${issues.length} settings issues — layers were skipped`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-warn hover:bg-warn-muted hover:text-warn"
          data-testid="settings-issues-dismiss"
          onClick={() => setDismissed(signature)}
        >
          Dismiss
        </Button>
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {issues.map((issue, idx) => (
          <li key={idx} data-testid="settings-issue" className="truncate">
            <span className="font-medium">
              {shortFile(issue.file)}
              {issue.keyPath ? ` · ${issue.keyPath}` : ''}
            </span>{' '}
            — {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Trim a settings-file path to its basename for a compact banner (full path is in the file). */
function shortFile(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] || file;
}
