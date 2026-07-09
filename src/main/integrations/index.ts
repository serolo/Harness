// IntegrationService — GitHub (Phase 5) + Linear (Phase 7) connectors (spec §6).
// OAuth device flow / PAT for auth; tokens encrypted at rest via safeStorage
// (ciphertext under `userData/secrets/`, DB holds only a `token_ref` — spec §7).
// Octokit REST for PRs/check-runs/statuses/deployments, GraphQL for review
// threads.
//
// Phase 5 (this task): the GitHub connect/list/disconnect + Octokit-resolution paths are
// implemented. The PR/checks methods (`openPr`/`getPr`/`listChecks`/`mergePr`) remain
// Phase-0 stubs that throw — their real bodies land in later tasks.
//
// SECURITY (heightened-scrutiny path — secrets/tokens): the plaintext token is confined
// to this service + `SecretStore`; it is NEVER persisted to the DB (only a `tokenRef`),
// never logged, and never placed into a thrown message. `connectGithub` owns emitting the
// single terminal `ConnectStatus` frame (`connected` with the persisted row id, or
// `error`) so the device-flow stream (spec §5.6) ends exactly once.
//
// The DTO shapes below are declared inline; they inform the `integrations` table (spec §3)
// and the Checks panel (spec §5.5).

import { Octokit } from '@octokit/rest';

import { AppError } from '@shared/errors';
import type { ConnectStatus, GithubAccount } from '@shared/github';

import type { IntegrationsRepo } from '../db/repos/integrations';
import { deviceFlowLogin, validatePat, type FetchLike } from './github/auth';
import type { SecretStore } from './secrets';

/** A connected integration account (spec §3 `integrations` table DTO). */
export interface Integration {
  id: string;
  kind: 'github' | 'linear';
  /** Human label for multi-account UIs (e.g. the GitHub login). */
  accountLabel: string | null;
  /** safeStorage ciphertext reference — NEVER the raw token (spec §7). */
  tokenRef: string;
}

/** A pull request as surfaced to the Checks/PR panels (spec §5.5–5.6). */
export interface PullRequest {
  number: number;
  url: string;
  title: string;
  draft: boolean;
  /** GitHub mergeable state (clean/dirty/blocked/unknown/…). */
  mergeableState: string;
}

/** A CI check run / commit status for a ref (spec §5.5 "CI" row). */
export interface CheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | null;
  detailsUrl: string | null;
}

/** Input for opening a PR (spec §5.6, ⌘⇧P). */
export interface OpenPrOptions {
  workspaceId: string;
  title: string;
  body: string;
  /** Base branch to target (defaults to the project default branch). */
  base?: string;
  /** Open as a draft PR. */
  draft?: boolean;
}

/** How a caller asks to connect GitHub: interactive device flow, or a pasted PAT. */
export type GithubConnectMode = 'device' | 'pat';

/**
 * Dependencies injected into {@link IntegrationService}. Everything side-effecting or
 * environment-specific is passed in so the service is unit-testable without a live
 * network, a real GitHub app, or a booted Electron keychain:
 *   - `repo`   — the `integrations` table CRUD layer (owns the row + `tokenRef`).
 *   - `secrets`— encrypts/decrypts the token at rest (`SecretStore`).
 *   - `clientId` — GitHub OAuth app client id for the device flow; falls back to
 *     `AGENTAPP_GITHUB_CLIENT_ID`. Device flow is only offered when one is present; PAT
 *     connect is always available.
 *   - `fetch`  — injected `fetch` for the auth HTTP calls (default = runtime global).
 *   - `octokitFactory` — builds an Octokit from a token (default = `new Octokit`), so
 *     tests can substitute a fake client.
 */
export interface IntegrationServiceDeps {
  repo: IntegrationsRepo;
  secrets: SecretStore;
  clientId?: string;
  fetch?: FetchLike;
  octokitFactory?: (token: string) => Octokit;
}

/**
 * Owns external integrations + their encrypted tokens. Constructed in
 * `src/main/index.ts` (Task 9) with the db repo + secret store injected.
 */
export class IntegrationService {
  private readonly repo: IntegrationsRepo;
  private readonly secrets: SecretStore;
  /** GitHub OAuth app client id, or `undefined` when device flow is unconfigured. */
  private readonly clientId: string | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly octokitFactory: (token: string) => Octokit;

  constructor(deps: IntegrationServiceDeps) {
    this.repo = deps.repo;
    this.secrets = deps.secrets;
    // Explicit injection wins; otherwise read the ambient env (empty string → unset).
    this.clientId =
      deps.clientId ?? process.env.AGENTAPP_GITHUB_CLIENT_ID ?? undefined;
    this.fetchImpl = deps.fetch;
    this.octokitFactory =
      deps.octokitFactory ?? ((token) => new Octokit({ auth: token }));
  }

  /**
   * Connect a GitHub account via `mode`:
   *   - `'pat'`   — validate the supplied `input.token`, then store it.
   *   - `'device'`— run the OAuth device flow (forwarding progress frames to `onFrame`),
   *     then store the resulting token.
   *
   * On success the token is encrypted via {@link SecretStore} and an `integrations` row
   * is persisted holding only the `tokenRef` (never the token). Emits the single terminal
   * `ConnectStatus` frame — `connected` (carrying the persisted account) on success, or
   * `error` on failure — then returns the created {@link Integration} (`tokenRef`, never
   * the token). Never logs or throws the token.
   */
  async connectGithub(
    mode: GithubConnectMode,
    input: { token?: string },
    onFrame?: (frame: ConnectStatus) => void,
  ): Promise<Integration> {
    const emit = onFrame ?? ((): void => undefined);
    try {
      const { token, login } =
        mode === 'pat'
          ? await this.resolvePat(input.token)
          : await this.resolveDeviceFlow(emit);

      // Encrypt-at-rest FIRST, then persist only the opaque ref.
      const tokenRef = await this.secrets.put(token);
      const integration = await this.repo.create({
        kind: 'github',
        accountLabel: login,
        tokenRef,
      });

      emit({ kind: 'connected', account: toGithubAccount(integration, login) });
      return integration;
    } catch (err) {
      // Surface a domain error frame (message is token-free by construction) so the
      // connect stream ends with exactly one terminal frame, then rethrow for the IPC
      // error boundary.
      emit({ kind: 'error', message: errorMessage(err) });
      throw err;
    }
  }

  /** Validate a pasted PAT and return the token + resolved login. */
  private async resolvePat(
    token: string | undefined,
  ): Promise<{ token: string; login: string }> {
    if (token === undefined || token === '') {
      throw new AppError('invalid_input', 'a GitHub token is required');
    }
    const { login } = await validatePat(token, { fetch: this.fetchImpl });
    return { token, login };
  }

  /** Run the device flow (requires a configured client id) and return token + login. */
  private async resolveDeviceFlow(
    onFrame: (frame: ConnectStatus) => void,
  ): Promise<{ token: string; login: string }> {
    if (this.clientId === undefined || this.clientId === '') {
      throw new AppError('integration', 'GitHub device flow is not configured');
    }
    return deviceFlowLogin(
      { clientId: this.clientId },
      { fetch: this.fetchImpl, onFrame },
    );
  }

  /** List connected integrations (optionally filtered by kind), newest first. */
  async list(kind?: Integration['kind']): Promise<Integration[]> {
    return this.repo.list(kind);
  }

  /** Disconnect an integration and delete its ciphertext blob (idempotent if absent). */
  async disconnect(integrationId: string): Promise<void> {
    const row = await this.repo.getById(integrationId);
    if (row === null) {
      return; // already gone — nothing to delete
    }
    // Remove the secret blob before the row so a failure never orphans plaintext.
    await this.secrets.remove(row.tokenRef);
    await this.repo.remove(integrationId);
  }

  /**
   * Resolve an authenticated Octokit client for the ACTIVE GitHub account
   * (most-recently-connected). Throws a typed `AppError` when no account is connected.
   * The decrypted token is passed to the factory only — never logged or returned.
   */
  async github(): Promise<Octokit> {
    const [active] = await this.repo.list('github');
    if (active === undefined) {
      throw new AppError('integration', 'no GitHub account connected');
    }
    const token = await this.secrets.get(active.tokenRef);
    return this.octokitFactory(token);
  }

  /**
   * Open a pull request for a workspace's branch (spec §5.6). Commits/pushes are
   * the caller's responsibility (git service); this handles the GitHub API call.
   */
  async openPr(_options: OpenPrOptions): Promise<PullRequest> {
    throw new Error('not implemented');
  }

  /** Fetch the PR associated with a workspace's branch, or `null` if none. */
  async getPr(_workspaceId: string): Promise<PullRequest | null> {
    throw new Error('not implemented');
  }

  /** List CI check runs + commit statuses for a workspace's PR head (spec §5.5). */
  async listChecks(_workspaceId: string): Promise<CheckRun[]> {
    throw new Error('not implemented');
  }

  /**
   * Merge a workspace's PR using the given strategy (spec §5.6 — enabled only
   * when Checks is green; enforced by the caller).
   */
  async mergePr(
    _workspaceId: string,
    _strategy: 'merge' | 'squash' | 'rebase',
  ): Promise<void> {
    throw new Error('not implemented');
  }
}

/** Build the renderer-facing `GithubAccount` from a persisted row + resolved login. */
function toGithubAccount(
  integration: Integration,
  login: string,
): GithubAccount {
  return { id: integration.id, login, kind: 'github' };
}

/**
 * Extract a display message for the terminal `error` frame. All errors thrown by this
 * service + its auth helpers are token-free by construction, so the message is safe to
 * surface; anything non-Error gets a fixed fallback.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'GitHub connection failed';
}
