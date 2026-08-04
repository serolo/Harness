// OnboardingService tests (Phase 6, Track H3). Pure composition over injected probes —
// no DB / harness / integrations booted.

import { describe, it, expect } from 'vitest';

import { OnboardingService, onboardingLoginCommand } from './onboarding';
import type { HarnessInfo } from '@shared/ipc';

function harness(installed: boolean, authenticated: boolean): HarnessInfo {
  return {
    id: 'claude_code',
    capabilities: {} as HarnessInfo['capabilities'],
    detect: { installed, authenticated },
  };
}

function make(opts: {
  harnesses?: HarnessInfo[];
  github?: number;
  githubAuthenticated?: boolean;
  projects?: number;
  qmd?: boolean;
}): OnboardingService {
  return new OnboardingService({
    listHarnesses: () => Promise.resolve(opts.harnesses ?? []),
    countGithubAccounts: () => Promise.resolve(opts.github ?? 0),
    githubAuthenticated: () =>
      Promise.resolve(opts.githubAuthenticated ?? (opts.github ?? 0) > 0),
    countProjects: () => Promise.resolve(opts.projects ?? 0),
    qmdInstalled: () => Promise.resolve(opts.qmd ?? false),
    isAcknowledged: () => Promise.resolve(false),
    acknowledge: () => Promise.resolve(),
  });
}

describe('OnboardingService.getState', () => {
  it('is complete with GitHub and one authenticated model provider', async () => {
    const state = await make({
      harnesses: [harness(true, true)],
      github: 1,
    }).getState();
    expect(state).toEqual({
      harnessReady: true,
      githubConnected: true,
      hasProjects: false,
      qmdInstalled: false,
      acknowledged: false,
      complete: true,
      claudeReady: true,
      codexReady: false,
    });
  });

  it('a harness installed but NOT authenticated is not ready', async () => {
    const state = await make({
      harnesses: [harness(true, false)],
      projects: 1,
    }).getState();
    expect(state.harnessReady).toBe(false);
    expect(state.complete).toBe(false);
  });

  it('is incomplete without GitHub even when a model provider is ready', async () => {
    const state = await make({
      harnesses: [harness(true, true)],
      projects: 0,
    }).getState();
    expect(state.hasProjects).toBe(false);
    expect(state.complete).toBe(false);
  });

  it('does not accept a saved GitHub row when gh auth is invalid', async () => {
    const state = await make({
      harnesses: [harness(true, true)],
      github: 1,
      githubAuthenticated: false,
    }).getState();
    expect(state.githubConnected).toBe(false);
    expect(state.complete).toBe(false);
  });

  it('degrades gracefully with no harness installed (empty detect)', async () => {
    const state = await make({ harnesses: [], projects: 0 }).getState();
    expect(state).toEqual({
      harnessReady: false,
      githubConnected: false,
      hasProjects: false,
      qmdInstalled: false,
      acknowledged: false,
      complete: false,
      claudeReady: false,
      codexReady: false,
    });
  });

  it('reports githubConnected when an account exists', async () => {
    const state = await make({
      harnesses: [harness(true, true)],
      github: 2,
      projects: 1,
    }).getState();
    expect(state.githubConnected).toBe(true);
  });

  it('refuses acknowledgement until GitHub and a provider are ready', async () => {
    await expect(make({ github: 1 }).acknowledge()).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('onboardingLoginCommand', () => {
  it('uses fixed argument arrays for every provider', () => {
    expect(onboardingLoginCommand('github')).toEqual({
      executable: 'gh',
      args: ['auth', 'login'],
      display: 'gh auth login',
    });
    expect(onboardingLoginCommand('claude')).toEqual({
      executable: 'claude',
      args: ['auth', 'login'],
      display: 'claude auth login',
    });
    expect(onboardingLoginCommand('codex')).toEqual({
      executable: 'codex',
      args: ['login'],
      display: 'codex login',
    });
  });

  it('uses fixed provider-specific auth method switches', () => {
    expect(onboardingLoginCommand('claude', 'cli')).toEqual({
      executable: 'claude',
      args: ['auth', 'login'],
      display: 'claude auth login',
    });
    expect(onboardingLoginCommand('claude', 'api_key').args).toEqual([
      'auth',
      'login',
      '--console',
    ]);
    expect(onboardingLoginCommand('codex', 'api_key').args).toEqual([
      'login',
      '--with-api-key',
    ]);
  });
});
