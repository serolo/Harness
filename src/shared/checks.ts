// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
// Phase 5 checks DTOs — the cross-boundary shapes for the merge-readiness Checks
// panel (spec §5.5). Import-safe from both main and renderer: types only, no
// `electron`, no Node-only (`fs`/`path`/…), no DOM-only imports.
//
// These are the CANONICAL definitions of the Checks roll-up shapes. The Phase-0
// stub in `src/main/checks/index.ts` declares byte-identical `ChecksState` /
// `CheckSource` / `CheckSeverity` / `CheckItem` / `ChecksResult`; a later task
// reconciles that stub to re-export from here rather than redeclaring (mirrors how
// `src/main/diff` re-exports from `@shared/review`). This module stays self-
// contained — it never imports from `src/main/*`.

/** Overall roll-up state (drives the Merge-button gate, spec §5.5). */
export type ChecksState = 'green' | 'blocked' | 'pending';

/** Which subsystem produced a check row (spec §5.5 table). */
export type CheckSource =
  'git' | 'pr' | 'ci' | 'deployment' | 'review' | 'todos';

/** Severity of a single check row. `blocker` (red) gates merge. */
export type CheckSeverity = 'ok' | 'pending' | 'warning' | 'blocker';

/**
 * Per-source structured detail for the Checks panel, discriminated by `source`
 * (one variant per `CheckSource`). Carried by `CheckItem.details`; a consumer
 * narrows on `details.source` to render the source-specific payload.
 */
export type CheckDetails =
  | {
      source: 'git';
      /** Commits ahead of the base branch. */
      ahead: number;
      /** Commits behind the base branch. */
      behind: number;
      /** Count of uncommitted (working-tree + staged) changes. */
      uncommitted: number;
      /** Local commits not yet pushed to the remote tracking branch. */
      unpushed: boolean;
    }
  | {
      source: 'pr';
      /** PR number, absent when no PR exists yet. */
      number?: number;
      url?: string;
      title?: string;
      draft?: boolean;
      /** GitHub mergeable state (clean/dirty/blocked/unknown/…). */
      mergeableState?: string;
    }
  | {
      source: 'ci';
      /** Total check runs / statuses observed for the PR head. */
      total: number;
      /** How many concluded in a failing state. */
      failing: number;
      /** How many are still queued/in-progress. */
      pending: number;
      runs: {
        name: string;
        /** Terminal conclusion (success/failure/…), null while still running. */
        conclusion: string | null;
        detailsUrl: string | null;
      }[];
    }
  | {
      source: 'deployment';
      environments: {
        name: string;
        state: string;
        url?: string;
      }[];
    }
  | {
      source: 'review';
      /** Count of unresolved review threads. */
      unresolved: number;
      /** Opaque per-thread payload (renderer treats as read-only). */
      threads?: unknown[];
    }
  | {
      source: 'todos';
      /** Count of still-open todos. */
      open: number;
      items: { body: string; done: boolean }[];
    };

/** One aggregated signal (spec §5.5 rows). */
export interface CheckItem {
  source: CheckSource;
  /** Short human label ("Behind base", "CI: 2 failing", …). */
  label: string;
  severity: CheckSeverity;
  /** Optional one-click next action ("Commit & push", "Create PR", "Fix check"). */
  suggestedAction?: string;
  /** Structured per-source detail for the panel, narrowed on `details.source`. */
  details?: CheckDetails;
}

/** The aggregated checks result for a workspace (spec §5.5). */
export interface ChecksResult {
  workspaceId: string;
  state: ChecksState;
  items: CheckItem[];
  /** When this result was computed (epoch millis). */
  updatedAt: number;
}
