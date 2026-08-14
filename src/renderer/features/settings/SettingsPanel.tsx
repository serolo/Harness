// SettingsPanel — the settings editor surface (Phase 6, Track B/G). Renders the
// declarative section/field catalogue (`fields.ts`) as rows, each showing the effective
// value + a provenance badge + a write-to-(user)-layer control. Data + writes come from
// `useSettings`; this component is view + wiring only (all main access is inside the
// hook via `@renderer/ipc`).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Folder,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  FolderGit2,
  KeyRound,
  Laptop,
  Palette,
  Pencil,
  Play,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
  Upload,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { GithubAccount, GithubCliAuthStatus } from '@shared/github';
import type { AgentAuthMethod, HarnessId } from '@shared/harness';
import type { HarnessInfo } from '@shared/ipc';
import type { Project } from '@shared/models';
import type { QmdStatus } from '@shared/knowledge';
import {
  isCompletionSound,
  type ProjectSettingsSnapshot,
  type SettingLayer,
  type SettingsIssue,
} from '@shared/settings';
import type { GitSshKey } from '@shared/git';
import { Button, Input, Switch } from '@renderer/components/ui';
import { invoke, subscribeStream } from '@renderer/ipc';
import { useSettings } from './useSettings';
import { SETTINGS_SECTIONS, getAtPath } from './fields';
import { SettingRow } from './SettingRow';
import { RunScriptEditor } from './RunScriptEditor';
import { RepoScriptsEditor } from './RepoScriptsEditor';
import {
  readModelPreferences,
  writeModelPreferences,
} from './modelPreferences';
import {
  resolveProviderModelId,
  visibleProviderModelGroups,
} from '../chat/modelCatalog';
import { AgentMemoryImport } from '../knowledge/AgentMemoryImport';
import { OnboardingLoginTerminal } from '../onboarding/OnboardingLoginTerminal';

export interface SettingsPanelProps {
  /** Close affordance for the overlay host (a header button). */
  onClose?: () => void;
}

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.JSX.Element {
  const { effective, provenance, issues, loading, error, set } = useSettings();
  const [scope, setScope] = useState<'user' | 'repo'>('user');
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>('general');
  const [sshKeys, setSshKeys] = useState<GitSshKey[]>([]);
  const [sshError, setSshError] = useState<string | null>(null);
  const [githubAccounts, setGithubAccounts] = useState<GithubAccount[]>([]);
  const [githubCli, setGithubCli] = useState<GithubCliAuthStatus | null>(null);
  const [githubAuthError, setGithubAuthError] = useState<string | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubLoginOpen, setGithubLoginOpen] = useState(false);
  const [githubAuthMode, setGithubAuthMode] = useState<'cli' | 'pat'>('cli');
  const [githubPat, setGithubPat] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [repoSettings, setRepoSettings] =
    useState<ProjectSettingsSnapshot | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [agents, setAgents] = useState<HarnessInfo[]>([]);
  const [agentLogin, setAgentLogin] = useState<{
    provider: 'claude' | 'codex';
    method: Exclude<AgentAuthMethod, 'none'>;
    force: boolean;
  } | null>(null);
  const [qmdStatus, setQmdStatus] = useState<QmdStatus | null>(null);

  const updateSetting = (keyPath: string, value: unknown): void => {
    void set(keyPath, value)
      .then(async () => {
        if (
          keyPath === 'notifications.completionSound' &&
          isCompletionSound(value)
        ) {
          await invoke('notifications:previewSound', { sound: value });
        }
      })
      .catch(() => {
        // Writes are surfaced by useSettings; sound preview is best-effort.
      });
  };

  useEffect(() => {
    let active = true;
    void invoke('knowledge:qmdStatus', undefined)
      .then((status) => {
        if (active) setQmdStatus(status);
      })
      .catch(() => {
        if (active) setQmdStatus({ installed: false });
      });
    return () => {
      active = false;
    };
  }, []);

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

  const refreshAgents = useCallback(async (): Promise<void> => {
    try {
      setAgents(await invoke('harness:list', undefined));
    } catch {
      // Detection failures are represented as unavailable agents in the UI.
    }
  }, []);

  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  useEffect(() => {
    if (scope !== 'repo') return;
    let active = true;
    setRepoLoading(true);
    void invoke('project:list', undefined)
      .then((nextProjects) => {
        if (!active) return;
        setProjects(nextProjects);
        setSelectedProjectId((current) =>
          current && nextProjects.some((project) => project.id === current)
            ? current
            : (nextProjects[0]?.id ?? null),
        );
        setRepoError(null);
      })
      .catch((err: unknown) => {
        if (active)
          setRepoError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setRepoLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scope]);

  useEffect(() => {
    if (scope !== 'repo' || selectedProjectId === null) {
      setRepoSettings(null);
      return;
    }
    let active = true;
    setRepoLoading(true);
    setRepoSettings(null);
    void invoke('settings:getProject', { projectId: selectedProjectId })
      .then((snapshot) => {
        if (active) {
          setRepoSettings(snapshot);
          setRepoError(null);
        }
      })
      .catch((err: unknown) => {
        if (active)
          setRepoError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setRepoLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scope, selectedProjectId]);

  const updateRepoSetting = (keyPath: string, value: unknown): void => {
    if (selectedProjectId === null) return;
    setRepoError(null);
    void invoke('settings:setProject', {
      projectId: selectedProjectId,
      keyPath,
      value,
    })
      .then(setRepoSettings)
      .catch((err: unknown) =>
        setRepoError(err instanceof Error ? err.message : String(err)),
      );
  };

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

  const logoutGithub = async (): Promise<void> => {
    setGithubBusy(true);
    setGithubAuthError(null);
    try {
      await invoke('github:logoutGhCli', undefined);
      setGithubAccounts([]);
      setGithubCli(await safeGithubCliStatus());
    } catch (err) {
      setGithubAuthError(err instanceof Error ? err.message : String(err));
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
      general: all.filter((field) =>
        field.keyPath.startsWith('notifications.'),
      ),
      agents: all.filter((field) => field.keyPath.startsWith('agent.')),
      git: all.filter((field) => field.keyPath.startsWith('git.')),
      appearance: all.filter((field) =>
        field.keyPath.startsWith('appearance.'),
      ),
    };
  }, []);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-overlay text-fg-1"
      data-testid="settings-panel"
    >
      <div
        className="electron-drag-region h-titlebar shrink-0 bg-surface-overlay"
        data-testid="settings-native-titlebar-space"
        aria-hidden="true"
      />
      <div className="flex h-14 shrink-0 items-center border-b border-border-1 px-5">
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
            <ScopeTab
              active={scope === 'user'}
              onClick={() => setScope('user')}
            >
              User
            </ScopeTab>
            <ScopeTab
              active={scope === 'repo'}
              onClick={() => setScope('repo')}
            >
              Projects
            </ScopeTab>
          </div>
        </div>
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
        <aside
          className="min-h-0 overflow-y-auto border-r border-border-1 bg-surface-panel px-2 py-3"
          data-testid="settings-nav-scroll"
        >
          {scope === 'user' ? (
            <SettingsNav
              active={activeSection}
              onSelect={setActiveSection}
              scope={scope}
            />
          ) : (
            <ProjectSettingsNav
              projects={projects}
              selectedProjectId={selectedProjectId}
              onSelect={setSelectedProjectId}
            />
          )}
        </aside>

        <main
          className="min-h-0 overflow-y-auto"
          data-testid="settings-content-scroll"
        >
          {scope === 'repo' ? (
            <RepoSettingsContent
              projects={projects}
              selectedProjectId={selectedProjectId}
              snapshot={repoSettings}
              loading={repoLoading}
              error={repoError}
              onSet={updateRepoSetting}
              qmdStatus={qmdStatus}
            />
          ) : loading && effective === null ? (
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
                <SettingsSection
                  title="General"
                  testId="settings-section-general"
                >
                  <SettingRows
                    fields={rowsBySection.general}
                    effective={effective}
                    provenance={provenance}
                    onSet={updateSetting}
                  />
                </SettingsSection>
              ) : null}

              {activeSection === 'models' ? <ModelsSettings /> : null}

              {activeSection === 'agents' ? (
                <>
                  <AgentsSettings
                    agents={agents}
                    authenticationTerminal={
                      agentLogin ? (
                        <OnboardingLoginTerminal
                          provider={agentLogin.provider}
                          method={agentLogin.method}
                          force={agentLogin.force}
                          onFinished={() => void refreshAgents()}
                          onClose={() => setAgentLogin(null)}
                          onError={() => undefined}
                        />
                      ) : null
                    }
                    onRefresh={refreshAgents}
                    onSelectionChange={() => setAgentLogin(null)}
                    onRevealApiKey={async (provider) =>
                      provider === 'claude_code'
                        ? (await invoke('agent:revealClaudeApiKey', undefined))
                            .apiKey
                        : (await invoke('agent:revealCodexApiKey', undefined))
                            .apiKey
                    }
                    onSetApiKey={async (provider, apiKey) => {
                      if (provider === 'claude_code') {
                        await invoke('agent:setClaudeApiKey', { apiKey });
                      } else {
                        await invoke('agent:setCodexApiKey', { apiKey });
                      }
                      await refreshAgents();
                    }}
                    onDeleteApiKey={async (provider) => {
                      if (provider === 'claude_code') {
                        await invoke('agent:deleteClaudeApiKey', undefined);
                      } else {
                        await invoke('agent:deleteCodexApiKey', undefined);
                      }
                      await refreshAgents();
                    }}
                    onAuthenticate={(id, method) => {
                      if (id === 'claude_code' || id === 'codex') {
                        setAgentLogin({
                          provider: id === 'claude_code' ? 'claude' : 'codex',
                          method,
                          force: true,
                        });
                      }
                    }}
                  >
                    <SettingRows
                      fields={rowsBySection.agents}
                      effective={effective}
                      provenance={provenance}
                      onSet={updateSetting}
                    />
                  </AgentsSettings>
                </>
              ) : null}

              {activeSection === 'git' ? (
                <SettingsSection title="Git" testId="settings-section-git">
                  <GithubAuthPanel
                    accounts={githubAccounts}
                    cli={githubCli}
                    mode={githubAuthMode}
                    busy={githubBusy}
                    error={githubAuthError}
                    pat={githubPat}
                    onPatChange={setGithubPat}
                    onModeChange={setGithubAuthMode}
                    onRefresh={() => void refreshGithubAuth()}
                    onConnectCli={() => {
                      if (githubCli?.authenticated) {
                        void connectGithubFromCli();
                      } else {
                        setGithubLoginOpen(true);
                      }
                    }}
                    onLogout={() => void logoutGithub()}
                    onConnectPat={() => void connectGithubPat()}
                  />
                  {githubLoginOpen ? (
                    <OnboardingLoginTerminal
                      provider="github"
                      onFinished={(authenticated) => {
                        if (authenticated) void refreshGithubAuth();
                      }}
                      onClose={() => setGithubLoginOpen(false)}
                      onError={setGithubAuthError}
                    />
                  ) : null}
                  <SettingRows
                    fields={rowsBySection.git}
                    effective={effective}
                    provenance={provenance}
                    onSet={updateSetting}
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
                      onSet={updateSetting}
                    />
                  ) : null}
                </SettingsSection>
              ) : null}

              {activeSection === 'appearance' ? (
                <SettingsSection
                  title="Appearance"
                  testId="settings-section-appearance"
                >
                  <SettingRows
                    fields={rowsBySection.appearance}
                    effective={effective}
                    provenance={provenance}
                    onSet={updateSetting}
                  />
                </SettingsSection>
              ) : null}

              {activeSection === 'advanced' ? <AdvancedSettings /> : null}

              {activeSection !== 'general' &&
              activeSection !== 'models' &&
              activeSection !== 'agents' &&
              activeSection !== 'git' &&
              activeSection !== 'environment' &&
              activeSection !== 'appearance' &&
              activeSection !== 'advanced' ? (
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
        message:
          'Restart the app to enable GitHub CLI auth in this dev session.',
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
  | 'models'
  | 'agents'
  | 'environment'
  | 'git'
  | 'appearance'
  | 'advanced';

const SECTION_LABELS: Record<SettingsSectionId, string> = {
  general: 'General',
  models: 'Models',
  agents: 'Agents',
  environment: 'Environment',
  git: 'Git',
  appearance: 'Appearance',
  advanced: 'Advanced',
};

const PRIMARY_NAV: Array<{
  id: SettingsSectionId;
  icon: LucideIcon;
}> = [
  { id: 'general', icon: Settings2 },
  { id: 'models', icon: Bot },
  { id: 'agents', icon: TerminalSquare },
  { id: 'environment', icon: Laptop },
  { id: 'git', icon: GitBranch },
  { id: 'appearance', icon: Palette },
  { id: 'advanced', icon: SlidersHorizontal },
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
    <nav className="space-y-1">
      {PRIMARY_NAV.map((item) => (
        <NavButton
          key={item.id}
          item={item}
          active={active === item.id}
          onClick={() => onSelect(item.id)}
        />
      ))}
    </nav>
  );
}

function ProjectSettingsNav({
  projects,
  selectedProjectId,
  onSelect,
}: {
  projects: Project[];
  selectedProjectId: string | null;
  onSelect: (projectId: string) => void;
}): React.JSX.Element {
  return (
    <nav data-testid="repo-project-list">
      <div className="space-y-1">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            data-testid={`repo-project-${project.id}`}
            onClick={() => onSelect(project.id)}
            className={`flex w-full items-center gap-3 rounded-2 px-3 py-2.5 text-left ${
              selectedProjectId === project.id
                ? 'bg-bg-4 text-fg-1'
                : 'text-fg-2 hover:bg-bg-3 hover:text-fg-1'
            }`}
          >
            <FolderGit2 className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {project.name}
              </span>
              <span className="block truncate text-2xs text-fg-3">
                {project.repoPath}
              </span>
            </span>
          </button>
        ))}
        {projects.length === 0 ? (
          <p className="px-3 py-2 text-xs text-fg-3">No projects added yet.</p>
        ) : null}
      </div>
    </nav>
  );
}

function RepoSettingsContent({
  projects,
  selectedProjectId,
  snapshot,
  loading,
  error,
  onSet,
  qmdStatus,
}: {
  projects: Project[];
  selectedProjectId: string | null;
  snapshot: ProjectSettingsSnapshot | null;
  loading: boolean;
  error: string | null;
  onSet: (keyPath: string, value: unknown) => void;
  qmdStatus: QmdStatus | null;
}): React.JSX.Element {
  const [activeProjectSection, setActiveProjectSection] = useState<
    'scripts' | 'knowledge'
  >('scripts');
  const [knowledgeImporting, setKnowledgeImporting] = useState(false);
  const [knowledgeImportMessage, setKnowledgeImportMessage] = useState<
    string | null
  >(null);
  const [knowledgeCatalogUpdating, setKnowledgeCatalogUpdating] =
    useState(false);
  const [knowledgeCatalogMessage, setKnowledgeCatalogMessage] = useState<
    string | null
  >(null);
  const project = projects.find((item) => item.id === selectedProjectId);

  const importKnowledgeZip = (): void => {
    if (selectedProjectId === null) return;
    setKnowledgeImporting(true);
    setKnowledgeImportMessage(null);
    void invoke('knowledge:importZip', { projectId: selectedProjectId })
      .then((result) => {
        if (result.proposalId) {
          setKnowledgeImportMessage(
            `Created a review proposal for ${result.fileCount} files: ${result.createdCount} new, ${result.updatedCount} updated.`,
          );
          return;
        }
        if (!result.imported) {
          setKnowledgeImportMessage('Import canceled.');
          return;
        }
        setKnowledgeImportMessage(
          `Imported ${result.fileCount} files: ${result.createdCount} new, ${result.updatedCount} updated.`,
        );
      })
      .catch((reason: unknown) =>
        setKnowledgeImportMessage(
          reason instanceof Error ? reason.message : String(reason),
        ),
      )
      .finally(() => setKnowledgeImporting(false));
  };

  const updateKnowledgeCatalog = (): void => {
    if (selectedProjectId === null) return;
    setKnowledgeCatalogUpdating(true);
    setKnowledgeCatalogMessage(null);
    void invoke('knowledge:updateCatalog', { projectId: selectedProjectId })
      .then((result) =>
        setKnowledgeCatalogMessage(
          result.updated
            ? `Catalog updated with ${result.pageCount} pages.${
                result.repairedCount > 0
                  ? ` Repaired ${result.repairedCount} statusless ${result.repairedCount === 1 ? 'page' : 'pages'}.`
                  : ''
              }`
            : `Catalog is already current with ${result.pageCount} pages.`,
        ),
      )
      .catch((reason: unknown) =>
        setKnowledgeCatalogMessage(
          reason instanceof Error ? reason.message : String(reason),
        ),
      )
      .finally(() => setKnowledgeCatalogUpdating(false));
  };

  if (loading && snapshot === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-3">
        Loading repository settings…
      </div>
    );
  }
  if (project === undefined) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-fg-3">
        Add a project to configure its workspace scripts.
      </div>
    );
  }
  if (snapshot === null) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-danger">
        {error ?? 'Repository settings could not be loaded.'}
      </div>
    );
  }

  return (
    <div
      className="mx-auto w-full max-w-[980px] px-10 py-10"
      data-testid="repo-settings-content"
    >
      <div className="mb-9">
        <h1 className="font-display text-xl font-semibold text-fg-1">
          {project.name}
        </h1>
        <p className="mt-1 truncate text-xs text-fg-3">
          Stored locally in the Harness database
        </p>
      </div>
      <div
        className="mb-8 flex border-b border-border-1"
        role="tablist"
        aria-label="Project settings sections"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeProjectSection === 'scripts'}
          data-testid="repo-settings-tab-scripts"
          onClick={() => setActiveProjectSection('scripts')}
          className={`border-b-2 px-4 py-3 text-sm font-semibold ${
            activeProjectSection === 'scripts'
              ? 'border-accent text-fg-1'
              : 'border-transparent text-fg-3 hover:text-fg-1'
          }`}
        >
          Scripts
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeProjectSection === 'knowledge'}
          data-testid="repo-settings-tab-knowledge"
          onClick={() => setActiveProjectSection('knowledge')}
          className={`border-b-2 px-4 py-3 text-sm font-semibold ${
            activeProjectSection === 'knowledge'
              ? 'border-accent text-fg-1'
              : 'border-transparent text-fg-3 hover:text-fg-1'
          }`}
        >
          Project knowledge
        </button>
      </div>
      {error ? (
        <div className="mb-5 rounded-2 border border-danger bg-danger-muted px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}
      <SettingsIssuesBanner issues={snapshot.issues} />
      {activeProjectSection === 'scripts' ? (
        <div role="tabpanel" aria-label="Scripts">
          <RepoScriptsEditor
            scripts={snapshot.settings.scripts}
            onSet={onSet}
          />
        </div>
      ) : (
        <div role="tabpanel" aria-label="Project knowledge">
          <h2 className="font-display text-lg font-semibold text-fg-1">
            Project knowledge
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-3">
            Maintain a local, Git-backed wiki as an Open Knowledge Format v0.1
            bundle. Agent changes require human review before becoming
            canonical.
          </p>
          <div className="mt-5 flex items-center justify-between rounded-2 border border-border-1 bg-surface-panel px-4 py-3">
            <div>
              <div className="text-sm font-medium text-fg-1">
                Enable knowledge wiki
              </div>
              <div className="mt-0.5 text-xs text-fg-3">
                Disabled projects perform no initialization, indexing, or
                extraction.
              </div>
            </div>
            <Switch
              checked={snapshot.settings.knowledge.enabled}
              onChange={(checked) => onSet('knowledge.enabled', checked)}
              aria-label="Enable project knowledge wiki"
            />
          </div>
          {snapshot.settings.knowledge.enabled ? (
            <>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <KnowledgeToggle
                  label="Allow project knowledge retrieval"
                  description="Let agents search and read bounded canonical knowledge on demand."
                  checked={snapshot.settings.knowledge.inject_context}
                  onChange={(checked) =>
                    onSet('knowledge.inject_context', checked)
                  }
                />
                <KnowledgeToggle
                  label="Extract after each turn"
                  description="Capture review proposals from durable turn outcomes."
                  checked={snapshot.settings.knowledge.extract_after_turn}
                  onChange={(checked) =>
                    onSet('knowledge.extract_after_turn', checked)
                  }
                />
                <KnowledgeToggle
                  label="Enable local search"
                  description="Search canonical pages locally before any page can be read."
                  checked={snapshot.settings.knowledge.search.enabled}
                  onChange={(checked) =>
                    onSet('knowledge.search.enabled', checked)
                  }
                />
                <KnowledgeToggle
                  label="Rerank QMD results"
                  description="Use QMD reranking when that provider is selected."
                  checked={snapshot.settings.knowledge.search.rerank}
                  onChange={(checked) =>
                    onSet('knowledge.search.rerank', checked)
                  }
                />
              </div>
              <div className="mt-3 flex items-center justify-between rounded-2 border border-border-1 bg-surface-panel px-4 py-3">
                <div>
                  <label
                    htmlFor="knowledge-search-provider"
                    className="text-sm font-medium text-fg-1"
                  >
                    Search provider
                  </label>
                  {snapshot.settings.knowledge.search.provider === 'qmd' ? (
                    <div className="mt-0.5 text-xs text-fg-3">
                      Requires the qmd CLI. The first query may download local
                      embedding and reranking models.
                    </div>
                  ) : null}
                </div>
                <select
                  id="knowledge-search-provider"
                  value={snapshot.settings.knowledge.search.provider}
                  onChange={(event) =>
                    onSet('knowledge.search.provider', event.target.value)
                  }
                  className="rounded-2 border border-border-1 bg-bg-3 px-3 py-2 text-sm text-fg-1"
                >
                  <option value="basic">Basic local search</option>
                  <option value="qmd" disabled={!qmdStatus?.installed}>
                    QMD{qmdStatus?.installed ? '' : ' (not installed)'}
                  </option>
                  <option value="none">None</option>
                </select>
              </div>
              <div className="mt-3 grid gap-3 rounded-2 border border-border-1 bg-surface-panel p-4 md:grid-cols-2">
                <label className="text-sm text-fg-1">
                  Maximum search results
                  <input
                    aria-label="Maximum knowledge search results"
                    className="mt-2 w-full rounded-2 border border-border-1 bg-bg-3 px-3 py-2 text-sm"
                    type="number"
                    min={1}
                    max={100}
                    value={snapshot.settings.knowledge.search.max_results}
                    onChange={(event) =>
                      onSet(
                        'knowledge.search.max_results',
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
                <label className="text-sm text-fg-1">
                  Maximum context tokens
                  <input
                    aria-label="Maximum knowledge context tokens"
                    className="mt-2 w-full rounded-2 border border-border-1 bg-bg-3 px-3 py-2 text-sm"
                    type="number"
                    min={256}
                    value={
                      snapshot.settings.knowledge.search.max_context_tokens
                    }
                    onChange={(event) =>
                      onSet(
                        'knowledge.search.max_context_tokens',
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
              </div>
              <div className="mt-3 flex items-center justify-between gap-4 rounded-2 border border-border-1 bg-surface-panel px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-fg-1">
                    Import existing knowledge
                  </div>
                  <div className="mt-0.5 text-xs text-fg-3">
                    Scan a preexisting OKF ZIP bundle and create a review
                    proposal. Accepted changes are preserved in Git history.
                  </div>
                  {knowledgeImportMessage ? (
                    <div
                      className="mt-2 text-xs text-fg-2"
                      data-testid="knowledge-import-message"
                    >
                      {knowledgeImportMessage}
                    </div>
                  ) : null}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={knowledgeImporting}
                  data-testid="knowledge-import-zip"
                  onClick={importKnowledgeZip}
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden />
                  {knowledgeImporting ? 'Importing…' : 'Import ZIP'}
                </Button>
              </div>
              <AgentMemoryImport projectId={project.id} />
              <div className="mt-3 flex items-center justify-between gap-4 rounded-2 border border-border-1 bg-surface-panel px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-fg-1">
                    Knowledge catalog
                  </div>
                  <div className="mt-0.5 text-xs text-fg-3">
                    Rebuild index.md from every canonical knowledge document.
                  </div>
                  {knowledgeCatalogMessage ? (
                    <div
                      className="mt-2 text-xs text-fg-2"
                      data-testid="knowledge-catalog-message"
                    >
                      {knowledgeCatalogMessage}
                    </div>
                  ) : null}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={knowledgeCatalogUpdating}
                  data-testid="knowledge-update-catalog"
                  onClick={updateKnowledgeCatalog}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  {knowledgeCatalogUpdating ? 'Updating…' : 'Update catalog'}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )}
      <p className="mt-8 text-xs text-fg-3">
        These settings are stored locally in the Harness database.
      </p>
    </div>
  );
}

function KnowledgeToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2 border border-border-1 bg-surface-panel px-4 py-3">
      <div>
        <div className="text-sm font-medium text-fg-1">{label}</div>
        <div className="mt-0.5 text-xs text-fg-3">{description}</div>
      </div>
      <Switch checked={checked} onChange={onChange} aria-label={label} />
    </div>
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
        active ? 'bg-bg-4 text-fg-1' : 'text-fg-2 hover:bg-bg-3 hover:text-fg-1'
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {SECTION_LABELS[item.id]}
    </button>
  );
}

const EFFORT_OPTIONS = [
  ['low', 'Effort low'],
  ['medium', 'Effort medium'],
  ['high', 'Effort high'],
  ['max', 'Effort max'],
] as const;

function ModelsSettings(): React.JSX.Element {
  const [preferences, setPreferences] = useState(readModelPreferences);
  const updatePreference = (
    key: keyof typeof preferences,
    value: string | boolean,
  ): void => {
    setPreferences((current) => {
      const next = { ...current, [key]: value };
      writeModelPreferences(next);
      return next;
    });
  };

  return (
    <section data-testid="settings-section-models">
      <h1 className="mb-10 font-display text-3xl font-semibold text-fg-1">
        Models
      </h1>
      <div className="divide-y divide-border-1">
        <ModelPreferenceRow
          title="Default model"
          description="Model for new chats"
          model={preferences.defaultModel}
          effort={preferences.defaultEffort}
          onModelChange={(value) => updatePreference('defaultModel', value)}
          onEffortChange={(value) => updatePreference('defaultEffort', value)}
          testId="default"
        />
        <ModelPreferenceRow
          title="Review model"
          description="Model for code reviews"
          model={preferences.reviewModel}
          effort={preferences.reviewEffort}
          onModelChange={(value) => updatePreference('reviewModel', value)}
          onEffortChange={(value) => updatePreference('reviewEffort', value)}
          testId="review"
        />
        <SettingsToggleRow
          title="Default to fast mode"
          description="Start new chats in fast mode"
          checked={preferences.fastMode}
          onCheckedChange={(value) => updatePreference('fastMode', value)}
          testId="models-fast-mode"
        />
      </div>
    </section>
  );
}

function ModelPreferenceRow({
  title,
  description,
  model,
  effort,
  onModelChange,
  onEffortChange,
  testId,
}: {
  title: string;
  description: string;
  model: string;
  effort: string;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  testId: string;
}): React.JSX.Element {
  return (
    <div className="grid min-h-32 grid-cols-[minmax(240px,1fr)_minmax(420px,0.9fr)] items-center gap-10 border-l-2 border-accent pl-4">
      <div>
        <h2 className="text-base font-semibold text-fg-1">{title}</h2>
        <p className="mt-2 text-base text-fg-3">{description}</p>
      </div>
      <div className="grid grid-cols-2 overflow-hidden rounded-2 border border-border-2 bg-surface-well">
        <select
          value={resolveProviderModelId(model)}
          onChange={(event) => onModelChange(event.target.value)}
          data-testid={`models-${testId}-model`}
          aria-label={`${title} model`}
          className="h-12 min-w-0 border-r border-border-2 bg-transparent px-4 text-base text-fg-1 outline-none"
        >
          {visibleProviderModelGroups().map((group) => (
            <optgroup key={group.id} label={group.label}>
              {group.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          value={effort}
          onChange={(event) => onEffortChange(event.target.value)}
          data-testid={`models-${testId}-effort`}
          aria-label={`${title} effort`}
          className="h-12 min-w-0 bg-transparent px-4 text-base text-fg-1 outline-none"
        >
          {EFFORT_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function SettingsToggleRow({
  title,
  description,
  checked,
  onCheckedChange,
  testId,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  testId: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-28 items-center justify-between gap-8 py-5">
      <div>
        <h2 className="text-base font-semibold text-fg-1">{title}</h2>
        <p className="mt-2 text-base text-fg-3">{description}</p>
      </div>
      <Switch
        checked={checked}
        onChange={onCheckedChange}
        data-testid={testId}
        aria-label={title}
      />
    </div>
  );
}

const AGENT_TABS: Array<{ id: HarnessId; label: string }> = [
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

const AGENT_AUTH_COPY: Record<
  HarnessId,
  {
    cliTitle: string;
    cliDetail: string;
    apiTitle: string;
    apiDetail: string;
    supportsApiKey: boolean;
  }
> = {
  claude_code: {
    cliTitle: 'CLI',
    cliDetail: 'Use the account signed in through Claude Code',
    apiTitle: 'API Key',
    apiDetail: 'Use an Anthropic API key',
    supportsApiKey: true,
  },
  codex: {
    cliTitle: 'CLI',
    cliDetail: 'Use your ChatGPT plan',
    apiTitle: 'API key',
    apiDetail: 'Use OpenAI Platform usage billing',
    supportsApiKey: true,
  },
  cursor: {
    cliTitle: 'Cursor account',
    cliDetail: 'Use the account signed in through Cursor CLI',
    apiTitle: 'API key',
    apiDetail: 'Not supported by the Cursor CLI',
    supportsApiKey: false,
  },
};

function AgentsSettings({
  agents,
  authenticationTerminal,
  onRefresh,
  onSelectionChange,
  onRevealApiKey,
  onSetApiKey,
  onDeleteApiKey,
  onAuthenticate,
  children,
}: {
  agents: HarnessInfo[];
  authenticationTerminal: React.ReactNode;
  onRefresh: () => Promise<void>;
  onSelectionChange: () => void;
  onRevealApiKey: (provider: 'claude_code' | 'codex') => Promise<string>;
  onSetApiKey: (
    provider: 'claude_code' | 'codex',
    apiKey: string,
  ) => Promise<void>;
  onDeleteApiKey: (provider: 'claude_code' | 'codex') => Promise<void>;
  onAuthenticate: (
    id: HarnessId,
    method: Exclude<AgentAuthMethod, 'none'>,
  ) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const [selected, setSelected] = useState<HarnessId>('claude_code');
  const [selectedAuthMethod, setSelectedAuthMethod] =
    useState<Exclude<AgentAuthMethod, 'none'>>('cli');
  const [refreshing, setRefreshing] = useState(false);
  const [editingApiKey, setEditingApiKey] = useState(false);
  const info = agents.find((agent) => agent.id === selected);
  const connected = info?.detect.authenticated ?? false;
  const installed = info?.detect.installed ?? false;
  const authMethod: AgentAuthMethod = connected
    ? (info?.detect.authMethod ?? 'cli')
    : 'none';
  const authCopy = AGENT_AUTH_COPY[selected];
  const selectedMethodTitle =
    selectedAuthMethod === 'api_key' ? authCopy.apiTitle : authCopy.cliTitle;
  const selectedMethodConnected =
    connected && authMethod === selectedAuthMethod;
  const selectedMethodSupported =
    selectedAuthMethod === 'cli' || authCopy.supportsApiKey;
  const canLogin =
    selected !== 'cursor' &&
    selectedMethodSupported &&
    !selectedMethodConnected;
  const isManagedApiKey =
    (selected === 'claude_code' || selected === 'codex') &&
    selectedAuthMethod === 'api_key';
  const isManagedCli =
    (selected === 'claude_code' || selected === 'codex') &&
    selectedAuthMethod === 'cli';

  useEffect(() => {
    if (authMethod !== 'none') setSelectedAuthMethod(authMethod);
  }, [authMethod, selected]);

  useEffect(() => {
    setEditingApiKey(false);
  }, [selected, selectedAuthMethod]);

  const selectMethod = (method: Exclude<AgentAuthMethod, 'none'>): void => {
    setSelectedAuthMethod(method);
    onSelectionChange();
  };

  const refresh = (): void => {
    setRefreshing(true);
    void onRefresh().finally(() => setRefreshing(false));
  };

  return (
    <section data-testid="settings-section-agents">
      <h1 className="mb-8 font-display text-3xl font-semibold text-fg-1">
        Agents
      </h1>
      <div className="mb-7 flex gap-7 border-b border-border-1">
        {AGENT_TABS.map((agent) => (
          <button
            key={agent.id}
            type="button"
            data-testid={`agent-tab-${agent.id}`}
            onClick={() => {
              setSelected(agent.id);
              onSelectionChange();
            }}
            className={`border-b-2 px-1 pb-3 text-sm font-semibold ${
              selected === agent.id
                ? 'border-accent text-fg-1'
                : 'border-transparent text-fg-3 hover:text-fg-1'
            }`}
          >
            {agent.label}
          </button>
        ))}
      </div>

      <div className="border-l-2 border-accent pl-4">
        <h2 className="mb-4 text-base font-semibold text-fg-1">
          Authentication
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <AgentAuthCard
            method="cli"
            title={authCopy.cliTitle}
            selected={selectedAuthMethod === 'cli'}
            disabled={false}
            detail={
              !installed
                ? 'CLI not detected on this machine'
                : authMethod === 'cli'
                  ? `${authCopy.cliDetail} · Current`
                  : authCopy.cliDetail
            }
            onClick={() => selectMethod('cli')}
          />
          <AgentAuthCard
            method="api_key"
            title={authCopy.apiTitle}
            selected={selectedAuthMethod === 'api_key'}
            disabled={!authCopy.supportsApiKey}
            detail={
              !authCopy.supportsApiKey
                ? authCopy.apiDetail
                : !installed
                  ? 'CLI not detected on this machine'
                  : authMethod === 'api_key'
                    ? `${authCopy.apiDetail} · Current`
                    : authCopy.apiDetail
            }
            onClick={() => selectMethod('api_key')}
          />
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <span
          className={`flex items-center gap-2 text-sm ${
            selectedMethodConnected ? 'text-success' : 'text-danger'
          }`}
          data-testid="agent-connection-status"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              selectedMethodConnected ? 'bg-success' : 'bg-danger'
            }`}
            aria-hidden
          />
          {selectedMethodConnected
            ? isManagedApiKey || isManagedCli
              ? 'Connected'
              : `${selectedMethodTitle} connected`
            : `${selectedMethodTitle} not authenticated`}
        </span>
        <button
          type="button"
          data-testid="agent-auth-refresh"
          disabled={refreshing}
          onClick={refresh}
          className="flex items-center gap-2 text-sm text-fg-2 hover:text-fg-1 disabled:opacity-60"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
            aria-hidden
          />
          Refresh
        </button>
      </div>

      {canLogin ? (
        <button
          type="button"
          data-testid="agent-auth-login"
          onClick={() => {
            if (isManagedApiKey) setEditingApiKey(true);
            else onAuthenticate(selected, selectedAuthMethod);
          }}
          className="mt-5 flex items-center gap-2 rounded-lg border border-border-2 px-4 py-2 text-sm font-medium text-fg-1 hover:bg-bg-4"
        >
          {isManagedApiKey ? (
            <KeyRound className="h-4 w-4" aria-hidden />
          ) : (
            <TerminalSquare className="h-4 w-4" aria-hidden />
          )}
          {isManagedApiKey
            ? 'Add API Key'
            : `Login with ${selectedMethodTitle}`}
        </button>
      ) : null}

      {isManagedApiKey && editingApiKey ? (
        <AgentApiKeyEditor
          provider={selected}
          onSave={async (apiKey) => {
            await onSetApiKey(selected, apiKey);
            setEditingApiKey(false);
          }}
          onCancel={() => setEditingApiKey(false)}
        />
      ) : null}

      {isManagedApiKey && selectedMethodConnected ? (
        <AgentApiKeyDetails
          provider={selected}
          version={info?.detect.version}
          credentialHint={info?.detect.credentialHint}
          onReveal={() => onRevealApiKey(selected)}
          onEdit={() => setEditingApiKey(true)}
          onDelete={() => onDeleteApiKey(selected)}
        />
      ) : isManagedCli && selectedMethodConnected ? (
        <AgentCliDetails
          provider={selected}
          info={info}
          onRelogin={() => onAuthenticate(selected, 'cli')}
        />
      ) : (
        <div className="mt-5 text-right text-sm text-fg-2">
          Version {info?.detect.version ?? '—'}
        </div>
      )}

      {authenticationTerminal ? (
        <div className="mt-4" data-testid="agent-auth-terminal-slot">
          {authenticationTerminal}
        </div>
      ) : null}

      {info ? (
        <div className="mt-7 border-y border-border-1 py-5">
          <h2 className="text-sm font-semibold text-fg-2">Capabilities</h2>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-fg-2">
            <AgentCapability
              label="Resume sessions"
              enabled={info.capabilities.supportsResume}
            />
            <AgentCapability
              label="MCP servers"
              enabled={info.capabilities.supportsMcp}
            />
            <AgentCapability
              label="Plan mode"
              enabled={info.capabilities.supportsPlanMode}
            />
            <AgentCapability
              label="Raw terminal"
              enabled={info.capabilities.rawTerminalFallback}
            />
          </div>
        </div>
      ) : null}

      <div className="mt-8">
        <h2 className="mb-2 text-sm font-semibold text-fg-2">Agent defaults</h2>
        <div className="divide-y divide-border-1">{children}</div>
      </div>
    </section>
  );
}

function AgentCliDetails({
  provider,
  info,
  onRelogin,
}: {
  provider: 'claude_code' | 'codex';
  info: HarnessInfo | undefined;
  onRelogin: () => void;
}): React.JSX.Element {
  return (
    <div className="mt-6" data-testid="agent-cli-details">
      <dl className="overflow-hidden rounded-xl border border-border-2 text-sm">
        <AgentDetailRow
          label="Provider"
          value={
            info?.detect.providerLabel ??
            (provider === 'claude_code' ? 'anthropic' : 'openai')
          }
        />
        <AgentDetailRow label="Plan" value={info?.detect.planLabel ?? '—'} />
        <AgentDetailRow
          label="Auth"
          value={
            info?.detect.authLabel ??
            (provider === 'claude_code' ? 'Claude login' : 'ChatGPT login')
          }
        />
        <AgentDetailRow
          label="Account"
          value={info?.detect.accountLabel ?? '—'}
          last
        />
      </dl>
      <button
        type="button"
        data-testid="agent-cli-relogin"
        onClick={onRelogin}
        className="mt-5 flex items-center gap-2 rounded-lg border border-border-2 px-4 py-2 text-sm font-medium text-fg-1 hover:bg-bg-4"
      >
        <Play className="h-4 w-4 fill-current" aria-hidden />
        Run {provider === 'claude_code' ? 'claude' : 'codex'} login
      </button>
    </div>
  );
}

function AgentApiKeyDetails({
  provider,
  version,
  credentialHint,
  onReveal,
  onEdit,
  onDelete,
}: {
  provider: 'claude_code' | 'codex';
  version: string | undefined;
  credentialHint: string | undefined;
  onReveal: () => Promise<string>;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}): React.JSX.Element {
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = (): void => {
    if (revealedKey !== null) {
      setRevealedKey(null);
      return;
    }
    setBusy(true);
    setError(null);
    void onReveal()
      .then(setRevealedKey)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };

  const remove = (): void => {
    const providerName = provider === 'claude_code' ? 'Claude' : 'Codex';
    if (!window.confirm(`Delete the saved ${providerName} API key?`)) return;
    setBusy(true);
    setError(null);
    void onDelete()
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-6" data-testid="agent-api-key-details">
      <dl className="overflow-hidden rounded-xl border border-border-2 text-sm">
        <AgentDetailRow label="Version" value={version ?? '—'} />
        <AgentDetailRow
          label="Provider"
          value={provider === 'claude_code' ? 'Anthropic API' : 'OpenAI API'}
        />
        <AgentDetailRow label="Auth" value="API key" last />
      </dl>
      <div className="mt-5 flex items-center gap-3 rounded-xl border border-border-2 px-4 py-4 text-fg-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm"
          data-testid="agent-api-key-value"
        >
          {revealedKey ?? `••••••••${credentialHint ?? ''}`}
        </span>
        <button
          type="button"
          aria-label={revealedKey ? 'Hide API key' : 'View API key'}
          disabled={busy}
          onClick={reveal}
        >
          {revealedKey ? (
            <EyeOff className="h-5 w-5" />
          ) : (
            <Eye className="h-5 w-5" />
          )}
        </button>
        <button
          type="button"
          aria-label="Edit API key"
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="Delete API key"
          disabled={busy}
          onClick={remove}
        >
          <Trash2 className="h-5 w-5" />
        </button>
      </div>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </div>
  );
}

function AgentApiKeyEditor({
  provider,
  onSave,
  onCancel,
}: {
  provider: 'claude_code' | 'codex';
  onSave: (apiKey: string) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (): void => {
    setBusy(true);
    setError(null);
    void onSave(apiKey)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="mt-4 rounded-xl border border-border-2 bg-surface-well p-4"
      data-testid="agent-api-key-editor"
    >
      <label
        className="text-sm font-medium text-fg-1"
        htmlFor="agent-api-key-input"
      >
        {provider === 'claude_code' ? 'Anthropic' : 'OpenAI'} API key
      </label>
      <Input
        id="agent-api-key-input"
        type="password"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        placeholder="sk-ant-…"
        className="mt-3"
      />
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      <div className="mt-4 flex gap-2">
        <Button disabled={busy || apiKey.length === 0} onClick={save}>
          Save
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AgentDetailRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`grid grid-cols-[150px_1fr] ${last ? '' : 'border-b border-border-2'}`}
    >
      <dt className="bg-surface-well px-4 py-3 text-fg-3">{label}</dt>
      <dd className="px-4 py-3 text-fg-1">{value}</dd>
    </div>
  );
}

function AgentAuthCard({
  method,
  title,
  selected,
  disabled,
  detail,
  onClick,
}: {
  method: Exclude<AgentAuthMethod, 'none'>;
  title: string;
  selected: boolean;
  disabled: boolean;
  detail: string;
  onClick: () => void;
}): React.JSX.Element {
  const Icon = method === 'cli' ? TerminalSquare : KeyRound;
  return (
    <button
      type="button"
      data-testid={`agent-auth-${method}`}
      data-selected={selected ? 'true' : 'false'}
      disabled={disabled}
      onClick={onClick}
      className={`relative flex min-h-28 flex-col items-center justify-center rounded-2 border ${
        selected
          ? 'border-accent bg-bg-4 text-fg-1'
          : 'border-border-1 bg-surface-well text-fg-2 enabled:hover:border-border-2 enabled:hover:bg-bg-4'
      } disabled:cursor-default disabled:opacity-70`}
    >
      {selected ? (
        <CheckCircle2 className="absolute right-3 top-3 h-4 w-4" aria-hidden />
      ) : null}
      <Icon className="mb-2 h-5 w-5" aria-hidden />
      <span className="text-sm font-semibold">{title}</span>
      <span className="mt-1 text-xs text-fg-3">{detail}</span>
    </button>
  );
}

function AgentCapability({
  label,
  enabled,
}: {
  label: string;
  enabled: boolean;
}): React.JSX.Element {
  return (
    <span
      className={`rounded-lg border px-2 py-1 ${
        enabled
          ? 'border-border-2 bg-surface-well'
          : 'border-border-1 text-fg-3 line-through'
      }`}
    >
      {label}
    </span>
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

function AdvancedSettings(): React.JSX.Element {
  const [rootPath, setRootPath] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [defaultPath, setDefaultPath] = useState('');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [isDevelopment, setIsDevelopment] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let active = true;
    void invoke('app:getRootDirectory', undefined)
      .then((result) => {
        if (!active) return;
        setRootPath(result.path);
        setSavedPath(result.path);
        setDefaultPath(result.defaultPath);
        setMessage(null);
      })
      .catch((reason: unknown) => {
        if (active)
          setMessage(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void invoke('app:isDevelopment', undefined)
      .then((value) => {
        if (active) setIsDevelopment(value);
      })
      .catch(() => {
        // Packaged/older main processes simply omit the development-only control.
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (path: string): Promise<void> => {
    const nextPath = path.trim();
    if (nextPath === '' || nextPath === savedPath) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await invoke('app:setRootDirectory', { path: nextPath });
      setRootPath(result.path);
      setSavedPath(result.path);
      setMessage(
        'Root directory updated. Existing files were left in their previous location.',
      );
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const browse = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const selected = await invoke('app:pickRootDirectory', {
        defaultPath: rootPath || defaultPath,
      });
      if (selected !== null) await save(selected);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const resetDevelopmentData = async (): Promise<void> => {
    const confirmed = window.confirm(
      'Delete all Harness database records, settings, secrets, and managed repositories/worktrees? The app will restart as a fresh install. This cannot be undone.',
    );
    if (!confirmed) return;
    setResetting(true);
    setMessage(null);
    try {
      await invoke('app:resetDevelopmentData', undefined);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setResetting(false);
    }
  };

  return (
    <SettingsSection title="Advanced" testId="settings-section-advanced">
      <div className="py-6 first:pt-0">
        <label
          htmlFor="harness-root-directory"
          className="text-sm font-semibold text-fg-1"
        >
          Harness root directory
        </label>
        <p className="mt-1 text-sm leading-6 text-fg-3">
          Where Harness stores managed repositories and workspaces. The default
          is {defaultPath || '$HOME/harness'}. Changing this location does not
          move or delete existing files.
        </p>
        <div className="mt-4 flex w-full gap-3">
          <Input
            id="harness-root-directory"
            data-testid="advanced-root-directory"
            value={rootPath}
            disabled={busy}
            onChange={(event) => setRootPath(event.target.value)}
            onBlur={() => void save(rootPath)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
            className="min-w-0 flex-1 font-mono"
          />
          <Button
            type="button"
            variant="secondary"
            data-testid="advanced-root-browse"
            disabled={busy}
            onClick={() => void browse()}
            className="shrink-0"
          >
            <Folder className="mr-2 h-4 w-4" aria-hidden />
            Browse
          </Button>
        </div>
        {message ? (
          <p
            className="mt-3 text-xs text-fg-3"
            data-testid="advanced-root-message"
          >
            {message}
          </p>
        ) : null}
      </div>
      {isDevelopment ? (
        <div className="py-6">
          <h2 className="text-sm font-semibold text-danger">
            Development data
          </h2>
          <p className="mt-1 text-sm leading-6 text-fg-3">
            Delete the database, settings, secrets, and all Harness-managed
            repositories and worktrees, then restart into onboarding.
          </p>
          <Button
            type="button"
            variant="danger"
            data-testid="advanced-reset-development-data"
            disabled={resetting}
            onClick={() => void resetDevelopmentData()}
            className="mt-4"
          >
            <Trash2 className="mr-2 h-4 w-4" aria-hidden />
            {resetting ? 'Resetting…' : 'Reset all development data'}
          </Button>
        </div>
      ) : null}
    </SettingsSection>
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
  mode,
  busy,
  error,
  pat,
  onPatChange,
  onModeChange,
  onRefresh,
  onConnectCli,
  onLogout,
  onConnectPat,
}: {
  accounts: GithubAccount[];
  cli: GithubCliAuthStatus | null;
  mode: 'cli' | 'pat';
  busy: boolean;
  error: string | null;
  pat: string;
  onPatChange: (value: string) => void;
  onModeChange: (mode: 'cli' | 'pat') => void;
  onRefresh: () => void;
  onConnectCli: () => void;
  onLogout: () => void;
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
        <div
          className={`rounded-3 border bg-surface-well p-4 ${
            mode === 'cli' ? 'border-accent' : 'border-border-1'
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 gap-3">
              <button
                type="button"
                className="flex shrink-0"
                aria-label="Use GitHub CLI authentication"
                aria-pressed={mode === 'cli'}
                onClick={() => onModeChange('cli')}
              >
                <RadioMark selected={mode === 'cli'} />
              </button>
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
                    : (cli?.message ??
                      'Install and authenticate gh to use this option.')}
                </p>
              </div>
            </div>
            {mode === 'cli' ? (
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onConnectCli}
                  disabled={busy}
                  data-testid="github-connect-gh"
                >
                  {cli?.authenticated
                    ? connected
                      ? 'Refresh access'
                      : 'Use gh auth'
                    : connected
                      ? 'Log in again'
                      : 'Sign in'}
                </Button>
                {connected || cli?.login ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onLogout}
                    disabled={busy}
                    data-testid="github-logout"
                  >
                    Log out
                  </Button>
                ) : null}
              </div>
            ) : null}
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

        <div
          className={`rounded-3 border bg-surface-well p-4 ${
            mode === 'pat' ? 'border-accent' : 'border-border-1'
          }`}
        >
          <div className="flex items-start gap-3">
            <button
              type="button"
              className="flex shrink-0"
              aria-label="Use personal access token authentication"
              aria-pressed={mode === 'pat'}
              onClick={() => onModeChange('pat')}
            >
              <RadioMark selected={mode === 'pat'} />
            </button>
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
              {mode === 'pat' ? (
                <>
                  <p className="mt-2 text-sm text-fg-2">
                    Paste a GitHub token with repository access. It is encrypted
                    at rest and never stored in settings.toml.
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
                </>
              ) : (
                <p className="mt-2 text-sm text-fg-2">
                  Select this option to connect with a fine-grained or classic
                  token instead of GitHub CLI.
                </p>
              )}
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
      {selected ? (
        <span className="h-2.5 w-2.5 rounded-full bg-accent" />
      ) : null}
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
          <h2 className="text-base font-semibold text-fg-1">SSH identities</h2>
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
  const copy = `${SECTION_LABELS[section]} settings are not available yet.`;
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
