// LinearService — Linear connector (spec §6 / Phase 7 Task 5). Mirrors the connect/list/
// disconnect surface of `IntegrationService` (GitHub) for `kind:'linear'` rows, reusing the
// SAME injected `IntegrationsRepo` + `SecretStore`. The lead wires this into the main
// `IntegrationService`/context + the `linear:*` IPC handlers separately.
//
// SECURITY (heightened-scrutiny path — secrets/tokens): the plaintext token is confined to
// this service + `SecretStore` + `LinearClient`. It is NEVER persisted to the DB (only a
// `tokenRef`), never logged, and never placed into a thrown message or a frame crossing IPC.
// `connectLinear` owns emitting the single terminal `LinearConnectStatus` frame (`connected`
// with the persisted row id, or `error`) so the connect stream ends exactly once — mirroring
// `IntegrationService.connectGithub`.

import { AppError } from '@shared/errors';
import type {
  LinearAccount,
  LinearConnectMode,
  LinearConnectStatus,
  LinearIssue,
} from '@shared/linear';

import type { IntegrationsRepo } from '../../db/repos/integrations';
import type { Integration } from '../index';
import type { SecretStore } from '../secrets';
import { validateApiKey } from './auth';
import { LinearClient, type FetchLike } from './client';

// The renderer-facing DTOs live in the frozen shared contract (`@shared/linear`); re-export
// them here so existing importers of `./integrations/linear` keep resolving one definition.
export type { LinearAccount, LinearConnectMode, LinearConnectStatus };

/**
 * Dependencies injected into {@link LinearService}. Everything side-effecting is passed in so
 * the service is unit-testable without a live network or a booted Electron keychain:
 *   - `repo`    — the shared `integrations` table CRUD layer (owns the row + `tokenRef`).
 *   - `secrets` — encrypts/decrypts the token at rest (`SecretStore`).
 *   - `fetch`   — injected `fetch` for the Linear GraphQL calls (default = runtime global).
 *   - `clientFactory` — builds a `LinearClient` from a token (default = a real client with
 *     the injected `fetch`), so tests can substitute a fake client.
 */
export interface LinearServiceDeps {
  repo: IntegrationsRepo;
  secrets: SecretStore;
  fetch?: FetchLike;
  clientFactory?: (token: string) => LinearClient;
}

/**
 * Owns the Linear integration + its encrypted token. Constructed alongside the GitHub
 * `IntegrationService` with the same db repo + secret store injected.
 */
export class LinearService {
  private readonly repo: IntegrationsRepo;
  private readonly secrets: SecretStore;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly clientFactory: (token: string) => LinearClient;

  constructor(deps: LinearServiceDeps) {
    this.repo = deps.repo;
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetch;
    this.clientFactory =
      deps.clientFactory ??
      ((token) => new LinearClient({ token, fetch: this.fetchImpl }));
  }

  /**
   * Connect a Linear account via `mode`:
   *   - `'apiKey'` — validate the supplied `input.token` against `viewer`, then store it.
   *
   * On success the token is encrypted via {@link SecretStore} and an `integrations` row is
   * persisted holding only the `tokenRef` (never the token). Emits the single terminal
   * `LinearConnectStatus` frame — `connected` (carrying the persisted account) on success,
   * or `error` on failure — then returns the created {@link Integration} (`tokenRef`, never
   * the token). Never logs or throws the token.
   */
  async connectLinear(
    mode: LinearConnectMode,
    input: { token?: string },
    onFrame?: (frame: LinearConnectStatus) => void,
  ): Promise<Integration> {
    const emit = onFrame ?? ((): void => undefined);
    try {
      const { token, label } = await this.resolveApiKey(mode, input.token);

      // Encrypt-at-rest FIRST, then persist only the opaque ref.
      const tokenRef = await this.secrets.put(token);
      const integration = await this.repo.create({
        kind: 'linear',
        accountLabel: label,
        tokenRef,
      });

      emit({ kind: 'connected', account: toLinearAccount(integration, label) });
      return integration;
    } catch (err) {
      // Surface a domain error frame (message is token-free by construction) so the connect
      // stream ends with exactly one terminal frame, then rethrow for the IPC error boundary.
      emit({ kind: 'error', message: errorMessage(err) });
      throw err;
    }
  }

  /** Validate a pasted API key and return the token + resolved account label. */
  private async resolveApiKey(
    mode: LinearConnectMode,
    token: string | undefined,
  ): Promise<{ token: string; label: string }> {
    // Guard the mode explicitly so an unimplemented future mode fails closed rather than
    // silently treating a non-token as one.
    if (mode !== 'apiKey') {
      throw new AppError('invalid_input', 'unsupported Linear connect mode');
    }
    if (token === undefined || token === '') {
      throw new AppError('invalid_input', 'a Linear API key is required');
    }
    const { label } = await validateApiKey(token, { fetch: this.fetchImpl });
    return { token, label };
  }

  /** List connected Linear integrations, newest first. */
  async list(): Promise<Integration[]> {
    return this.repo.list('linear');
  }

  /** Disconnect a Linear integration and delete its ciphertext blob (idempotent if absent). */
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
   * Resolve an authenticated {@link LinearClient} for the ACTIVE Linear account
   * (most-recently-connected). Throws a typed `AppError` when no account is connected. The
   * decrypted token is passed to the factory only — never logged or returned.
   */
  async linear(): Promise<LinearClient> {
    const [active] = await this.repo.list('linear');
    if (active === undefined) {
      throw new AppError('integration', 'no Linear account connected');
    }
    const token = await this.secrets.get(active.tokenRef);
    return this.clientFactory(token);
  }

  /** List issues for the active Linear account (issue picker). */
  async listIssues(opts?: { first?: number }): Promise<LinearIssue[]> {
    const client = await this.linear();
    return client.listIssues(opts);
  }

  /**
   * Write a workspace's branch and/or PR URL back to a Linear issue as attachment link(s).
   * Both are optional so a caller can link just the branch at create time and the PR later.
   */
  async linkWorkspace(input: {
    issueId: string;
    branchUrl?: string;
    prUrl?: string;
  }): Promise<void> {
    const client = await this.linear();
    if (input.branchUrl !== undefined && input.branchUrl !== '') {
      await client.linkBranch(input.issueId, input.branchUrl);
    }
    if (input.prUrl !== undefined && input.prUrl !== '') {
      await client.linkPr(input.issueId, input.prUrl);
    }
  }

  /**
   * Transition an issue to a workflow state — the settings-gated status change on PR
   * open/merge. Callers gate on the relevant setting before invoking this.
   */
  async transitionOnPr(issueId: string, stateId: string): Promise<void> {
    const client = await this.linear();
    await client.setIssueState(issueId, stateId);
  }
}

/** Build the renderer-facing {@link LinearAccount} from a persisted row + resolved label. */
function toLinearAccount(
  integration: Integration,
  label: string,
): LinearAccount {
  return { id: integration.id, label, kind: 'linear' };
}

/**
 * Extract a display message for the terminal `error` frame. All errors thrown by this
 * service + its auth/client helpers are token-free by construction, so the message is safe
 * to surface; anything non-Error gets a fixed fallback.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Linear connection failed';
}
