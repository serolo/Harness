// ChecksService tests (Phase 5, Task 6) — written independently of the implementation,
// from the spec in `src/main/checks/index.ts`'s own header comments + the shared
// `ChecksResult`/`CheckItem` contract in `@shared/checks`. Heightened scrutiny: this
// service degrades a whole group of GitHub-dependent signals on ANY failure (no
// account, non-github origin, client error) without throwing out of `refresh`/`get`.
//
// NO live network / real git: `GitService` is faked down to the three methods
// `ChecksService` actually calls (`headInfo`/`status`/`hasUpstream`); GitHub is driven
// via a fake Octokit (`{ request, graphql }`, shaped like
// `src/main/integrations/github/client.test.ts`) routed by REST route string / GraphQL
// so call ORDER inside `Promise.all` groups never matters to the test.

import { describe, it, expect, vi } from 'vitest';

import { ChecksService, type ChecksServiceDeps } from './index';
import type { GitService, GitStatus, HeadInfo } from '../git';
import type { IntegrationService } from '../integrations';
import type { TodosRepo } from '../db/repos/todos';
import type { Project, Workspace } from '@shared/models';
import type { Todo } from '@shared/harness';
import type { EventChannel, EventPayload } from '@shared/ipc';
import type { CheckItem, ChecksResult } from '@shared/checks';

// ---------------------------------------------------------------------------
// Fixtures / fakes
// ---------------------------------------------------------------------------

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    projectId: 'proj-1',
    name: 'atlantis',
    branch: 'feature-x',
    baseBranch: 'main',
    worktreePath: '/tmp/harness-wt/atlantis',
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

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'demo',
    originUrl: 'https://github.com/o/r.git',
    defaultBranch: 'main',
    repoPath: '/tmp/harness-repo',
    createdAt: Date.now(),
    ...overrides,
  };
}

/** A fake GitService exposing only the three methods ChecksService actually calls. */
function fakeGit(
  overrides: {
    headInfo?: (wt: string, baseRef?: string) => Promise<HeadInfo>;
    status?: (wt: string) => Promise<GitStatus>;
    hasUpstream?: (wt: string) => Promise<boolean>;
  } = {},
): GitService {
  const headInfo =
    overrides.headInfo ??
    (async () => ({
      sha: 'headsha1',
      branch: 'feature-x',
      ahead: 0,
      behind: 0,
    }));
  const status =
    overrides.status ??
    (async () => ({
      branch: 'feature-x',
      files: [],
      clean: true,
      ahead: 0,
      behind: 0,
    }));
  const hasUpstream = overrides.hasUpstream ?? (async () => true);
  return { headInfo, status, hasUpstream } as unknown as GitService;
}

/** A successful Octokit REST response shape (mirrors client.test.ts's `ok`). */
function ok<T>(data: T): {
  data: T;
  status: number;
  headers: Record<string, string>;
} {
  return { data, status: 200, headers: {} };
}

interface FakeGithubConfig {
  /** REST pull payload shared by both getPr (list) and getPrByNumber (detail); null → no PR. */
  pr?: {
    number: number;
    html_url: string;
    title: string;
    draft?: boolean;
    mergeable_state?: string;
  } | null;
  checkRuns?: {
    name: string;
    status: string;
    conclusion: string | null;
    details_url: string | null;
  }[];
  statuses?: { context: string; state: string; target_url: string | null }[];
  deployments?: { id: number; environment: string; sha: string }[];
  deploymentStatuses?: { state: string; environment_url: string | null }[];
  reviewThreads?: {
    id: string;
    isResolved: boolean;
    path?: string | null;
    line?: number | null;
  }[];
}

/**
 * A fake Octokit that routes on the REST route string / presence of `pull_number`
 * rather than call order — the real client fires `listCheckRuns`+`listStatuses` (and
 * `listDeployments`+per-deployment `listDeploymentStatuses`) concurrently, so a
 * queue-based `mockResolvedValueOnce` chain would be order-fragile.
 */
function fakeOctokit(config: FakeGithubConfig = {}): {
  request: ReturnType<typeof vi.fn>;
  graphql: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(
    async (route: string, params?: Record<string, unknown>) => {
      if (
        route === 'GET /repos/{owner}/{repo}/pulls' &&
        params?.pull_number === undefined
      ) {
        return ok(config.pr ? [config.pr] : []);
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        if (config.pr === null || config.pr === undefined) {
          throw new Error('no PR configured for getPrByNumber');
        }
        return ok(config.pr);
      }
      if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') {
        return ok({ check_runs: config.checkRuns ?? [] });
      }
      if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/status') {
        return ok({ statuses: config.statuses ?? [] });
      }
      if (route === 'GET /repos/{owner}/{repo}/deployments') {
        return ok(config.deployments ?? []);
      }
      if (
        route ===
        'GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses'
      ) {
        return ok(config.deploymentStatuses ?? []);
      }
      throw new Error(`fakeOctokit: unexpected route ${route}`);
    },
  );

  const graphql = vi.fn(async () => ({
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: (config.reviewThreads ?? []).map((t) => ({
            id: t.id,
            isResolved: t.isResolved,
            path: t.path ?? null,
            line: t.line ?? null,
            comments: { nodes: [] },
          })),
        },
      },
    },
  }));

  return { request, graphql };
}

/** Build a ChecksService with sensible defaults; each dep individually overridable. */
function makeService(
  opts: {
    workspace?: Workspace | null;
    project?: Project | null;
    git?: GitService;
    githubOctokit?: () => Promise<unknown>;
    todos?: Todo[];
    setNeedsAttention?: ChecksServiceDeps['setNeedsAttention'];
  } = {},
): { service: ChecksService; emit: ReturnType<typeof vi.fn> } {
  const workspace =
    opts.workspace === undefined ? makeWorkspace() : opts.workspace;
  const project = opts.project === undefined ? makeProject() : opts.project;
  const emit = vi.fn();

  const integrations = {
    github:
      opts.githubOctokit ??
      (async () => {
        throw new Error('no GitHub account connected');
      }),
  } as unknown as IntegrationService;

  const todos = {
    list: vi.fn(async () => opts.todos ?? []),
  } as unknown as TodosRepo;

  const deps: ChecksServiceDeps = {
    git: opts.git ?? fakeGit(),
    getWorkspace: async () => workspace,
    getProject: async () => project,
    integrations,
    todos,
    emit: emit as <K extends EventChannel>(
      event: K,
      payload: EventPayload<K>,
    ) => void,
    setNeedsAttention: opts.setNeedsAttention,
  };

  return { service: new ChecksService(deps), emit };
}

function itemFor(result: ChecksResult, source: CheckItem['source']): CheckItem {
  const item = result.items.find((i) => i.source === source);
  if (item === undefined) {
    throw new Error(`no ${source} item in result`);
  }
  return item;
}

// ---------------------------------------------------------------------------
// 1. Git-only degrade path (no GitHub account / client error)
// ---------------------------------------------------------------------------

describe('ChecksService — GitHub degrade path', () => {
  it('refresh still returns a valid result with git + todos when integrations.github() rejects (no account)', async () => {
    const { service, emit } = makeService({
      githubOctokit: async () => {
        throw new Error('no GitHub account connected');
      },
    });

    const result = await service.refresh('ws-1');

    expect(result.workspaceId).toBe('ws-1');
    const sources = result.items.map((i) => i.source);
    expect(sources).toContain('git');
    expect(sources).toContain('todos');
    expect(sources).not.toContain('pr');
    expect(sources).not.toContain('ci');
    expect(sources).not.toContain('deployment');
    expect(sources).not.toContain('review');
    // state computed purely from git+todos (both ok here) -> green
    expect(result.state).toBe('green');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('degrades the whole GitHub group when the project has a non-github origin', async () => {
    const { service } = makeService({
      project: makeProject({ originUrl: 'https://gitlab.com/o/r.git' }),
      githubOctokit: async () => fakeOctokit({ pr: null }),
    });

    const result = await service.refresh('ws-1');
    const sources = result.items.map((i) => i.source);
    expect(sources).toEqual(['git', 'todos']);
  });

  it('degrades the whole GitHub group when the project has no origin configured', async () => {
    const { service } = makeService({
      project: makeProject({ originUrl: '' }),
    });

    const result = await service.refresh('ws-1');
    const sources = result.items.map((i) => i.source);
    expect(sources).toEqual(['git', 'todos']);
  });

  it('degrades when the GithubClient call throws mid-way (e.g. CI lookup failure)', async () => {
    const octokit = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /repos/{owner}/{repo}/pulls') {
          return ok([]); // getPr(branch) -> no PR
        }
        throw new Error('GitHub API 500');
      }),
      graphql: vi.fn(),
    };
    const { service } = makeService({
      githubOctokit: async () => octokit,
    });

    const result = await service.refresh('ws-1');
    const sources = result.items.map((i) => i.source);
    expect(sources).toEqual(['git', 'todos']);
  });
});

// ---------------------------------------------------------------------------
// 2. Git signal — uncommitted / unpushed
// ---------------------------------------------------------------------------

describe('ChecksService — git signal', () => {
  it('reports pending + "Commit & push" with correct details when there are uncommitted changes', async () => {
    const git = fakeGit({
      status: async () => ({
        branch: 'feature-x',
        files: [
          { path: 'a.ts', status: 'modified', staged: false },
          { path: 'b.ts', status: 'added', staged: true },
        ],
        clean: false,
        ahead: 0,
        behind: 0,
      }),
      hasUpstream: async () => true,
    });
    const { service } = makeService({ git });

    const result = await service.refresh('ws-1');
    const gitItem = itemFor(result, 'git');

    expect(gitItem.severity).toBe('pending');
    expect(gitItem.suggestedAction).toBe('Commit & push');
    expect(gitItem.label).toBe('2 uncommitted changes');
    expect(gitItem.details).toEqual({
      source: 'git',
      ahead: 0,
      behind: 0,
      uncommitted: 2,
      unpushed: false,
    });
  });

  it('reports pending + "Commit & push" + unpushed=true when the branch has no upstream', async () => {
    const git = fakeGit({ hasUpstream: async () => false });
    const { service } = makeService({ git });

    const result = await service.refresh('ws-1');
    const gitItem = itemFor(result, 'git');

    expect(gitItem.severity).toBe('pending');
    expect(gitItem.suggestedAction).toBe('Commit & push');
    expect(gitItem.label).toBe('Unpushed commits');
    expect(gitItem.details).toMatchObject({ unpushed: true, uncommitted: 0 });
  });

  it('reports ok "Up to date with base" when clean, pushed, and not behind', async () => {
    const { service } = makeService();

    const result = await service.refresh('ws-1');
    const gitItem = itemFor(result, 'git');

    expect(gitItem.severity).toBe('ok');
    expect(gitItem.suggestedAction).toBeUndefined();
    expect(gitItem.label).toBe('Up to date with base');
  });

  it('single uncommitted file uses singular label ("1 uncommitted change")', async () => {
    const git = fakeGit({
      status: async () => ({
        branch: 'feature-x',
        files: [{ path: 'a.ts', status: 'modified', staged: false }],
        clean: false,
        ahead: 0,
        behind: 0,
      }),
    });
    const { service } = makeService({ git });

    const result = await service.refresh('ws-1');
    expect(itemFor(result, 'git').label).toBe('1 uncommitted change');
  });
});

// ---------------------------------------------------------------------------
// 3. PR signal — no PR vs PR present
// ---------------------------------------------------------------------------

describe('ChecksService — pr signal', () => {
  it('reports pending "Create PR" when no PR exists for the branch', async () => {
    const { service } = makeService({
      githubOctokit: async () => fakeOctokit({ pr: null }),
    });

    const result = await service.refresh('ws-1');
    const prItem = itemFor(result, 'pr');

    expect(prItem.severity).toBe('pending');
    expect(prItem.suggestedAction).toBe('Create PR');
    expect(prItem.label).toBe('No PR');
  });

  it('reports ok with the PR number/title when a PR exists (looked up by branch)', async () => {
    const { service } = makeService({
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 42,
            html_url: 'https://github.com/o/r/pull/42',
            title: 'Add feature',
            draft: false,
            mergeable_state: 'clean',
          },
        }),
    });

    const result = await service.refresh('ws-1');
    const prItem = itemFor(result, 'pr');

    expect(prItem.severity).toBe('ok');
    expect(prItem.label).toBe('PR #42');
    expect(prItem.details).toMatchObject({
      source: 'pr',
      number: 42,
      title: 'Add feature',
      mergeableState: 'clean',
    });
  });

  it('looks up the PR by its recorded number (getPrByNumber) when workspace.prNumber is set, and labels a draft PR', async () => {
    const { service } = makeService({
      workspace: makeWorkspace({ prNumber: 7 }),
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 7,
            html_url: 'https://github.com/o/r/pull/7',
            title: 'WIP',
            draft: true,
            mergeable_state: 'unknown',
          },
        }),
    });

    const result = await service.refresh('ws-1');
    const prItem = itemFor(result, 'pr');

    expect(prItem.label).toBe('PR #7 (draft)');
    expect(prItem.severity).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 4. CI signal — failing -> blocker + state 'blocked' + setNeedsAttention
// ---------------------------------------------------------------------------

describe('ChecksService — ci signal + needs-attention hook', () => {
  it('marks CI a blocker, sets overall state to blocked, and fires setNeedsAttention with the workspaceId on a failing check-run', async () => {
    const setNeedsAttention = vi.fn();
    const { service } = makeService({
      workspace: makeWorkspace({ prNumber: 1 }),
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 1,
            html_url: 'https://github.com/o/r/pull/1',
            title: 'x',
            mergeable_state: 'clean',
          },
          checkRuns: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'success',
              details_url: null,
            },
            {
              name: 'test',
              status: 'completed',
              conclusion: 'failure',
              details_url: 'https://ci/1',
            },
          ],
        }),
      setNeedsAttention,
    });

    const result = await service.refresh('ws-1');
    const ciItem = itemFor(result, 'ci');

    expect(ciItem.severity).toBe('blocker');
    expect(ciItem.label).toBe('CI: 1 failing');
    expect(result.state).toBe('blocked');

    // setNeedsAttention is fire-and-forget; flush microtasks before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(setNeedsAttention).toHaveBeenCalledWith('ws-1', expect.any(String));
  });

  it('does NOT fire setNeedsAttention when CI is passing or pending', async () => {
    const setNeedsAttention = vi.fn();
    const { service } = makeService({
      workspace: makeWorkspace({ prNumber: 1 }),
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 1,
            html_url: 'https://github.com/o/r/pull/1',
            title: 'x',
            mergeable_state: 'clean',
          },
          checkRuns: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'success',
              details_url: null,
            },
          ],
        }),
      setNeedsAttention,
    });

    await service.refresh('ws-1');
    await Promise.resolve();
    expect(setNeedsAttention).not.toHaveBeenCalled();
  });

  it('reports CI pending (not blocked) when a check-run is still in progress', async () => {
    const { service } = makeService({
      workspace: makeWorkspace({ prNumber: 1 }),
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 1,
            html_url: 'https://github.com/o/r/pull/1',
            title: 'x',
            mergeable_state: 'clean',
          },
          checkRuns: [
            {
              name: 'build',
              status: 'in_progress',
              conclusion: null,
              details_url: null,
            },
          ],
        }),
    });

    const result = await service.refresh('ws-1');
    const ciItem = itemFor(result, 'ci');
    expect(ciItem.severity).toBe('pending');
    expect(result.state).toBe('pending');
  });

  it('reports "No CI" ok when there is no pushed head sha (unborn branch)', async () => {
    const git = fakeGit({
      headInfo: async () => {
        throw new Error('unknown revision origin/main');
      },
    });
    const { service } = makeService({
      git,
      githubOctokit: async () => fakeOctokit({ pr: null }),
    });

    const result = await service.refresh('ws-1');
    const ciItem = itemFor(result, 'ci');
    expect(ciItem.label).toBe('No CI');
    expect(ciItem.severity).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 5. Review signal — unresolved threads -> blocker
// ---------------------------------------------------------------------------

describe('ChecksService — review signal', () => {
  it('marks review a blocker + overall state blocked when there are unresolved review threads', async () => {
    const { service } = makeService({
      workspace: makeWorkspace({ prNumber: 3 }),
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 3,
            html_url: 'https://github.com/o/r/pull/3',
            title: 'x',
            mergeable_state: 'clean',
          },
          reviewThreads: [
            { id: 'RT_1', isResolved: false },
            { id: 'RT_2', isResolved: true },
          ],
        }),
    });

    const result = await service.refresh('ws-1');
    const reviewItem = itemFor(result, 'review');

    expect(reviewItem.severity).toBe('blocker');
    expect(reviewItem.label).toBe('1 unresolved review comment');
    expect(reviewItem.suggestedAction).toBe('Fix review comments');
    expect(result.state).toBe('blocked');
  });

  it('reports ok "Reviews resolved" when every thread is resolved', async () => {
    const { service } = makeService({
      workspace: makeWorkspace({ prNumber: 3 }),
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 3,
            html_url: 'https://github.com/o/r/pull/3',
            title: 'x',
            mergeable_state: 'clean',
          },
          reviewThreads: [{ id: 'RT_1', isResolved: true }],
        }),
    });

    const result = await service.refresh('ws-1');
    expect(itemFor(result, 'review').severity).toBe('ok');
  });

  it('does not fetch review threads at all when there is no PR', async () => {
    const { service } = makeService({
      githubOctokit: async () => fakeOctokit({ pr: null }),
    });

    const result = await service.refresh('ws-1');
    const sources = result.items.map((i) => i.source);
    expect(sources).not.toContain('review');
  });
});

// ---------------------------------------------------------------------------
// 6. Todos signal
// ---------------------------------------------------------------------------

describe('ChecksService — todos signal', () => {
  it('reports pending listing open todos when some are open', async () => {
    const { service } = makeService({
      todos: [
        { id: 't1', body: 'Fix typo', done: false, source: 'user' },
        { id: 't2', body: 'Done already', done: true, source: 'agent' },
        { id: 't3', body: 'Write test', done: false, source: 'agent' },
      ],
    });

    const result = await service.refresh('ws-1');
    const todosItem = itemFor(result, 'todos');

    expect(todosItem.severity).toBe('pending');
    expect(todosItem.label).toBe('2 open todos');
    expect(todosItem.suggestedAction).toBe('Complete: Fix typo; Write test');
    expect(todosItem.details).toEqual({
      source: 'todos',
      open: 2,
      items: [
        { body: 'Fix typo', done: false },
        { body: 'Done already', done: true },
        { body: 'Write test', done: false },
      ],
    });
  });

  it('reports ok "No open todos" when there are none open', async () => {
    const { service } = makeService({
      todos: [{ id: 't1', body: 'Old done thing', done: true, source: 'user' }],
    });

    const result = await service.refresh('ws-1');
    const todosItem = itemFor(result, 'todos');
    expect(todosItem.severity).toBe('ok');
    expect(todosItem.label).toBe('No open todos');
  });

  it('reports ok "No open todos" when the todo list is empty', async () => {
    const { service } = makeService({ todos: [] });
    const result = await service.refresh('ws-1');
    expect(itemFor(result, 'todos').severity).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 7. emit
// ---------------------------------------------------------------------------

describe('ChecksService — emit', () => {
  it('calls emit("checks:updated", { workspaceId, checks }) exactly once per refresh', async () => {
    const { service, emit } = makeService();

    const result = await service.refresh('ws-1');

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('checks:updated', {
      workspaceId: 'ws-1',
      checks: result,
    });
  });

  it('emits again (a second time) on a second refresh call', async () => {
    const { service, emit } = makeService();

    await service.refresh('ws-1');
    await service.refresh('ws-1');

    expect(emit).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 8. cache
// ---------------------------------------------------------------------------

describe('ChecksService — cache', () => {
  it('get() after refresh() returns the cached result WITHOUT recomputing (fakes not called again)', async () => {
    const statusSpy = vi.fn(async () => ({
      branch: 'feature-x',
      files: [],
      clean: true,
      ahead: 0,
      behind: 0,
    }));
    const git = fakeGit({ status: statusSpy });
    const { service, emit } = makeService({ git });

    const refreshed = await service.refresh('ws-1');
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);

    const cached = await service.get('ws-1');

    expect(cached).toEqual(refreshed);
    // no additional git call and no additional emit — get() served from cache.
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('get() with no prior refresh computes once (delegates to refresh)', async () => {
    const statusSpy = vi.fn(async () => ({
      branch: 'feature-x',
      files: [],
      clean: true,
      ahead: 0,
      behind: 0,
    }));
    const git = fakeGit({ status: statusSpy });
    const { service, emit } = makeService({ git });

    const result = await service.get('ws-1');

    expect(result.workspaceId).toBe('ws-1');
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('a second refresh() recomputes rather than serving the cache (cache is single-slot, overwritten)', async () => {
    const statusSpy = vi.fn(async () => ({
      branch: 'feature-x',
      files: [],
      clean: true,
      ahead: 0,
      behind: 0,
    }));
    const git = fakeGit({ status: statusSpy });
    const { service } = makeService({ git });

    await service.refresh('ws-1');
    await service.refresh('ws-1');

    expect(statusSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 9. archived / no worktree
// ---------------------------------------------------------------------------

describe('ChecksService — archived workspace (no worktree)', () => {
  it('returns a minimal valid result (todos only) without crashing when worktreePath is null', async () => {
    const { service, emit } = makeService({
      workspace: makeWorkspace({ worktreePath: null, status: 'archived' }),
      todos: [{ id: 't1', body: 'Leftover', done: false, source: 'user' }],
    });

    const result = await service.refresh('ws-1');

    expect(result.workspaceId).toBe('ws-1');
    expect(result.items.map((i) => i.source)).toEqual(['todos']);
    expect(result.state).toBe('pending'); // the one open todo
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('throws a typed not_found AppError when the workspace itself does not exist', async () => {
    const { service } = makeService({ workspace: null });

    await expect(service.refresh('missing-ws')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('ChecksService — state machine precedence (blocker > pending > green)', () => {
  it('reports state "blocked" even when other items are merely pending', async () => {
    // git pending (uncommitted) + ci blocker (failing) simultaneously.
    const git = fakeGit({
      status: async () => ({
        branch: 'feature-x',
        files: [{ path: 'a.ts', status: 'modified', staged: false }],
        clean: false,
        ahead: 0,
        behind: 0,
      }),
    });
    const { service } = makeService({
      git,
      workspace: makeWorkspace({ prNumber: 1 }),
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 1,
            html_url: 'https://github.com/o/r/pull/1',
            title: 'x',
            mergeable_state: 'clean',
          },
          checkRuns: [
            {
              name: 'test',
              status: 'completed',
              conclusion: 'failure',
              details_url: null,
            },
          ],
        }),
    });

    const result = await service.refresh('ws-1');
    expect(result.state).toBe('blocked');
  });

  it('reports state "green" only when every item is ok (never pending/blocker)', async () => {
    const { service } = makeService({
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 1,
            html_url: 'https://github.com/o/r/pull/1',
            title: 'x',
            mergeable_state: 'clean',
          },
        }),
    });

    const result = await service.refresh('ws-1');
    expect(result.items.every((i) => i.severity === 'ok')).toBe(true);
    expect(result.state).toBe('green');
  });

  it('a warning-only item (failed deployment) does NOT escalate state past green', async () => {
    const { service } = makeService({
      workspace: makeWorkspace({ prNumber: 1 }),
      githubOctokit: async () =>
        fakeOctokit({
          pr: {
            number: 1,
            html_url: 'https://github.com/o/r/pull/1',
            title: 'x',
            mergeable_state: 'clean',
          },
          deployments: [{ id: 1, environment: 'staging', sha: 'headsha1' }],
          deploymentStatuses: [{ state: 'failure', environment_url: null }],
        }),
    });

    const result = await service.refresh('ws-1');
    const deployItem = itemFor(result, 'deployment');
    expect(deployItem.severity).toBe('warning');
    expect(result.state).toBe('green');
  });
});
