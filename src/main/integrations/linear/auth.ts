// Linear authentication — personal API key / OAuth access-token validation (spec §6 /
// Phase 7 Task 5). Heightened-scrutiny path (secrets/tokens).
//
// AUTH MODE: this implements the API-KEY (personal access token) PASTE path — the minimum
// viable connect mode, which needs no browser round-trip and is fully unit-testable. Linear
// personal API keys authenticate GraphQL requests directly (see `authHeaderValue` in
// `./client.ts`), so "connecting" is: validate the pasted key by querying `viewer`, then
// hand the resolved account label back to `LinearService` to persist. A future OAuth
// authorization-code flow would slot in alongside this (mirroring GitHub's device flow)
// and reuse the same terminal-frame ownership: this module resolves a token + label; the
// service owns emitting the single terminal `connected`/`error` frame (the `connected`
// frame carries the persisted row id, which only exists after the service writes the row).
//
// SECURITY: a token/api-key is NEVER placed into any thrown message or log. The underlying
// `graphqlRequest` (in `./client.ts`) surfaces only the HTTP status or Linear's own
// non-secret error text — never the token or request headers.

import type { FetchLike } from './client';
import { LinearClient } from './client';

/**
 * Validate a pasted Linear API key / access token and resolve the account label. Returns
 * `{ label }` (the viewer's name, falling back to email/id) on success; throws a typed
 * `AppError` (with NO token in the message) on any auth/HTTP failure.
 *
 * `fetch` is injected (default = the runtime global) so tests drive this with a fake and
 * without a live network.
 */
export async function validateApiKey(
  token: string,
  deps: { fetch?: FetchLike } = {},
): Promise<{ label: string }> {
  const client = new LinearClient({ token, fetch: deps.fetch });
  const label = await client.viewerLabel();
  return { label };
}
