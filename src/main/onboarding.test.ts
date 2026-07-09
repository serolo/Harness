// OnboardingService tests (Phase 6, Track H3). Pure composition over injected probes —
// no DB / harness / integrations booted.

import { describe, it, expect } from 'vitest';

import { OnboardingService } from './onboarding';
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
  projects?: number;
}): OnboardingService {
  return new OnboardingService({
    listHarnesses: () => Promise.resolve(opts.harnesses ?? []),
    countGithubAccounts: () => Promise.resolve(opts.github ?? 0),
    countProjects: () => Promise.resolve(opts.projects ?? 0),
  });
}

describe('OnboardingService.getState', () => {
  it('is complete with a ready harness + a project (GitHub optional)', async () => {
    const state = await make({
      harnesses: [harness(true, true)],
      github: 0,
      projects: 1,
    }).getState();
    expect(state).toEqual({
      harnessReady: true,
      githubConnected: false,
      hasProjects: true,
      complete: true,
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

  it('is incomplete without a project even when the harness is ready', async () => {
    const state = await make({
      harnesses: [harness(true, true)],
      projects: 0,
    }).getState();
    expect(state.hasProjects).toBe(false);
    expect(state.complete).toBe(false);
  });

  it('degrades gracefully with no harness installed (empty detect)', async () => {
    const state = await make({ harnesses: [], projects: 0 }).getState();
    expect(state).toEqual({
      harnessReady: false,
      githubConnected: false,
      hasProjects: false,
      complete: false,
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
});
