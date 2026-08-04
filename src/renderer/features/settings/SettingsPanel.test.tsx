// SettingsPanel test (Phase 6, Track B/G). Runs under jsdom with a stubbed `window.api`
// (the only main-process access point), mirroring ChecksPanel.test.tsx so the real
// `@renderer/ipc` funnel + real components run.
//
// Covers: rows render effective values + provenance badges from getEffective/
// getProvenance; a select edit invokes `settings:set` on the user layer; a notification
// toggle (Track G) writes `[notifications]`; a text edit commits on blur; and the
// `settings:changed` subscription refetches then is torn down on unmount.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../onboarding/OnboardingLoginTerminal', () => ({
  OnboardingLoginTerminal: ({
    provider,
    method,
  }: {
    provider: string;
    method?: string;
  }) => (
    <div data-testid="settings-login-terminal">
      {provider}:{method ?? 'default'}
    </div>
  ),
}));

import { SettingsPanel } from './SettingsPanel';
import type { HarnessInfo } from '@shared/ipc';
import type {
  EffectiveSettings,
  SettingsIssue,
  SettingsProvenance,
} from '@shared/settings';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

const EFFECTIVE: EffectiveSettings = {
  scripts: { run: [], run_mode: 'single' },
  env: {},
  agent: {
    defaultHarness: 'claude_code',
    mode: 'default',
    permissionPolicy: {},
    prompts: {},
    reviewPrompt: 'review',
    prPrompt: 'pr',
    harnessImpl: 'auto',
  },
  git: {
    branchPrefix: 'agent',
    mergeStrategy: 'squash',
    deleteWorktreeOnArchive: true,
  },
  mcp: [],
  notifications: {
    enabled: true,
    onTurnComplete: true,
    onError: true,
    onNeedsAttention: true,
    completionSound: 'glass',
  },
  appearance: {
    theme: 'dark',
  },
  knowledge: {
    enabled: false,
    storage: 'local',
    proposal_mode: 'review_required',
    inject_context: true,
    extract_after_turn: true,
    show_notifications: true,
    search: {
      enabled: true,
      provider: 'basic',
      max_results: 12,
      max_context_tokens: 12_000,
      index_sources: false,
      rerank: true,
    },
  },
};

const PROVENANCE: SettingsProvenance = {
  'git.branchPrefix': 'user',
  'git.mergeStrategy': 'default',
  'agent.mode': 'project-local',
  'appearance.theme': 'user',
};

interface Installed {
  api: ApiStub;
  listeners: Record<string, ((payload: unknown) => void)[]>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function installApi(
  issues: SettingsIssue[] = [],
  projectEffective: EffectiveSettings = EFFECTIVE,
  github: {
    accounts?: Array<{ id: string; login: string; kind: 'github' }>;
    agents?: HarnessInfo[];
    cli?: {
      available: boolean;
      authenticated: boolean;
      login?: string;
      message?: string;
    };
  } = {},
): Installed {
  const listeners: Record<string, ((payload: unknown) => void)[]> = {};
  const unsubscribe = vi.fn();

  const invoke = vi.fn((channel: string) => {
    switch (channel) {
      case 'settings:getEffective':
        return Promise.resolve(EFFECTIVE);
      case 'settings:getProvenance':
        return Promise.resolve(PROVENANCE);
      case 'settings:getIssues':
        return Promise.resolve(issues);
      case 'project:list':
        return Promise.resolve([
          {
            id: 'project-1',
            name: 'Harness',
            originUrl: '',
            defaultBranch: 'main',
            repoPath: '/src/harness',
            createdAt: 1,
          },
        ]);
      case 'settings:getProject':
      case 'settings:setProject':
        return Promise.resolve({
          settings: projectEffective,
          provenance: PROVENANCE,
          issues: [],
        });
      case 'knowledge:importZip':
        return Promise.resolve({
          imported: true,
          fileCount: 3,
          createdCount: 2,
          updatedCount: 1,
          commit: 'abc',
        });
      case 'knowledge:updateCatalog':
        return Promise.resolve({
          updated: true,
          pageCount: 4,
          commit: 'def',
        });
      case 'knowledge:qmdStatus':
        return Promise.resolve({ installed: false });
      case 'git:sshKeys':
        return Promise.resolve([
          {
            path: '/Users/test/.ssh/id_ed25519',
            publicKeyPath: '/Users/test/.ssh/id_ed25519.pub',
            type: 'ssh-ed25519',
            fingerprint: 'SHA256:test',
            source: 'ssh-dir',
          },
        ]);
      case 'github:accounts':
        return Promise.resolve(github.accounts ?? []);
      case 'github:cliStatus':
        return Promise.resolve(
          github.cli ?? {
            available: true,
            authenticated: true,
            login: 'octo',
          },
        );
      case 'github:connectGhCli':
        return Promise.resolve({ id: 'gh-1', login: 'octo', kind: 'github' });
      case 'github:logoutGhCli':
        return Promise.resolve(undefined);
      case 'agent:revealClaudeApiKey':
        return Promise.resolve({ apiKey: 'sk-ant-revealed-secret-LI0A' });
      case 'agent:setClaudeApiKey':
        return Promise.resolve({ configured: true, hint: 'NEW1' });
      case 'agent:deleteClaudeApiKey':
        return Promise.resolve(undefined);
      case 'agent:revealCodexApiKey':
        return Promise.resolve({ apiKey: 'sk-openai-revealed-C0DX' });
      case 'agent:setCodexApiKey':
        return Promise.resolve({ configured: true, hint: 'NEW2' });
      case 'agent:deleteCodexApiKey':
        return Promise.resolve(undefined);
      case 'harness:list':
        return Promise.resolve(
          github.agents ?? [
            {
              id: 'claude_code',
              capabilities: {
                supportsResume: true,
                supportsMcp: true,
                supportsPlanMode: true,
                rawTerminalFallback: true,
              },
              detect: {
                installed: true,
                authenticated: true,
                version: '2.1.201',
                authMethod: 'cli',
                providerLabel: 'anthropic',
                planLabel: 'Max',
                authLabel: 'Claude login',
                accountLabel: 'person@example.com',
              },
            },
            {
              id: 'codex',
              capabilities: {
                supportsResume: true,
                supportsMcp: true,
                supportsPlanMode: true,
                rawTerminalFallback: true,
              },
              detect: {
                installed: true,
                authenticated: true,
                version: '0.145.0',
                authMethod: 'api_key',
              },
            },
            {
              id: 'cursor',
              capabilities: {
                supportsResume: false,
                supportsMcp: false,
                supportsPlanMode: false,
                rawTerminalFallback: true,
              },
              detect: {
                installed: true,
                authenticated: true,
                version: '1.0.0',
                authMethod: 'cli',
              },
            },
          ],
        );
      case 'settings:set':
        return Promise.resolve(EFFECTIVE);
      case 'app:getRootDirectory':
        return Promise.resolve({
          path: '/Users/test/harness',
          defaultPath: '/Users/test/harness',
        });
      case 'app:isDevelopment':
        return Promise.resolve(true);
      case 'app:resetDevelopmentData':
        return Promise.resolve(undefined);
      case 'app:pickRootDirectory':
        return Promise.resolve('/Volumes/Work/harness');
      case 'app:setRootDirectory':
        return Promise.resolve({ path: '/Volumes/Work/harness' });
      case 'notifications:previewSound':
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });

  const api: ApiStub = {
    invoke,
    on: vi.fn((event: string, cb: (payload: unknown) => void) => {
      (listeners[event] ??= []).push(cb);
      return unsubscribe;
    }),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return { api, listeners, unsubscribe };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete (window as unknown as { api?: unknown }).api;
});

describe('SettingsPanel rendering', () => {
  it('keeps scrolling inside the navigation and content panes', async () => {
    installApi();
    render(<SettingsPanel />);

    expect(await screen.findByTestId('settings-panel')).toHaveClass(
      'overflow-hidden',
    );
    expect(screen.getByTestId('settings-native-titlebar-space')).toHaveClass(
      'h-titlebar',
    );
    expect(screen.getByTestId('settings-nav-scroll')).toHaveClass(
      'overflow-y-auto',
    );
    expect(screen.getByTestId('settings-content-scroll')).toHaveClass(
      'overflow-y-auto',
    );
  });

  it('shows and changes the Harness root directory', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-advanced'));
    expect(await screen.findByTestId('advanced-root-directory')).toHaveValue(
      '/Users/test/harness',
    );

    fireEvent.click(screen.getByTestId('advanced-root-browse'));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('app:setRootDirectory', {
        path: '/Volumes/Work/harness',
      }),
    );
    expect(screen.getByTestId('advanced-root-directory')).toHaveValue(
      '/Volumes/Work/harness',
    );
  });

  it('confirms and requests a development data reset', async () => {
    const { api } = installApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-advanced'));
    fireEvent.click(
      await screen.findByTestId('advanced-reset-development-data'),
    );

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'app:resetDevelopmentData',
        undefined,
      ),
    );
  });

  it('renders values + provenance badges from getEffective/getProvenance', async () => {
    installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-git'));

    // A text row shows the effective value.
    const branch = screen.getByTestId('setting-input-git.branchPrefix');
    expect(branch).toHaveValue('agent');

    // Provenance badge reflects the supplying layer.
    const row = screen.getByTestId('setting-row-git.branchPrefix');
    expect(
      row.querySelector('[data-testid="provenance-badge"]'),
    ).toHaveAttribute('data-layer', 'user');
    // A leaf with no provenance entry falls back to `default`.
    const mergeRow = screen.getByTestId('setting-row-git.mergeStrategy');
    expect(
      mergeRow.querySelector('[data-testid="provenance-badge"]'),
    ).toHaveAttribute('data-layer', 'default');
  });

  it('offers login again and logout for an expired GitHub CLI session', async () => {
    const { api } = installApi([], EFFECTIVE, {
      accounts: [{ id: 'gh-1', login: 'octo', kind: 'github' }],
      cli: {
        available: true,
        authenticated: false,
        login: 'octo',
        message: 'The token is invalid.',
      },
    });
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-git'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Log in again' }),
    );
    expect(
      await screen.findByTestId('settings-login-terminal'),
    ).toHaveTextContent('github');

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('github:logoutGhCli', undefined),
    );
  });

  it('shows the token form only when personal access token auth is selected', async () => {
    installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-git'));
    expect(screen.queryByTestId('github-settings-token-input')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Use personal access token authentication',
      }),
    );
    expect(screen.getByTestId('github-settings-token-input')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Use GitHub CLI authentication' }),
    );
    expect(screen.queryByTestId('github-settings-token-input')).toBeNull();
  });

  it('renders model defaults, review defaults, and chat mode toggles', async () => {
    installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-models'));

    expect(screen.getByTestId('models-default-model')).toHaveValue(
      'claude-opus-5',
    );
    expect(screen.getByTestId('models-default-model')).toHaveTextContent(
      'GPT-5.6 Sol',
    );
    expect(screen.getByTestId('models-review-effort')).toHaveValue('high');
    fireEvent.change(screen.getByTestId('models-default-model'), {
      target: { value: 'codex-gpt-5-6-sol' },
    });
    expect(window.localStorage.getItem('harness:model-preferences')).toContain(
      'codex-gpt-5-6-sol',
    );
    expect(screen.getByTestId('models-plan-mode')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    fireEvent.click(screen.getByTestId('models-plan-mode'));
    expect(screen.getByTestId('models-plan-mode')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('labels harness settings as Agents and shows detected agent status', async () => {
    installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-agents'));

    expect(
      await screen.findByTestId('settings-section-agents'),
    ).toHaveTextContent('Agents');
    expect(screen.getByTestId('agent-tab-claude_code')).toHaveTextContent(
      'Claude Code',
    );
    expect(screen.getByTestId('agent-connection-status')).toHaveTextContent(
      'Connected',
    );
    expect(screen.getByTestId('agent-auth-cli')).toHaveTextContent('CLI');
    expect(screen.getByTestId('agent-auth-api_key')).toHaveTextContent(
      'API Key',
    );
    expect(screen.getByTestId('agent-auth-cli')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(screen.getByTestId('agent-auth-api_key')).toHaveAttribute(
      'data-selected',
      'false',
    );
    expect(screen.queryByTestId('agent-tab-opencode')).toBeNull();
    expect(screen.queryByText('Harnesses')).toBeNull();
    const cliDetails = screen.getByTestId('agent-cli-details');
    expect(cliDetails).toHaveTextContent('anthropic');
    expect(cliDetails).toHaveTextContent('Max');
    expect(cliDetails).toHaveTextContent('Claude login');
    expect(cliDetails).toHaveTextContent('person@example.com');
    fireEvent.click(screen.getByTestId('agent-cli-relogin'));
    expect(screen.getByTestId('settings-login-terminal')).toHaveTextContent(
      'claude:cli',
    );
  });

  it('shows connected Codex CLI account details and can run login again', async () => {
    installApi([], EFFECTIVE, {
      agents: [
        {
          id: 'codex',
          capabilities: {
            supportsResume: true,
            supportsMcp: true,
            supportsPlanMode: true,
            rawTerminalFallback: true,
          },
          detect: {
            installed: true,
            authenticated: true,
            version: '0.145.0',
            authMethod: 'cli',
            providerLabel: 'openai',
            planLabel: 'Plus',
            authLabel: 'ChatGPT login',
            accountLabel: 'person@example.com',
          },
        },
      ],
    });
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-agents'));
    fireEvent.click(screen.getByTestId('agent-tab-codex'));

    expect(screen.getByTestId('agent-connection-status')).toHaveTextContent(
      'Connected',
    );
    const details = screen.getByTestId('agent-cli-details');
    expect(details).toHaveTextContent('openai');
    expect(details).toHaveTextContent('Plus');
    expect(details).toHaveTextContent('ChatGPT login');
    expect(details).toHaveTextContent('person@example.com');
    expect(screen.getByTestId('agent-cli-relogin')).toHaveTextContent(
      'Run codex login',
    );
  });

  it('shows the active Codex method and can switch to CLI auth', async () => {
    installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-agents'));
    fireEvent.click(screen.getByTestId('agent-tab-codex'));

    expect(screen.getByTestId('agent-connection-status')).toHaveTextContent(
      'Connected',
    );
    expect(screen.getByTestId('agent-auth-api_key')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(screen.getByTestId('agent-auth-cli')).toHaveAttribute(
      'data-selected',
      'false',
    );
    expect(screen.getByTestId('agent-api-key-details')).toHaveTextContent(
      'OpenAI API',
    );
    fireEvent.click(screen.getByRole('button', { name: 'View API key' }));
    expect(await screen.findByText('sk-openai-revealed-C0DX')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide API key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit API key' }));
    expect(screen.getByLabelText('OpenAI API key')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete API key' }));
    await waitFor(() =>
      expect(window.api.invoke).toHaveBeenCalledWith(
        'agent:deleteCodexApiKey',
        undefined,
      ),
    );

    fireEvent.click(screen.getByTestId('agent-auth-cli'));
    expect(screen.queryByTestId('settings-login-terminal')).toBeNull();
    expect(screen.getByTestId('agent-connection-status')).toHaveTextContent(
      'CLI not authenticated',
    );
    fireEvent.click(screen.getByTestId('agent-auth-login'));
    const terminal = screen.getByTestId('settings-login-terminal');
    expect(terminal).toHaveTextContent('codex:cli');
    expect(
      screen
        .getByTestId('agent-auth-api_key')
        .compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByTestId('agent-auth-login').compareDocumentPosition(terminal) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows connected Claude API-key details without exposing the key', async () => {
    installApi([], EFFECTIVE, {
      agents: [
        {
          id: 'claude_code',
          capabilities: {
            supportsResume: true,
            supportsMcp: true,
            supportsPlanMode: true,
            rawTerminalFallback: true,
          },
          detect: {
            installed: true,
            authenticated: true,
            version: '2.1.220',
            authMethod: 'api_key',
            credentialHint: 'LI0A',
          },
        },
      ],
    });
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-agents'));

    expect(screen.getByTestId('agent-connection-status')).toHaveTextContent(
      'Connected',
    );
    const details = screen.getByTestId('agent-api-key-details');
    expect(details).toHaveTextContent('2.1.220');
    expect(details).toHaveTextContent('Anthropic API');
    expect(details).toHaveTextContent('API key');
    expect(details).toHaveTextContent('••••••••LI0A');
    expect(details).not.toHaveTextContent('sk-ant-');

    fireEvent.click(screen.getByRole('button', { name: 'View API key' }));
    expect(await screen.findByText('sk-ant-revealed-secret-LI0A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide API key' }));
    expect(screen.getByTestId('agent-api-key-value')).toHaveTextContent(
      '••••••••LI0A',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit API key' }));
    const input = screen.getByLabelText('Anthropic API key');
    fireEvent.change(input, {
      target: { value: 'sk-ant-replacement-key-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(window.api.invoke).toHaveBeenCalledWith('agent:setClaudeApiKey', {
        apiKey: 'sk-ant-replacement-key-value',
      }),
    );

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete API key' }));
    await waitFor(() =>
      expect(window.api.invoke).toHaveBeenCalledWith(
        'agent:deleteClaudeApiKey',
        undefined,
      ),
    );
  });

  it('shows Cursor as CLI-only', async () => {
    installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-agents'));
    fireEvent.click(screen.getByTestId('agent-tab-cursor'));

    expect(screen.getByTestId('agent-auth-cli')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(screen.getByTestId('agent-auth-api_key')).toBeDisabled();
    expect(screen.getByTestId('agent-auth-api_key')).toHaveTextContent(
      'Not supported by the Cursor CLI',
    );
  });
});

describe('SettingsPanel writes', () => {
  it('separates repository scripts from project knowledge with top tabs', async () => {
    installApi();
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));

    const scriptsTab = await screen.findByTestId('repo-settings-tab-scripts');
    const knowledgeTab = screen.getByTestId('repo-settings-tab-knowledge');
    expect(scriptsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('repo-setup-script')).toBeTruthy();
    expect(
      screen.queryByRole('switch', { name: 'Enable project knowledge wiki' }),
    ).toBeNull();

    fireEvent.click(knowledgeTab);

    expect(knowledgeTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('repo-setup-script')).toBeNull();
    expect(
      screen.getByRole('switch', { name: 'Enable project knowledge wiki' }),
    ).toBeTruthy();
  });

  it('imports an existing knowledge ZIP from the project knowledge tab', async () => {
    const projectEffective = structuredClone(EFFECTIVE);
    projectEffective.knowledge.enabled = true;
    const { api } = installApi([], projectEffective);
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    fireEvent.click(await screen.findByTestId('repo-settings-tab-knowledge'));
    fireEvent.click(await screen.findByTestId('knowledge-import-zip'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('knowledge:importZip', {
        projectId: 'project-1',
      }),
    );
    expect(
      await screen.findByTestId('knowledge-import-message'),
    ).toHaveTextContent('Imported 3 files: 2 new, 1 updated.');
  });

  it('updates the knowledge catalog from project settings', async () => {
    const projectEffective = structuredClone(EFFECTIVE);
    projectEffective.knowledge.enabled = true;
    const { api } = installApi([], projectEffective);
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    fireEvent.click(await screen.findByTestId('repo-settings-tab-knowledge'));
    fireEvent.click(await screen.findByTestId('knowledge-update-catalog'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('knowledge:updateCatalog', {
        projectId: 'project-1',
      }),
    );
    expect(
      await screen.findByTestId('knowledge-catalog-message'),
    ).toHaveTextContent('Catalog updated with 4 pages.');
  });

  it('disables QMD selection when its CLI is not installed', async () => {
    const projectEffective = structuredClone(EFFECTIVE);
    projectEffective.knowledge.enabled = true;
    installApi([], projectEffective);
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    fireEvent.click(await screen.findByTestId('repo-settings-tab-knowledge'));

    const qmdOption = screen.getByRole('option', {
      name: 'QMD (not installed)',
    }) as HTMLOptionElement;
    expect(qmdOption.disabled).toBe(true);
  });

  it('lists projects and persists all repository script controls', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(await screen.findByText('/src/harness')).toBeTruthy();

    const setup = await screen.findByTestId('repo-setup-script');
    fireEvent.change(setup, { target: { value: 'npm install' } });
    fireEvent.blur(setup);

    fireEvent.change(screen.getByTestId('repo-run-mode'), {
      target: { value: 'concurrent' },
    });
    fireEvent.click(screen.getByTestId('repo-run-add'));

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('settings:setProject', {
        projectId: 'project-1',
        keyPath: 'scripts.setup',
        value: 'npm install',
      });
      expect(api.invoke).toHaveBeenCalledWith('settings:setProject', {
        projectId: 'project-1',
        keyPath: 'scripts.run_mode',
        value: 'concurrent',
      });
      expect(api.invoke).toHaveBeenCalledWith('settings:setProject', {
        projectId: 'project-1',
        keyPath: 'scripts.run',
        value: [{ name: 'script-1', command: '' }],
      });
    });
  });

  it('writes the delete-worktree-on-archive toggle', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-git'));
    fireEvent.click(
      screen.getByTestId('setting-input-git.deleteWorktreeOnArchive'),
    );

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'git.deleteWorktreeOnArchive',
        value: false,
      }),
    );
  });

  it('invokes settings:set on the user layer when a select changes', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-git'));
    const select = screen.getByTestId('setting-input-git.mergeStrategy');
    fireEvent.change(select, { target: { value: 'rebase' } });

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'git.mergeStrategy',
        value: 'rebase',
      }),
    );
  });

  it('writes a notification toggle (Track G) via settings:set', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    const toggle = await screen.findByTestId(
      'setting-input-notifications.onError',
    );
    fireEvent.click(toggle); // true → false

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'notifications.onError',
        value: false,
      }),
    );
  });

  it('persists and previews a selected completion sound', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    const sound = await screen.findByTestId(
      'setting-input-notifications.completionSound',
    );
    fireEvent.change(sound, { target: { value: 'ping' } });

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'notifications.completionSound',
        value: 'ping',
      });
      expect(api.invoke).toHaveBeenCalledWith('notifications:previewSound', {
        sound: 'ping',
      });
    });
  });

  it('writes the selected appearance theme', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-appearance'));
    const theme = await screen.findByTestId('setting-input-appearance.theme');
    fireEvent.change(theme, { target: { value: 'light' } });

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'appearance.theme',
        value: 'light',
      }),
    );
  });

  it('commits a text edit on blur (not per keystroke)', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-git'));
    const input = screen.getByTestId('setting-input-git.branchPrefix');
    fireEvent.change(input, { target: { value: 'feature' } });
    // No write yet — only on blur.
    expect(
      api.invoke.mock.calls.filter((c) => c[0] === 'settings:set'),
    ).toHaveLength(0);

    fireEvent.blur(input);
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'git.branchPrefix',
        value: 'feature',
      }),
    );
  });
});

describe('RunScriptEditor (Track B2)', () => {
  it('adds, edits, and removes a run script via settings:set (whole-array writes)', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-environment'));

    // Add an (empty) run script — a whole-array write appending one entry.
    const add = await screen.findByTestId('scripts-run-add');
    fireEvent.click(add);
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'scripts.run',
        value: [{ name: '', command: '' }],
      }),
    );

    // Fill in name + command, commit on blur — the ENTIRE array is rewritten.
    fireEvent.change(screen.getByTestId('scripts-run-name-0'), {
      target: { value: 'dev' },
    });
    fireEvent.change(screen.getByTestId('scripts-run-command-0'), {
      target: { value: 'npm run dev' },
    });
    fireEvent.blur(screen.getByTestId('scripts-run-command-0'));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'scripts.run',
        value: [{ name: 'dev', command: 'npm run dev' }],
      }),
    );

    // Remove it — the array is written back empty.
    fireEvent.click(screen.getByTestId('scripts-run-remove-0'));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'scripts.run',
        value: [],
      }),
    );
  });

  it('writes run_mode and an env variable as whole-value writes', async () => {
    const { api } = installApi();
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-environment'));

    const mode = await screen.findByTestId('scripts-run-mode');
    fireEvent.change(mode, { target: { value: 'concurrent' } });
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'scripts.run_mode',
        value: 'concurrent',
      }),
    );

    fireEvent.click(screen.getByTestId('env-add'));
    fireEvent.change(screen.getByTestId('env-key-0'), {
      target: { value: 'API_URL' },
    });
    fireEvent.change(screen.getByTestId('env-value-0'), {
      target: { value: 'https://x' },
    });
    fireEvent.blur(screen.getByTestId('env-value-0'));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'env',
        value: { API_URL: 'https://x' },
      }),
    );
  });
});

describe('SettingsPanel validation issues banner', () => {
  it('surfaces settings:getIssues rows and hides them on dismiss', async () => {
    const issues: SettingsIssue[] = [
      {
        file: '/home/u/.config/harness/settings.toml',
        keyPath: 'git.mergeStrategy',
        message: 'Invalid enum value',
      },
    ];
    installApi(issues);
    render(<SettingsPanel />);

    // The banner lists the offending file + key + message.
    const banner = await screen.findByTestId('settings-issues');
    expect(banner).toHaveTextContent('git.mergeStrategy');
    expect(banner).toHaveTextContent('Invalid enum value');

    // Dismiss removes the banner.
    fireEvent.click(screen.getByTestId('settings-issues-dismiss'));
    await waitFor(() =>
      expect(screen.queryByTestId('settings-issues')).toBeNull(),
    );
  });

  it('renders no banner when every layer parsed cleanly', async () => {
    installApi([]);
    render(<SettingsPanel />);
    await screen.findByTestId('setting-input-notifications.onError');
    expect(screen.queryByTestId('settings-issues')).toBeNull();
  });
});

describe('SettingsPanel settings:changed subscription', () => {
  it('refetches on settings:changed and unsubscribes on unmount', async () => {
    const { api, listeners, unsubscribe } = installApi();
    const { unmount } = render(<SettingsPanel />);

    await screen.findByTestId('setting-input-notifications.onError');
    const before = api.invoke.mock.calls.filter(
      (c) => c[0] === 'settings:getEffective',
    ).length;

    listeners['settings:changed']?.forEach((cb) => cb({}));
    await waitFor(() => {
      const after = api.invoke.mock.calls.filter(
        (c) => c[0] === 'settings:getEffective',
      ).length;
      expect(after).toBeGreaterThan(before);
    });

    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
