// Onboarding readiness composer (Phase 6, Track H3 / spec §7).
//
// Answers one question for the renderer's onboarding wizard: "is this install ready to
// use, and if not, which setup step is missing?" It composes `OnboardingState` from three
// existing signals — no new persistence:
//
//   - harnessReady    — at least one registered harness CLI is installed AND authenticated
//                       (`harness:detect` via the supervisor's `listHarnesses`).
//   - githubConnected — at least one GitHub integration row exists (optional for local use).
//   - hasProjects     — at least one project has been added.
//
// `complete` is true once the ESSENTIAL steps are satisfied: a usable harness + a project.
// GitHub is deliberately NOT part of `complete` — the app is usable on local repos without
// it. State must DEGRADE GRACEFULLY when nothing is installed (empty detect → all false,
// `complete: false`) rather than throw and block the app.
//
// SECURITY NOTE (heightened scrutiny, spec §7): the wizard this feeds MUST surface the
// unsandboxed-execution disclosure (agent/run commands run with the user's privileges in
// the worktree; no sandbox in v1). That disclosure + acknowledgement live in the renderer
// (`OnboardingWizard`); this service only reports readiness.

import type { OnboardingState } from '@shared/ipc';
import type { HarnessInfo } from '@shared/ipc';

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
  /** Count of registered projects (`ProjectsRepo.list().length`). */
  countProjects: () => Promise<number>;
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
    const harnessReady = harnesses.some(
      (h) => h.detect.installed && h.detect.authenticated,
    );

    const githubConnected = (await this.deps.countGithubAccounts()) > 0;
    const hasProjects = (await this.deps.countProjects()) > 0;

    // Essential steps: a usable harness + at least one project. GitHub is optional.
    const complete = harnessReady && hasProjects;

    return { harnessReady, githubConnected, hasProjects, complete };
  }
}
