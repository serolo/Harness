// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
// Phase 5 GitHub DTOs — the cross-boundary shapes for the GitHub integration:
// device-flow connect, account listing, PRs, issues, and review threads (spec §5.6
// / §6). Import-safe from both main and renderer: types only, no `electron`, no
// Node-only (`fs`/`path`/…), no DOM-only imports.
//
// These mirror the naming of the Phase-0 `src/main/integrations` stub
// (`Integration` / `PullRequest` / `CheckRun`) but stay self-contained — the
// renderer cannot import from `src/main/*`, so the boundary shapes live here.

/** A connected GitHub account, as surfaced to the renderer (`github:accounts`). */
export interface GithubAccount {
  /** The `integrations` row id (used to `github:disconnect`). */
  id: string;
  /** The GitHub login handle. */
  login: string;
  kind: 'github';
}

/** Local GitHub CLI authentication state. Never carries a token. */
export interface GithubCliAuthStatus {
  /** Whether the `gh` executable was found. */
  available: boolean;
  /** Whether `gh auth status` reports an authenticated github.com account. */
  authenticated: boolean;
  /** Best-effort account login parsed from gh output. */
  login?: string;
  /** Human-readable status/error text, token-free. */
  message?: string;
}

/** Merge strategy for `pr:merge` (spec §5.6). */
export type MergeMethod = 'merge' | 'squash' | 'rebase';

/**
 * A pull request summary for the PR/Checks panels (spec §5.5–5.6). Aligns with the
 * main-side `PullRequest` stub, plus an optional GitHub `state` (open/closed/merged).
 */
export interface PrSummary {
  number: number;
  url: string;
  title: string;
  draft: boolean;
  /** GitHub mergeable state (clean/dirty/blocked/unknown/…). */
  mergeableState: string;
  /** GitHub PR state (open/closed/merged), when known. */
  state?: string;
}

/** A row in the project's PR list (`github:listPrs`). */
export interface PrListItem {
  number: number;
  title: string;
  url: string;
  author?: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt?: string;
}

/** A row in the project's issue list (`github:listIssues`). */
export interface IssueListItem {
  number: number;
  title: string;
  url: string;
  /** GitHub issue state (open/closed), when known. */
  state?: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt?: string;
}

/** A GitHub review thread with its comments (spec §5.5 review-thread signal). */
export interface ReviewThread {
  id: string;
  /** File the thread is anchored to, if line-anchored. */
  path?: string;
  /** Line the thread is anchored to, if line-anchored. */
  line?: number;
  resolved: boolean;
  comments: { author: string; body: string }[];
}

/**
 * Frames streamed over the `github:connect` device-flow stream, discriminated by
 * `kind`. The leading `device_code` frame carries the user code + verification URI
 * to display; `pending`/`slow_down` frames report poll progress; the stream ends
 * with either `connected` (carrying the linked account) or `error`.
 */
export type ConnectStatus =
  | {
      kind: 'device_code';
      userCode: string;
      verificationUri: string;
      /** Seconds until the device code expires. */
      expiresIn: number;
      /** Seconds to wait between polls. */
      interval: number;
    }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'connected'; account: GithubAccount }
  | { kind: 'error'; message: string };
