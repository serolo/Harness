// PrWorkflow — the PR lifecycle service (spec §5.6). It stitches the local git
// worktree (commit + branch-only push), the per-repo GitHub façade (`GithubClient`),
// the merge-readiness aggregator (`ChecksService`), and settings into the four
// renderer-driven PR actions: open a PR, prepare a "fix reviews" turn, prepare a
// "fix checks" turn, and merge. Constructed in `src/main/index.ts` (Task 9) with its
// collaborators injected; surfaced over IPC by Task 8.
//
// SECURITY (heightened-scrutiny — git push + PR merge on user workspaces):
//   - Publishing is branch-only: we delegate to `GitService.push(wt, 'origin', branch)`
//     which HARD-refuses `--all`/`--tags`/`--mirror`, so app-local refs (checkpoints)
//     never leave the user's disk. We never build a remote URL or embed a token.
//   - Merge is SERVER-GATED: `merge()` refuses unless `ChecksService` reports the
//     workspace green with no `blocker` rows, independent of whatever the renderer's
//     button state claimed. GitHub's own mergeability is then polled before the call.
//   - No secrets: the token lives only inside the Octokit built by
//     `IntegrationService.github()`; it is never logged, returned, or thrown. Errors
//     bubble as typed `AppError`s (the `GithubClient` already scrubs auth headers).
//   - This service NEVER starts an agent turn. Per the Phase-4 "prepare-the-turn" rule,
//     `fixReviews`/`fixChecks` only COMPOSE a prompt + attachments and hand them back;
//     the renderer feeds them into a normal `turn:start`.

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Attachment } from '@shared/harness';
import type { MergeMethod, PrSummary, ReviewThread } from '@shared/github';
import type { Project, Workspace } from '@shared/models';

import { AppError } from '../../error';
import type { ChecksService } from '../../checks';
import type { WorkspacesRepo } from '../../db/repos/workspaces';
import type { DiffService } from '../../diff';
import type { GitDiff, GitService } from '../../git';
import type { SettingsService } from '../../settings';
import type { IntegrationService } from '../index';
import { GithubClient, parseOwnerName } from './client';

// --- Tuning constants -------------------------------------------------------------------

/** How many times `merge()` re-polls GitHub's `mergeableState` before giving up. */
const MERGE_POLL_MAX_ATTEMPTS = 10;
/** Delay between merge-readiness polls (via the injected `sleep`, so tests stay fast). */
const MERGE_POLL_INTERVAL_MS = 2_000;
/** GitHub's terminal "ready to merge" mergeable state. */
const MERGEABLE_CLEAN = 'clean';

/**
 * Upper bound on the detail text attached per failing check. The agent only needs the
 * failure summary to start investigating; capping keeps the attachment (and the token
 * budget of the turn it seeds) bounded regardless of how verbose a check's detail is.
 */
const MAX_CHECK_DETAIL_CHARS = 4_000;
/** Cap on how many failing checks we attach, so a storm of failures stays bounded. */
const MAX_FAILING_CHECKS_ATTACHED = 20;

/**
 * Check-run conclusions we treat as FAILING (worth surfacing to a fix turn). `neutral`,
 * `skipped`, and `stale` are not failures; `null` means still running.
 */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);

/** Combined-status states we treat as FAILING. */
const FAILING_STATUS_STATES: ReadonlySet<string> = new Set([
  'failure',
  'error',
]);

/** Fallback PR-draft prompt used until Task 10 adds `agent.prPrompt` to the schema. */
const DEFAULT_PR_PROMPT =
  'Summarize the change below into a clear pull-request description: what it does, ' +
  'why, and anything a reviewer should look at closely.';

// --- Dependencies -----------------------------------------------------------------------

/**
 * Collaborators injected into {@link PrWorkflow}. Everything side-effecting (git, the
 * GitHub API, checks, db, settings, diff) is passed in so the service is unit-testable
 * without a live network or a booted app. `getWorkspace`/`getProject` mirror the
 * resolver seams used by sibling services (e.g. `DiffService`). `sleep` is injectable so
 * the bounded merge-readiness polling is deterministic under test.
 */
export interface PrWorkflowDeps {
  git: GitService;
  integrations: IntegrationService;
  checks: ChecksService;
  workspaces: WorkspacesRepo;
  /** Resolve a workspace by id (null when unknown/archived). */
  getWorkspace: (id: string) => Promise<Workspace | null>;
  /** Resolve a project by id (null when unknown). */
  getProject: (id: string) => Promise<Project | null>;
  settings: SettingsService;
  diff: DiffService;
  /** Injected for testable merge polling; defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Options for {@link PrWorkflow.openPr}. */
export interface OpenPrOptions {
  /** Open as a draft PR. */
  draft?: boolean;
  /** Explicit title (the seam for a renderer-run agent draft); derived when omitted. */
  title?: string;
  /** Explicit body (the seam for a renderer-run agent draft); derived when omitted. */
  body?: string;
  /** Base branch to target; defaults to the project default branch, then `baseBranch`. */
  base?: string;
}

/** The composed input for a renderer-driven "fix" turn (reviews or checks). */
export interface FixTurn {
  /** Instruction prompt fed into a normal `turn:start`. */
  prompt: string;
  /** Attachments mirroring the frozen `Attachment` shape (`@shared/harness`). */
  attachments: Attachment[];
}

// --- Service ----------------------------------------------------------------------------

/**
 * Owns the PR lifecycle for a workspace. Stateless apart from its injected deps; a
 * fresh {@link GithubClient} is built per call from the ACTIVE GitHub account + the
 * workspace's project origin, so a re-auth or account switch is picked up automatically.
 */
export class PrWorkflow {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: PrWorkflowDeps) {
    this.sleep =
      deps.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Open (or re-open the summary of) a pull request for a workspace's branch (spec §5.6).
   *
   * Flow: commit any pending work (no-op-safe), push the branch ONLY, then create the PR
   * and persist its number. Title/body are taken verbatim from `opts` when provided (the
   * seam for a renderer-run agent draft); otherwise a deterministic fallback is derived
   * from the branch name + a diff summary. This method NEVER starts an agent turn.
   */
  async openPr(
    workspaceId: string,
    opts: OpenPrOptions = {},
  ): Promise<PrSummary> {
    const { workspace, project, wt } = await this.resolve(workspaceId);
    const branch = workspace.branch;

    // 1. Commit any pending work so the push publishes the latest tree. `git.status`
    //    tells us whether there is anything to commit; `git.commit` is itself no-op-safe
    //    (throws a typed 'nothing to commit'), which we tolerate to cover the race where
    //    the tree goes clean between the status check and the commit.
    const status = await this.deps.git.status(wt);
    if (!status.clean) {
      try {
        await this.deps.git.commit(wt, `WIP: ${branch}`);
      } catch (err) {
        if (!isNothingToCommit(err)) throw err;
      }
    }

    // 2. Publish the branch (and ONLY the branch — see file header). Set upstream on the
    //    first push so subsequent pushes track `origin/<branch>`.
    const setUpstream = !(await this.deps.git.hasUpstream(wt));
    await this.deps.git.push(wt, 'origin', branch, { setUpstream });

    // 3. If this branch already has an open PR, return it instead of trying to create a
    //    duplicate. This happens after commit/push so the "Commit & push" action still
    //    publishes the latest local tree before the PR summary is returned.
    const client = await this.clientFor(project);
    const existing = await client.getPr(branch);
    if (existing !== null) {
      if (workspace.prNumber !== existing.number) {
        await this.deps.workspaces.update(workspaceId, {
          prNumber: existing.number,
        });
      }
      return existing;
    }

    // 4. Resolve title/body. Explicit values win; otherwise derive a deterministic draft.
    const base = opts.base ?? project.defaultBranch ?? workspace.baseBranch;
    const title = opts.title ?? titleFromBranch(branch);
    const body = opts.body ?? (await this.deriveBody(workspaceId));

    // 5. Create the PR via the per-repo client, then persist its number on the workspace.
    const pr = await client.createPr({
      head: branch,
      base,
      title,
      body,
      draft: opts.draft ?? false,
    });
    await this.deps.workspaces.update(workspaceId, { prNumber: pr.number });
    return pr;
  }

  /**
   * Prepare a "fix review comments" turn (spec §5.6). Resolves the workspace's PR, reads
   * its review threads, keeps the UNRESOLVED ones, and composes an instruction `prompt`
   * plus `diff_comment` attachments so the agent can address each. Resolution is a
   * SEPARATE, user-driven step ({@link resolveThread}); this method never resolves.
   */
  async fixReviews(workspaceId: string): Promise<FixTurn> {
    const { workspace, project } = await this.resolve(workspaceId);
    const client = await this.clientFor(project);
    const pr = await this.resolvePr(client, workspace);

    const unresolved = (await client.reviewThreads(pr.number)).filter(
      (thread) => !thread.resolved,
    );

    if (unresolved.length === 0) {
      return {
        prompt:
          `Pull request #${pr.number} has no unresolved review comments. ` +
          'Nothing to address.',
        attachments: [],
      };
    }

    const lines: string[] = [];
    const attachments: Attachment[] = [];
    for (const thread of unresolved) {
      const location = threadLocation(thread);
      const commentText = thread.comments
        .map((c) => (c.author ? `@${c.author}: ${c.body}` : c.body))
        .join('\n')
        .trim();
      lines.push(`- ${location}\n${indent(commentText)}`);

      // Emit a `diff_comment` attachment for line-anchored threads. We do not have the
      // reviewed code excerpt here, so the (required, non-empty) `excerpt` carries the
      // location reference and `body` carries the reviewer's comment — the same fields a
      // renderer-side inline comment would populate.
      if (
        thread.path !== undefined &&
        thread.line !== undefined &&
        commentText !== ''
      ) {
        attachments.push({
          type: 'diff_comment',
          file: thread.path,
          lineStart: thread.line,
          lineEnd: thread.line,
          side: 'new',
          excerpt: location,
          body: commentText,
        });
      }
    }

    const prompt =
      `Address the following unresolved review comments on pull request #${pr.number}. ` +
      'For each, edit the code as needed, then summarize what you changed. Do NOT resolve ' +
      'the threads yourself — the user will mark them resolved.\n\n' +
      lines.join('\n\n');

    return { prompt, attachments };
  }

  /**
   * Prepare a "fix failing checks" turn (spec §5.6). Resolves the PR head SHA, reads its
   * check-runs + combined statuses, keeps the FAILING ones, and attaches each failure's
   * detail as a TRUNCATED text file (the frozen `Attachment` union has no inline-text
   * variant, so a `file` attachment carries the detail). Composes an instruction prompt.
   */
  async fixChecks(workspaceId: string): Promise<FixTurn> {
    const { workspace, project, wt } = await this.resolve(workspaceId);
    const client = await this.clientFor(project);

    // The checks run against the pushed HEAD commit. After `openPr` the local HEAD SHA
    // matches the remote branch tip.
    const { sha } = await this.deps.git.headInfo(wt);

    const [checkRuns, statuses] = await Promise.all([
      client.listCheckRuns(sha),
      client.listStatuses(sha),
    ]);

    // Collect failing signals as { label, detail } pairs from both sources.
    const failures: { label: string; detail: string }[] = [];
    for (const run of checkRuns) {
      if (
        run.status === 'completed' &&
        run.conclusion !== null &&
        FAILING_CONCLUSIONS.has(run.conclusion)
      ) {
        failures.push({
          label: `check: ${run.name} (${run.conclusion})`,
          detail: [
            `Check run: ${run.name}`,
            `Conclusion: ${run.conclusion}`,
            run.detailsUrl ? `Details: ${run.detailsUrl}` : undefined,
          ]
            .filter((l): l is string => l !== undefined)
            .join('\n'),
        });
      }
    }
    for (const status of statuses) {
      if (FAILING_STATUS_STATES.has(status.state)) {
        failures.push({
          label: `status: ${status.context} (${status.state})`,
          detail: [
            `Status context: ${status.context}`,
            `State: ${status.state}`,
            status.targetUrl ? `Details: ${status.targetUrl}` : undefined,
          ]
            .filter((l): l is string => l !== undefined)
            .join('\n'),
        });
      }
    }

    if (failures.length === 0) {
      return {
        prompt:
          `No failing CI checks or statuses were found for the head commit of workspace ` +
          `${workspace.name}. Nothing to fix.`,
        attachments: [],
      };
    }

    // Write each failure's (truncated) detail to a temp file and attach it. The temp dir
    // + file names are app-generated (never user-controlled), so there is no path-
    // traversal surface here.
    const bounded = failures.slice(0, MAX_FAILING_CHECKS_ATTACHED);
    const attachments = await this.writeCheckAttachments(bounded);

    const prompt =
      'The following CI checks are failing on this pull request. Investigate each ' +
      'failure (details are attached), fix the underlying cause in the code, and verify ' +
      'locally.\n\n' +
      bounded.map((f) => `- ${f.label}`).join('\n');

    return { prompt, attachments };
  }

  /**
   * Merge a workspace's PR (spec §5.6). SERVER-GATED: refuses unless `ChecksService`
   * reports the workspace green with no `blocker` rows — the authoritative gate,
   * independent of the renderer's button state. Then polls GitHub's `mergeableState`
   * (bounded, via the injected `sleep`) so we give GitHub time to finish computing
   * mergeability before issuing the merge with the chosen (or configured) strategy.
   *
   * @returns `{ archiveSuggested: true }` — the caller may prompt to archive the merged
   *          workspace (spec §5.6 post-merge).
   */
  async merge(
    workspaceId: string,
    method?: MergeMethod,
  ): Promise<{ archiveSuggested: boolean }> {
    // 1. Server-side merge gate: checks must be green with no blockers. Force a fresh
    //    recompute against the CURRENT head rather than trusting a possibly-stale cached
    //    result — the cache can hold a `green` computed before CI regressed / a review
    //    thread opened on the same head, and this gate (not the renderer's disabled button)
    //    is the enforcement point.
    const checks = await this.deps.checks.refresh(workspaceId);
    if (
      checks.state !== 'green' ||
      checks.items.some((item) => item.severity === 'blocker')
    ) {
      throw new AppError('integration', 'cannot merge: checks not green', {
        workspaceId,
        state: checks.state,
      });
    }

    const { workspace, project } = await this.resolve(workspaceId);
    const client = await this.clientFor(project);
    const pr = await this.resolvePr(client, workspace);

    // 2. Poll GitHub's own mergeability until `clean` or the bounded attempt cap. This
    //    covers the window where GitHub is still computing `mergeableState` right after a
    //    push; a non-clean terminal state is left to GitHub to reject on the merge call.
    let mergeableState = pr.mergeableState;
    for (
      let attempt = 0;
      attempt < MERGE_POLL_MAX_ATTEMPTS && mergeableState !== MERGEABLE_CLEAN;
      attempt += 1
    ) {
      await this.sleep(MERGE_POLL_INTERVAL_MS);
      mergeableState = (await client.getPrByNumber(pr.number)).mergeableState;
    }

    // 3. Merge with the requested strategy, falling back to the configured default.
    const strategy = method ?? this.deps.settings.get().git.mergeStrategy;
    await client.mergePr(pr.number, strategy);

    return { archiveSuggested: true };
  }

  /**
   * Mark a single review thread resolved (spec §5.6) — a passthrough to the GitHub
   * GraphQL mutation. Kept separate from {@link fixReviews} because resolution is a
   * user-driven "I'm done with this" action, not part of preparing the fix turn.
   */
  async resolveThread(workspaceId: string, threadId: string): Promise<void> {
    const { project } = await this.resolve(workspaceId);
    const client = await this.clientFor(project);
    await client.resolveThread(threadId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a workspace + its project + worktree path. Mirrors `DiffService`'s error
   * codes: `not_found` for a missing workspace/project, `conflict` for an archived
   * workspace with no worktree.
   */
  private async resolve(
    workspaceId: string,
  ): Promise<{ workspace: Workspace; project: Project; wt: string }> {
    const workspace = await this.deps.getWorkspace(workspaceId);
    if (workspace === null) {
      throw new AppError('not_found', 'workspace not found', { workspaceId });
    }
    const project = await this.deps.getProject(workspace.projectId);
    if (project === null) {
      throw new AppError('not_found', 'project not found', {
        projectId: workspace.projectId,
      });
    }
    if (!workspace.worktreePath) {
      throw new AppError('conflict', 'workspace has no worktree (archived?)', {
        workspaceId,
      });
    }
    return { workspace, project, wt: workspace.worktreePath };
  }

  /** Build a per-repo {@link GithubClient} for the ACTIVE GitHub account + this project. */
  private async clientFor(project: Project): Promise<GithubClient> {
    const octokit = await this.deps.integrations.github();
    return new GithubClient(octokit, parseOwnerName(project.originUrl), {
      sleep: this.sleep,
    });
  }

  /**
   * Resolve the workspace's PR summary: prefer the persisted `prNumber` (authoritative,
   * full detail so `mergeableState` is meaningful), else look it up by branch head.
   * Throws `not_found` when the branch has no PR.
   */
  private async resolvePr(
    client: GithubClient,
    workspace: Workspace,
  ): Promise<PrSummary> {
    if (workspace.prNumber !== null) {
      return client.getPrByNumber(workspace.prNumber);
    }
    const pr = await client.getPr(workspace.branch);
    if (pr === null) {
      throw new AppError('not_found', 'no pull request for this workspace', {
        workspaceId: workspace.id,
        branch: workspace.branch,
      });
    }
    return pr;
  }

  /**
   * Derive a deterministic PR body from the settings PR-draft prompt template + a diff
   * summary. A diff read failure degrades gracefully to the template alone rather than
   * blocking PR creation. NEVER starts a turn — this is a static, best-effort fallback.
   */
  private async deriveBody(workspaceId: string): Promise<string> {
    // `agent.prPrompt` lands in Task 10; until then read it defensively with a default.
    const agent = this.deps.settings.get().agent as { prPrompt?: string };
    const template = agent.prPrompt ?? DEFAULT_PR_PROMPT;

    let summary = '';
    try {
      summary = summarizeDiff(await this.deps.diff.getDiff(workspaceId));
    } catch {
      summary = '';
    }
    return summary === '' ? template : `${template}\n\n${summary}`;
  }

  /** Write each failing check's truncated detail to a temp file, as `file` attachments. */
  private async writeCheckAttachments(
    failures: { label: string; detail: string }[],
  ): Promise<Attachment[]> {
    const dir = join(tmpdir(), `harness-checks-${randomUUID()}`);
    await mkdir(dir, { recursive: true });

    const attachments: Attachment[] = [];
    let index = 0;
    for (const failure of failures) {
      const path = join(dir, `check-${index}.log`);
      await writeFile(
        path,
        truncate(failure.detail, MAX_CHECK_DETAIL_CHARS),
        'utf8',
      );
      attachments.push({ type: 'file', path });
      index += 1;
    }
    return attachments;
  }
}

// --- Pure helpers -----------------------------------------------------------------------

/** True when a thrown value is `git.commit`'s typed "nothing to commit" no-op signal. */
function isNothingToCommit(err: unknown): boolean {
  return (
    err instanceof AppError &&
    err.code === 'git' &&
    err.message.toLowerCase().includes('nothing to commit')
  );
}

/**
 * Derive a human PR title from a branch name: drop a leading `prefix/`, then turn
 * separators into spaces and capitalize. Deterministic (no dates / randomness) so tests
 * can assert on it. Falls back to the raw branch when the result would be empty.
 */
function titleFromBranch(branch: string): string {
  const withoutPrefix = branch.includes('/')
    ? branch.slice(branch.indexOf('/') + 1)
    : branch;
  const words = withoutPrefix.replace(/[-_/]+/g, ' ').trim();
  if (words === '') return branch;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A short one-line location for a review thread ("path:line", or a fallback). */
function threadLocation(thread: ReviewThread): string {
  if (thread.path !== undefined && thread.line !== undefined) {
    return `${thread.path}:${thread.line}`;
  }
  if (thread.path !== undefined) return thread.path;
  return 'general comment';
}

/** Indent every line of `text` by two spaces (for readable nested prompt bullets). */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * Summarize a computed diff into a compact, deterministic PR-body fragment: the file
 * count + total additions/deletions, then up to the first ten changed file paths.
 */
function summarizeDiff(diff: GitDiff): string {
  if (diff.files.length === 0) return '';
  const additions = diff.files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = diff.files.reduce((sum, f) => sum + f.deletions, 0);
  const header = `Changes: ${diff.files.length} file(s), +${additions}/-${deletions}.`;
  const list = diff.files
    .slice(0, 10)
    .map((f) => `- ${f.path}`)
    .join('\n');
  const more =
    diff.files.length > 10 ? `\n- …and ${diff.files.length - 10} more` : '';
  return `${header}\n\n${list}${more}`;
}

/** Cap `text` to `max` chars, appending a truncation marker when it was shortened. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
