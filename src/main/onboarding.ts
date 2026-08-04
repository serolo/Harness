// Onboarding readiness composer (Phase 6, Track H3 / spec §7).
//
// Answers one question for the renderer's onboarding wizard: "is this install ready to
// use, and if not, which setup step is missing?" It composes `OnboardingState` from three
// existing signals — no new persistence:
//
//   - harnessReady    — at least one registered harness CLI is installed AND authenticated
//                       (`harness:detect` via the supervisor's `listHarnesses`).
//   - githubConnected — a valid GitHub CLI session has been imported into the app.
//   - hasProjects     — at least one project has been added.
//
// `complete` is true once the ESSENTIAL steps are satisfied: a usable harness + a project.
// GitHub plus one model provider are required before onboarding can be acknowledged.
// State must DEGRADE GRACEFULLY when nothing is installed (empty detect → all false,
// `complete: false`) rather than throw and block the app.
//
// SECURITY NOTE (heightened scrutiny, spec §7): the wizard this feeds MUST surface the
// unsandboxed-execution disclosure (agent/run commands run with the user's privileges in
// the worktree; no sandbox in v1). That disclosure + acknowledgement live in the renderer
// (`OnboardingWizard`); this service only reports readiness.

import type { OnboardingLoginProvider, OnboardingState } from '@shared/ipc';
import type { HarnessInfo } from '@shared/ipc';
import { AppError } from '@shared/errors';

/**
 * Injected readiness probes (kept as plain async functions so the composer is unit-testable
 * without booting the DB / harness / integrations). `index.ts` wires these to the real
 * `AppContext` collaborators.
 */
export interface OnboardingServiceDeps {
  /** Registered harnesses with a live detect summary (`ctx.harness.listHarnesses`). */
  listHarnesses: () => Promise<HarnessInfo[]>;
  /** Count of connected GitHub integration rows (`ctx.integrations.list('github').length`). */
  countGithubAccounts: () => Promise<number>;
  /** Whether `gh auth status` reports a valid github.com session. */
  githubAuthenticated: () => Promise<boolean>;
  /** Count of registered projects (`ProjectsRepo.list().length`). */
  countProjects: () => Promise<number>;
  /** Whether the optional QMD knowledge search CLI is installed. */
  qmdInstalled: () => Promise<boolean>;
  isAcknowledged: () => Promise<boolean>;
  acknowledge: () => Promise<void>;
}

/**
 * Composes {@link OnboardingState} from the injected probes. Construct once at startup and
 * expose `getState()` over the `onboarding:state` IPC command.
 */
export class OnboardingService {
  constructor(private readonly deps: OnboardingServiceDeps) {}

  /**
   * Snapshot the onboarding readiness. Every probe is awaited independently; a harness that
   * is installed but not authenticated does NOT count as ready (it can't run a turn).
   */
  async getState(): Promise<OnboardingState> {
    const harnesses = await this.deps.listHarnesses();
    const claudeReady = isReady(
      harnesses.find((harness) => harness.id === 'claude_code'),
    );
    const codexReady = isReady(
      harnesses.find((harness) => harness.id === 'codex'),
    );
    const harnessReady = claudeReady || codexReady;

    const githubConnected =
      (await this.deps.countGithubAccounts()) > 0 &&
      (await this.deps.githubAuthenticated());
    const hasProjects = (await this.deps.countProjects()) > 0;
    const qmdInstalled = await this.deps.qmdInstalled();
    const acknowledged = await this.deps.isAcknowledged();

    const complete = githubConnected && harnessReady;

    return {
      harnessReady,
      githubConnected,
      hasProjects,
      qmdInstalled,
      acknowledged,
      complete,
      claudeReady,
      codexReady,
    };
  }

  async acknowledge(): Promise<void> {
    const state = await this.getState();
    if (!state.complete) {
      throw new AppError(
        'conflict',
        'Connect GitHub and sign in to Claude Code or Codex before finishing setup',
      );
    }
    await this.deps.acknowledge();
  }
}

export interface OnboardingLoginCommand {
  executable: 'gh' | 'claude' | 'codex';
  args: string[];
  display: string;
}

/** Fixed argv allowlist for onboarding login terminals; no renderer text is executed. */
export function onboardingLoginCommand(
  provider: OnboardingLoginProvider,
  method?: 'cli' | 'api_key',
): OnboardingLoginCommand {
  switch (provider) {
    case 'github':
      return {
        executable: 'gh',
        args: ['auth', 'login'],
        display: 'gh auth login',
      };
    case 'claude':
      return {
        executable: 'claude',
        args:
          method === 'api_key'
            ? ['auth', 'login', '--console']
            : ['auth', 'login'],
        display:
          method === 'api_key'
            ? 'claude auth login --console'
            : 'claude auth login',
      };
    case 'codex':
      return method === 'api_key'
        ? {
            executable: 'codex',
            args: ['login', '--with-api-key'],
            display: 'codex login --with-api-key',
          }
        : { executable: 'codex', args: ['login'], display: 'codex login' };
  }
}

function isReady(harness: HarnessInfo | undefined): boolean {
  return (
    harness !== undefined &&
    harness.detect.installed &&
    harness.detect.authenticated
  );
}
