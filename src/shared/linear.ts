// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
//
// Linear integration DTOs (Phase 7 Task 5, spec §6). Mirrors `src/shared/github.ts`:
// the renderer-facing shapes that cross the IPC boundary for the `linear:*` channels.
// These carry NO token/secret — the plaintext API key is confined to the main-process
// `LinearService`/`SecretStore`/`LinearClient` (heightened-scrutiny, `.claude/rules/security.md`).
//
// This module is import-safe from BOTH processes (no electron/Node/DOM deps) — pure types.

/**
 * A connected Linear account, as surfaced to the renderer (mirrors `GithubAccount`). Uses
 * `label` (the viewer name/email) rather than GitHub's `login`, since Linear identifies an
 * account by its member name. NEVER carries the token — only the `integrations` row id.
 */
export interface LinearAccount {
  /** The `integrations` row id (used to `linear:disconnect`). */
  id: string;
  /** Human label — the Linear member's name (or email). */
  label: string;
  kind: 'linear';
}

/** An issue for the renderer's Linear issue picker (spec §6.5 — seed a workspace from an issue). */
export interface LinearIssue {
  id: string;
  /** Human identifier, e.g. "ENG-123". */
  identifier: string;
  title: string;
  url: string;
  /** Workflow-state name, or `null` when absent. */
  state: string | null;
}

/**
 * Frames streamed over the `linear:connect` flow, discriminated by `kind`. The API-key
 * paste path is synchronous, so only the terminal frames are emitted; the shape mirrors the
 * terminal end of GitHub's `ConnectStatus`. A future OAuth flow appends progress frames.
 */
export type LinearConnectStatus =
  | { kind: 'connected'; account: LinearAccount }
  | { kind: 'error'; message: string };

/**
 * How a caller asks to connect Linear. Only `'apiKey'` (personal API key / access-token
 * paste) is implemented today; kept as a union so an OAuth mode can be appended later.
 */
export type LinearConnectMode = 'apiKey';
