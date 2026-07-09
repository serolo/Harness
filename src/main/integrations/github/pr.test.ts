// PrWorkflow tests (Task 7) — written INDEPENDENTLY of the implementation, from the
// spec in `./pr.ts`'s own header comments + the class's public contract. Heightened
// scrutiny: this is the git-push + PR-merge surface (`.claude/rules/security.md`).
//
// NO live network, NO real git: every collaborator (`git`, `integrations`, `checks`,
// `workspaces`, `getWorkspace`/`getProject`, `settings`, `diff`, `sleep`) is a plain
// fake object cast to the collaborator's type — mirroring `client.test.ts`'s
// `octokit as unknown as Octokit` pattern. We deliberately let `integrations.github()`
// return a FAKE Octokit (`{ request, graphql }`) rather than stubbing `GithubClient`
// directly, so the tests exercise the same REST/GraphQL route shapes `GithubClient`
// really sends — this is the seam the task brief calls out.
//
// Two properties get the most attention because a regression here is a real-world
// incident, not a test nitpick:
//   1. `merge()` must NEVER call the merge API unless `ChecksService` reports green
//      with no blocker rows — independent of whatever GitHub's own mergeableState says.
//   2. `openPr()` must publish ONLY the named branch — never `--all`/`--tags`/`--mirror`.

import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Octokit } from '@octokit/rest';

import type { Attachment } from '@shared/harness';
import type { Project, Workspace } from '@shared/models';
import type { CheckItem, ChecksResult } from '@shared/checks';

import { AppError } from '../../error';
import type { ChecksService } from '../../checks';
import type { WorkspacesRepo } from '../../db/repos/workspaces';
import type { DiffService } from '../../diff';
import type { GitDiff, GitService, GitStatus, HeadInfo } from '../../git';
import type { SettingsService } from '../../settings';
import {
  EffectiveSettingsSchema,
  type EffectiveSettings,
} from '../../settings/schema';
import type { IntegrationService } from '../index';
import { PrWorkflow } from './pr';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'demo',
    originUrl: 'https://github.com/acme/repo.git',
    defaultBranch: 'main',
    repoPath: '/repos/demo',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    projectId: 'proj-1',
    name: 'tokyo',
    branch: 'agent/tokyo-feature',
    baseBranch: 'main',
    worktreePath: '/tmp/worktrees/tokyo',
    status: 'idle',
    sourceKind: null,
    sourceRef: null,
    harness: 'claude_code',
    port: null,
    createdAt: Date.now(),
    archivedAt: null,
    prNumber: null,
    ...overrides,
  };
}

/** A successful Octokit REST response shape (mirrors client.test.ts). */
function ok<T>(
  data: T,
  headers: Record<string, string | undefined> = {},
): { data: T; status: number; headers: Record<string, string | undefined> } {
  return { data, status: 200, headers };
}

/** A minimal REST pull payload (only fields GithubClient maps). */
function restPull(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 1,
    html_url: 'https://github.com/acme/repo/pull/1',
    title: 'A PR',
    draft: false,
    state: 'open',
    mergeable_state: 'clean',
    user: { login: 'alice' },
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Fake Octokit — only `request`/`graphql` are ever called by GithubClient. */
function fakeOctokit(): {
  request: ReturnType<typeof vi.fn>;
  graphql: ReturnType<typeof vi.fn>;
} {
  return { request: vi.fn(), graphql: vi.fn() };
}

interface SetupOptions {
  workspace?: Partial<Workspace>;
  project?: Partial<Project>;
  settings?: {
    git?: Partial<EffectiveSettings['git']>;
    agent?: Partial<EffectiveSettings['agent']>;
  };
}

function setup(opts: SetupOptions = {}) {
  const workspace = makeWorkspace(opts.workspace);
  const project = makeProject(opts.project);
  const octokit = fakeOctokit();

  const git = {
    status: vi.fn<(wt: string) => Promise<GitStatus>>(),
    commit: vi.fn<(wt: string, message: string) => Promise<{ sha: string }>>(),
    hasUpstream: vi.fn<(wt: string) => Promise<boolean>>(),
    push: vi.fn<
      (
        wt: string,
        remote: string,
        branch: string,
        opts?: { setUpstream?: boolean },
      ) => Promise<void>
    >(),
    headInfo: vi.fn<(wt: string, baseRef?: string) => Promise<HeadInfo>>(),
  };

  const checks = {
    // merge() forces a fresh recompute through refresh() (not the cached get()) so the
    // gate reflects the current head — the fake mirrors that seam.
    refresh: vi.fn<(workspaceId: string) => Promise<ChecksResult>>(),
  };

  const workspaces = {
    update: vi.fn(async (_id: string, patch: { prNumber?: number | null }) => ({
      ...workspace,
      ...patch,
    })),
  };

  const integrations = {
    github: vi.fn(async () => octokit as unknown as Octokit),
  };

  const baseSettings = EffectiveSettingsSchema.parse({});
  const settingsSnapshot: EffectiveSettings = {
    ...baseSettings,
    git: { ...baseSettings.git, ...(opts.settings?.git ?? {}) },
    agent: { ...baseSettings.agent, ...(opts.settings?.agent ?? {}) },
  };
  const settings = { get: vi.fn(() => structuredClone(settingsSnapshot)) };

  const diff = {
    getDiff: vi.fn<(workspaceId: string) => Promise<GitDiff>>(async () => ({
      baseRef: 'main',
      headRef: 'HEAD',
      files: [],
      patch: '',
    })),
  };

  const sleep = vi.fn(async (_ms: number) => undefined);

  const getWorkspace = vi.fn(async (id: string) =>
    id === workspace.id ? workspace : null,
  );
  const getProject = vi.fn(async (id: string) =>
    id === project.id ? project : null,
  );

  const workflow = new PrWorkflow({
    git: git as unknown as GitService,
    integrations: integrations as unknown as IntegrationService,
    checks: checks as unknown as ChecksService,
    workspaces: workspaces as unknown as WorkspacesRepo,
    getWorkspace,
    getProject,
    settings: settings as unknown as SettingsService,
    diff: diff as unknown as DiffService,
    sleep,
  });

  return {
    workflow,
    git,
    checks,
    workspaces,
    integrations,
    settings,
    diff,
    octokit,
    sleep,
    workspace,
    project,
    getWorkspace,
    getProject,
  };
}

/** Queue the branch lookup `openPr()` performs before creating a new PR. */
function mockNoExistingPr(octokit: ReturnType<typeof fakeOctokit>): void {
  octokit.request.mockResolvedValueOnce(ok([]));
}

// ---------------------------------------------------------------------------
// openPr
// ---------------------------------------------------------------------------

describe('PrWorkflow.openPr', () => {
  it('commits when dirty, pushes ONLY the branch, creates the PR, and persists prNumber', async () => {
    const { workflow, git, octokit, workspaces, workspace } = setup();
    git.status.mockResolvedValueOnce({
      branch: workspace.branch,
      files: [{ path: 'a.ts', status: 'modified', staged: false }],
      clean: false,
      ahead: 0,
      behind: 0,
    });
    git.commit.mockResolvedValueOnce({ sha: 'c0ffee' });
    git.hasUpstream.mockResolvedValueOnce(false);
    git.push.mockResolvedValueOnce(undefined);
    mockNoExistingPr(octokit);
    octokit.request.mockResolvedValueOnce(ok(restPull({ number: 77 })));

    const pr = await workflow.openPr(workspace.id, {
      title: 'My PR',
      body: 'Body',
    });

    expect(git.commit).toHaveBeenCalledWith(
      workspace.worktreePath,
      `WIP: ${workspace.branch}`,
    );

    // Branch-only publish: exactly one push call, with the exact args recorded —
    // never a 5th "--all"/"--tags"/"--mirror" flag smuggled in anywhere.
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith(
      workspace.worktreePath,
      'origin',
      workspace.branch,
      { setUpstream: true },
    );
    const recordedPushArgs = JSON.stringify(git.push.mock.calls[0]);
    expect(recordedPushArgs).not.toMatch(/--all|--tags|--mirror/);

    const [route, params] = octokit.request.mock.calls[1];
    expect(route).toBe('POST /repos/{owner}/{repo}/pulls');
    expect(params).toMatchObject({
      head: workspace.branch,
      title: 'My PR',
      body: 'Body',
      draft: false,
    });

    expect(pr.number).toBe(77);
    expect(workspaces.update).toHaveBeenCalledWith(workspace.id, {
      prNumber: 77,
    });
  });

  it('does not call git.commit on an already-clean tree, but still pushes + opens the PR', async () => {
    const { workflow, git, octokit, workspace } = setup();
    git.status.mockResolvedValueOnce({
      branch: workspace.branch,
      files: [],
      clean: true,
      ahead: 0,
      behind: 0,
    });
    git.hasUpstream.mockResolvedValueOnce(true); // already tracked -> no -u
    git.push.mockResolvedValueOnce(undefined);
    mockNoExistingPr(octokit);
    octokit.request.mockResolvedValueOnce(ok(restPull({ number: 1 })));

    await workflow.openPr(workspace.id, { title: 'T', body: 'B' });

    expect(git.commit).not.toHaveBeenCalled();
    expect(git.push).toHaveBeenCalledWith(
      workspace.worktreePath,
      'origin',
      workspace.branch,
      { setUpstream: false },
    );
  });

  it('tolerates git.commit throwing the typed "nothing to commit" race and still proceeds', async () => {
    const { workflow, git, octokit, workspace } = setup();
    git.status.mockResolvedValueOnce({
      branch: workspace.branch,
      files: [{ path: 'a.ts', status: 'modified', staged: false }],
      clean: false,
      ahead: 0,
      behind: 0,
    });
    git.commit.mockRejectedValueOnce(
      new AppError('git', 'nothing to commit (working tree clean)'),
    );
    git.hasUpstream.mockResolvedValueOnce(false);
    git.push.mockResolvedValueOnce(undefined);
    mockNoExistingPr(octokit);
    octokit.request.mockResolvedValueOnce(ok(restPull({ number: 2 })));

    const pr = await workflow.openPr(workspace.id, { title: 'T', body: 'B' });

    expect(pr.number).toBe(2);
    expect(git.push).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-"nothing to commit" git.commit failure rather than swallowing it', async () => {
    const { workflow, git, workspace } = setup();
    git.status.mockResolvedValueOnce({
      branch: workspace.branch,
      files: [{ path: 'a.ts', status: 'modified', staged: false }],
      clean: false,
      ahead: 0,
      behind: 0,
    });
    git.commit.mockRejectedValueOnce(
      new AppError('git', 'some other git failure'),
    );

    await expect(
      workflow.openPr(workspace.id, { title: 'T', body: 'B' }),
    ).rejects.toThrow('some other git failure');
  });

  it('passes an explicit draft/title/body through to createPr verbatim', async () => {
    const { workflow, git, octokit, workspace } = setup();
    git.status.mockResolvedValueOnce({
      branch: workspace.branch,
      files: [],
      clean: true,
      ahead: 0,
      behind: 0,
    });
    git.hasUpstream.mockResolvedValueOnce(true);
    git.push.mockResolvedValueOnce(undefined);
    mockNoExistingPr(octokit);
    octokit.request.mockResolvedValueOnce(
      ok(restPull({ number: 9, draft: true })),
    );

    await workflow.openPr(workspace.id, {
      draft: true,
      title: 'Exact Title',
      body: 'Exact Body',
    });

    const [, params] = octokit.request.mock.calls[1];
    expect(params).toMatchObject({
      draft: true,
      title: 'Exact Title',
      body: 'Exact Body',
    });
  });

  it('returns an existing open PR for the branch after publishing, without creating a duplicate', async () => {
    const { workflow, git, octokit, workspaces, workspace } = setup();
    git.status.mockResolvedValueOnce({
      branch: workspace.branch,
      files: [],
      clean: true,
      ahead: 0,
      behind: 0,
    });
    git.hasUpstream.mockResolvedValueOnce(true);
    git.push.mockResolvedValueOnce(undefined);
    octokit.request.mockResolvedValueOnce(ok([restPull({ number: 55 })]));

    const pr = await workflow.openPr(workspace.id, {
      title: 'Ignored title',
      body: 'Ignored body',
    });

    expect(pr.number).toBe(55);
    expect(octokit.request).toHaveBeenCalledTimes(1);
    const [route, params] = octokit.request.mock.calls[0];
    expect(route).toBe('GET /repos/{owner}/{repo}/pulls');
    expect(params).toMatchObject({
      head: `acme:${workspace.branch}`,
      state: 'open',
    });
    expect(workspaces.update).toHaveBeenCalledWith(workspace.id, {
      prNumber: 55,
    });
  });

  it('derives a non-empty fallback title/body (folding the diff summary) when omitted', async () => {
    const { workflow, git, octokit, diff, workspace } = setup();
    git.status.mockResolvedValueOnce({
      branch: workspace.branch,
      files: [],
      clean: true,
      ahead: 0,
      behind: 0,
    });
    git.hasUpstream.mockResolvedValueOnce(true);
    git.push.mockResolvedValueOnce(undefined);
    mockNoExistingPr(octokit);
    diff.getDiff.mockResolvedValueOnce({
      baseRef: 'main',
      headRef: 'HEAD',
      files: [
        {
          path: 'x.ts',
          oldPath: null,
          change: 'modified',
          additions: 3,
          deletions: 1,
        },
      ],
      patch: '',
    });
    octokit.request.mockResolvedValueOnce(ok(restPull({ number: 10 })));

    await workflow.openPr(workspace.id, {});

    const [, params] = octokit.request.mock.calls[1] as [
      string,
      { title: string; body: string; draft: boolean },
    ];
    expect(params.draft).toBe(false);
    expect(params.title.length).toBeGreaterThan(0);
    expect(params.body.length).toBeGreaterThan(0);
    expect(params.body).toContain('x.ts');
  });
});

// ---------------------------------------------------------------------------
// merge — the server-side gate (heightened scrutiny)
// ---------------------------------------------------------------------------

describe('PrWorkflow.merge — server-side gate', () => {
  it('refuses when checks.state is not green, even if GitHub reports mergeableState clean, and never touches the merge API', async () => {
    const { workflow, checks, integrations, octokit, workspace } = setup({
      workspace: { prNumber: 42 },
    });
    checks.refresh.mockResolvedValue({
      workspaceId: workspace.id,
      state: 'blocked',
      items: [],
      updatedAt: Date.now(),
    });
    // Even if GitHub itself would happily report the PR mergeable, the gate must
    // reject before ever asking — assert this by making sure octokit is never hit.
    octokit.request.mockResolvedValue(
      ok(restPull({ number: 42, mergeable_state: 'clean' })),
    );

    await expect(workflow.merge(workspace.id)).rejects.toThrow(AppError);

    try {
      await workflow.merge(workspace.id);
      expect.fail('expected merge() to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('integration');
    }

    expect(integrations.github).not.toHaveBeenCalled();
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it('refuses when any check item is severity "blocker", even if the roll-up state itself says green', async () => {
    const { workflow, checks, integrations, workspace } = setup({
      workspace: { prNumber: 42 },
    });
    const blockerItem: CheckItem = {
      source: 'review',
      label: '1 unresolved review comment',
      severity: 'blocker',
    };
    checks.refresh.mockResolvedValue({
      workspaceId: workspace.id,
      state: 'green', // adversarial/inconsistent input on purpose
      items: [blockerItem],
      updatedAt: Date.now(),
    });

    await expect(workflow.merge(workspace.id)).rejects.toThrow(AppError);
    expect(integrations.github).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// merge — happy path
// ---------------------------------------------------------------------------

describe('PrWorkflow.merge — happy path', () => {
  it('polls mergeableState via the injected sleep until clean, then merges with the settings-configured strategy', async () => {
    const { workflow, checks, octokit, sleep, workspace } = setup({
      workspace: { prNumber: 42 },
      settings: { git: { mergeStrategy: 'rebase' } },
    });
    checks.refresh.mockResolvedValueOnce({
      workspaceId: workspace.id,
      state: 'green',
      items: [],
      updatedAt: Date.now(),
    });
    octokit.request
      .mockResolvedValueOnce(
        ok(restPull({ number: 42, mergeable_state: 'blocked' })),
      ) // resolvePr
      .mockResolvedValueOnce(
        ok(restPull({ number: 42, mergeable_state: 'clean' })),
      ) // poll #1
      .mockResolvedValueOnce(ok({})); // PUT merge

    const result = await workflow.merge(workspace.id);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);

    const [route, params] = octokit.request.mock.calls[2];
    expect(route).toBe('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge');
    expect(params).toMatchObject({ pull_number: 42, merge_method: 'rebase' });
    expect(result).toEqual({ archiveSuggested: true });
  });

  it('uses an explicit method over the settings default, and skips polling when already clean', async () => {
    const { workflow, checks, octokit, sleep, workspace } = setup({
      workspace: { prNumber: 7 },
      settings: { git: { mergeStrategy: 'squash' } },
    });
    checks.refresh.mockResolvedValueOnce({
      workspaceId: workspace.id,
      state: 'green',
      items: [],
      updatedAt: Date.now(),
    });
    octokit.request
      .mockResolvedValueOnce(
        ok(restPull({ number: 7, mergeable_state: 'clean' })),
      )
      .mockResolvedValueOnce(ok({}));

    await workflow.merge(workspace.id, 'merge');

    expect(sleep).not.toHaveBeenCalled();
    const [, params] = octokit.request.mock.calls[1];
    expect(params).toMatchObject({ pull_number: 7, merge_method: 'merge' });
  });
});

// ---------------------------------------------------------------------------
// fixReviews
// ---------------------------------------------------------------------------

describe('PrWorkflow.fixReviews', () => {
  it('keeps only unresolved threads as diff_comment attachments, with a non-empty prompt', async () => {
    const { workflow, octokit, workspace } = setup({
      workspace: { prNumber: 42 },
    });
    octokit.request.mockResolvedValueOnce(ok(restPull({ number: 42 })));
    octokit.graphql.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'RT_1',
                isResolved: true,
                path: 'a.ts',
                line: 1,
                comments: {
                  nodes: [{ author: { login: 'alice' }, body: 'looks good' }],
                },
              },
              {
                id: 'RT_2',
                isResolved: false,
                path: 'b.ts',
                line: 5,
                comments: {
                  nodes: [{ author: { login: 'bob' }, body: 'please fix' }],
                },
              },
            ],
          },
        },
      },
    });

    const result = await workflow.fixReviews(workspace.id);

    expect(result.prompt).toContain('42');
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      type: 'diff_comment',
      file: 'b.ts',
      lineStart: 5,
      lineEnd: 5,
    });
    // The resolved thread's comment text must not leak into the fix-turn attachments.
    expect(JSON.stringify(result.attachments)).not.toContain('looks good');
  });

  it('returns an empty, informative result when there are no unresolved threads', async () => {
    const { workflow, octokit, workspace } = setup({
      workspace: { prNumber: 42 },
    });
    octokit.request.mockResolvedValueOnce(ok(restPull({ number: 42 })));
    octokit.graphql.mockResolvedValueOnce({
      repository: { pullRequest: { reviewThreads: { nodes: [] } } },
    });

    const result = await workflow.fixReviews(workspace.id);

    expect(result.attachments).toEqual([]);
    expect(result.prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// fixChecks
// ---------------------------------------------------------------------------

describe('PrWorkflow.fixChecks', () => {
  it('attaches a TRUNCATED detail file per failing check/status', async () => {
    const { workflow, git, octokit, workspace } = setup();
    git.headInfo.mockResolvedValueOnce({
      sha: 'deadbeef',
      branch: workspace.branch,
      ahead: 0,
      behind: 0,
    });
    const hugeUrl = 'https://ci.example.com/' + 'x'.repeat(10_000);
    octokit.request
      .mockResolvedValueOnce(
        ok({
          check_runs: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              details_url: hugeUrl,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(ok({ statuses: [] }));

    const result = await workflow.fixChecks(workspace.id);

    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments[0] as Extract<
      Attachment,
      { type: 'file' }
    >;
    expect(attachment.type).toBe('file');

    const content = await readFile(attachment.path, 'utf8');
    // The raw detail (dominated by the 10k-char URL) must have been capped, not
    // written through untouched — this is the truncation guarantee under test.
    expect(content.length).toBeLessThan(hugeUrl.length);
    expect(content).toContain('[truncated');
  });

  it('returns no attachments and an informative prompt when nothing is failing', async () => {
    const { workflow, git, octokit, workspace } = setup();
    git.headInfo.mockResolvedValueOnce({
      sha: 'deadbeef',
      branch: workspace.branch,
      ahead: 0,
      behind: 0,
    });
    octokit.request
      .mockResolvedValueOnce(
        ok({
          check_runs: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'success',
              details_url: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(ok({ statuses: [] }));

    const result = await workflow.fixChecks(workspace.id);

    expect(result.attachments).toEqual([]);
    expect(result.prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolveThread
// ---------------------------------------------------------------------------

describe('PrWorkflow.resolveThread', () => {
  it('passes the threadId through to the client resolve mutation', async () => {
    const { workflow, octokit, workspace } = setup();
    octokit.graphql.mockResolvedValueOnce({
      resolveReviewThread: { thread: { id: 'RT_9' } },
    });

    await workflow.resolveThread(workspace.id, 'RT_9');

    expect(octokit.graphql).toHaveBeenCalledTimes(1);
    const [query, vars] = octokit.graphql.mock.calls[0];
    expect(query).toMatch(/resolveReviewThread/);
    expect(vars).toMatchObject({ threadId: 'RT_9' });
  });
});

// ---------------------------------------------------------------------------
// Shared resolve() error paths
// ---------------------------------------------------------------------------

describe('PrWorkflow — workspace/project resolution error paths', () => {
  it('throws not_found when the workspace does not exist', async () => {
    const { workflow } = setup();
    await expect(workflow.openPr('missing-ws')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws not_found when the project does not exist', async () => {
    const { workflow, getProject, workspace } = setup();
    getProject.mockResolvedValueOnce(null);
    await expect(workflow.openPr(workspace.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws conflict for an archived workspace with no worktree', async () => {
    const { workflow, workspace } = setup({
      workspace: { worktreePath: null, status: 'archived' },
    });
    await expect(workflow.openPr(workspace.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
