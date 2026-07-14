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

import { SettingsPanel } from './SettingsPanel';
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
};

const PROVENANCE: SettingsProvenance = {
  'git.branchPrefix': 'user',
  'git.mergeStrategy': 'default',
  'agent.mode': 'project-local',
};

interface Installed {
  api: ApiStub;
  listeners: Record<string, ((payload: unknown) => void)[]>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function installApi(issues: SettingsIssue[] = []): Installed {
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
        return Promise.resolve([]);
      case 'github:cliStatus':
        return Promise.resolve({
          available: true,
          authenticated: true,
          login: 'octo',
        });
      case 'github:connectGhCli':
        return Promise.resolve({ id: 'gh-1', login: 'octo', kind: 'github' });
      case 'settings:set':
        return Promise.resolve(EFFECTIVE);
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
  delete (window as unknown as { api?: unknown }).api;
});

describe('SettingsPanel rendering', () => {
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
});

describe('SettingsPanel writes', () => {
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
