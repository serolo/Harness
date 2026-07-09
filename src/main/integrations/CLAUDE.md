# CLAUDE.md — `src/main/integrations` (GitHub integration + secrets)

`IntegrationService` owns GitHub auth and hands the rest of main an authed Octokit; the
per-repo `GithubClient` wraps the REST/GraphQL calls the Checks/PR flows need.
**Heightened-scrutiny path**: network egress + credentials (`.claude/rules/security.md`).
The decrypted token NEVER leaves this subsystem — `checks`, `diff`, and the renderer only
ever see derived data.

## Token at rest

Tokens are encrypted with Electron `safeStorage` and written to
`<userData>/secrets/<uuid>` with `0600` permissions. The `integrations` DB row holds only
a `token_ref` (the uuid) — never the ciphertext, never the plaintext. Disconnecting an
account deletes the blob and the row. No token appears in logs, errors, check labels, or
anything crossing the IPC boundary.

## Connecting: device flow + PAT

`github:connect` drives two modes over one stream (`ConnectStatus` frames): the OAuth
**device flow** (`device_code` → `pending`/`slow_down` polls → `connected`/`error`) and a
direct **PAT** paste. Both end by persisting the encrypted token + a `token_ref`.

## The client: ETag/conditional caching + backoff

`GithubClient` uses conditional requests (ETag / `If-None-Match`) and treats `304` as a
cache hit to stay under the rate limit. On `403`/`429` it honors `Retry-After` /
`X-RateLimit-Reset` with bounded backoff. Callers (e.g. `ChecksService`) treat any client
error as a graceful degrade, not a crash.

## Push is branch-only

Publishing a workspace branch pushes ONLY that branch — never `--all`, `--tags`, or
`--mirror`. This is deliberate: local `refs/checkpoints/*` (Phase-4 per-turn checkpoints)
must stay local and never reach the remote. Use an explicit `refspec` for the single
branch.

## Linear (Phase 7 — `linear/`)

`LinearService` mirrors `IntegrationService`'s connect/list/disconnect surface for `kind:'linear'`
rows, **reusing the same `IntegrationsRepo` + `SecretStore`** (no new table, no migration — the
`integrations` row's `kind` discriminates). Connect today is an **API-key paste** (`mode:'apiKey'`);
the seam is shaped so an OAuth authorization-code flow slots in like GitHub's device flow (this
module resolves `{token,label}`; the service owns the single terminal `connected`/`error` frame).
`LinearClient` speaks Linear's single **GraphQL** endpoint over an injected `fetch` (no
`graphql-request` dep). **Auth header scheme:** personal keys (prefix `lin_api_`) are sent **raw**
in `Authorization`; OAuth access tokens use `Bearer` (`authHeaderValue`). Same token discipline as
GitHub: plaintext confined to service→`SecretStore`→client, DB holds only `token_ref`, and errors
carry only the HTTP status or Linear's own GraphQL text — never the key. IPC is `linear:*`
(mirrors `github:*`); the renderer's "From Linear" tab (`NewWorkspaceDialog`) lists issues + seeds
the composer. Write-back (`linkWorkspace`/`transitionOnPr`, exposed as `linear:link`/`linear:transition`)
is implemented + tested but **not yet wired into the PR-open flow** (follow-on).

## Merge is server-gated on green

`pr:merge` re-checks the roll-up is `green` (no blockers) on the main side before calling
GitHub — the renderer's disabled Merge button is only a mirror of this gate, not the
enforcement point. Never merge on the strength of the client's button state alone.
