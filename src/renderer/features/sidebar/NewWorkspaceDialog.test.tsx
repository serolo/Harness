// NewWorkspaceDialog — the From-PR / From-issue tabs (Task 9). Runs under jsdom with a
// stubbed `window.api` (the ONLY main-process access point) so the real @renderer/ipc
// funnel + the real component run.
//
// Covers:
//  - From-PR tab lists PRs from `github:listPrs`; selecting one starts a
//    `workspace:create` stream with `sourceKind:'pr'` and `sourceRef` = the PR number.
//  - From-issue selecting one seeds a one-time `pendingPrompt` in the composer store.
//  - No connected account: the list invoke rejects → the inline "Connect GitHub" empty
//    state renders and can connect without crashing the dialog.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { NewWorkspaceDialog } from './NewWorkspaceDialog';
import { useComposerStore } from '@renderer/stores/composer';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import type { IssueListItem, PrListItem } from '@shared/github';
import type { LinearIssue } from '@shared/linear';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

const PROJECT_ID = 'proj-1';

const PRS: PrListItem[] = [
  {
    number: 3,
    title: 'Add search',
    url: 'https://github.com/x/y/pull/3',
    author: 'alice',
  },
  { number: 5, title: 'Fix crash', url: 'https://github.com/x/y/pull/5' },
];

const ISSUES: IssueListItem[] = [
  {
    number: 7,
    title: 'Fix the bug',
    url: 'https://github.com/x/y/issues/7',
    state: 'open',
  },
];

const LINEAR_ISSUES: LinearIssue[] = [
  {
    id: 'lin-1',
    identifier: 'ENG-123',
    title: 'Wire up the widget',
    url: 'https://linear.app/x/issue/ENG-123',
    state: 'In Progress',
  },
];

const BRANCHES = ['main', 'origin/main', 'origin/release'];

/**
 * Install a stubbed window.api. `invoke` dispatches on channel; `prReject`/`issueReject`
 * make the corresponding list fetch reject (to exercise the no-account empty state).
 * `stream` records its calls and, on `workspace:create`, synchronously emits a terminal
 * `created` frame carrying `createdId`.
 */
function installApi(opts?: {
  prReject?: boolean;
  issueReject?: boolean;
  linearReject?: boolean;
  githubCliAuthenticated?: boolean;
  createdId?: string;
}): ApiStub {
  const createdId = opts?.createdId ?? 'ws-new';
  // GitHub starts unconnected iff either GitHub list should reject; a successful
  // `github:connect` flips this so the subsequent list reload resolves.
  let githubConnected = !opts?.prReject && !opts?.issueReject;
  const githubCliAuthenticated = opts?.githubCliAuthenticated ?? false;
  // Linear starts unconnected iff `linearReject`; a successful `linear:connect` flips this
  // so the subsequent `linear:listIssues` (triggered by the reload) resolves.
  let linearConnected = !opts?.linearReject;

  const invoke = vi.fn((channel: string) => {
    if (channel === 'project:listBranches') {
      return Promise.resolve({ defaultBranch: 'main', branches: BRANCHES });
    }
    if (channel === 'github:accounts') {
      return Promise.resolve(
        githubConnected ? [{ id: 'gh-1', login: 'octo', kind: 'github' }] : [],
      );
    }
    if (channel === 'github:cliStatus') {
      return Promise.resolve({
        available: true,
        authenticated: githubCliAuthenticated,
        login: githubCliAuthenticated ? 'octo' : undefined,
      });
    }
    if (channel === 'github:connectGhCli') {
      if (!githubCliAuthenticated) {
        return Promise.reject(new Error('GitHub CLI is not authenticated'));
      }
      githubConnected = true;
      return Promise.resolve({ id: 'gh-1', login: 'octo', kind: 'github' });
    }
    if (channel === 'github:listPrs') {
      return !githubConnected
        ? Promise.reject(new Error('no GitHub account'))
        : Promise.resolve(PRS);
    }
    if (channel === 'github:listIssues') {
      return !githubConnected
        ? Promise.reject(new Error('no GitHub account'))
        : Promise.resolve(ISSUES);
    }
    if (channel === 'linear:listIssues') {
      return linearConnected
        ? Promise.resolve(LINEAR_ISSUES)
        : Promise.reject(new Error('no Linear account connected'));
    }
    return Promise.resolve(undefined);
  });

  const on = vi.fn(() => () => {});

  const stream = vi.fn(
    (
      channel: string,
      _arg: unknown,
      onChunk: (chunk: unknown) => void,
    ): Promise<void> => {
      if (channel === 'workspace:create') {
        onChunk({
          kind: 'created',
          workspace: { id: createdId, projectId: PROJECT_ID },
        });
      }
      if (channel === 'github:connect') {
        // Simulate a successful PAT connect: flip the flag then emit the terminal frame.
        githubConnected = true;
        onChunk({
          kind: 'connected',
          account: { id: 'gh-1', login: 'octo' },
        });
      }
      if (channel === 'linear:connect') {
        // Simulate a successful API-key connect: flip the flag then emit the terminal frame.
        linearConnected = true;
        onChunk({
          kind: 'connected',
          account: { id: 'int-1', label: 'Alice', kind: 'linear' },
        });
      }
      return Promise.resolve();
    },
  );

  const api: ApiStub = { invoke, on, stream };
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

function resetStores(): void {
  useComposerStore.setState({ pendingPromptByWorkspace: {} });
  useWorkspacesStore.setState({ selectedWorkspaceId: null });
}

beforeEach(() => {
  resetStores();
  // jsdom has no layout engine — SetupLogPanel calls scrollIntoView once streaming
  // starts, so provide a no-op to keep the effect from throwing.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
  resetStores();
});

describe('NewWorkspaceDialog — Branch tab', () => {
  it('loads fetched branches into the base branch select and creates from the selected branch', async () => {
    const api = installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('base-branch-select')).toHaveValue('main');
    });
    expect(api.invoke).toHaveBeenCalledWith('project:listBranches', {
      projectId: PROJECT_ID,
    });

    fireEvent.change(screen.getByTestId('base-branch-select'), {
      target: { value: 'origin/release' },
    });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(api.stream).toHaveBeenCalled();
    });
    const call = api.stream.mock.calls.find((c) => c[0] === 'workspace:create');
    expect(call).toBeDefined();
    const arg = call?.[1] as { sourceKind?: string; baseBranch?: string };
    expect(arg.sourceKind).toBe('branch');
    expect(arg.baseBranch).toBe('origin/release');
  });
});

describe('NewWorkspaceDialog — From PR tab', () => {
  it('lists PRs and creates a workspace with sourceKind "pr" on select', async () => {
    const api = installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('source-tab-pr'));

    // The PR list loads from github:listPrs.
    await waitFor(() => {
      expect(screen.getAllByTestId('pr-item').length).toBe(PRS.length);
    });
    expect(api.invoke).toHaveBeenCalledWith('github:listPrs', {
      projectId: PROJECT_ID,
    });

    // Select the first PR → a workspace:create stream tagged sourceKind:'pr'.
    const first = screen
      .getAllByTestId('pr-item')
      .find((el) => el.getAttribute('data-pr-number') === '3');
    fireEvent.click(first as HTMLElement);

    await waitFor(() => {
      expect(api.stream).toHaveBeenCalled();
    });
    const call = api.stream.mock.calls.find((c) => c[0] === 'workspace:create');
    expect(call).toBeDefined();
    const arg = call?.[1] as { sourceKind?: string; sourceRef?: string };
    expect(arg.sourceKind).toBe('pr');
    expect(arg.sourceRef).toBe('3');
  });
});

describe('NewWorkspaceDialog — From issue tab', () => {
  it('seeds a one-time pendingPrompt for the created workspace', async () => {
    installApi({ createdId: 'ws-issue' });
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('source-tab-issue'));

    await waitFor(() => {
      expect(screen.getAllByTestId('issue-item').length).toBe(ISSUES.length);
    });

    fireEvent.click(screen.getByTestId('issue-item'));

    // The composer store now holds the issue text keyed on the new workspace id.
    await waitFor(() => {
      const pending =
        useComposerStore.getState().pendingPromptByWorkspace['ws-issue'];
      expect(pending).toBeDefined();
    });
    const taken = useComposerStore.getState().takePendingPrompt('ws-issue');
    expect(taken).toContain('Fix the bug');
    expect(taken).toContain('https://github.com/x/y/issues/7');
    // Consumed once → a second read is undefined.
    expect(
      useComposerStore.getState().takePendingPrompt('ws-issue'),
    ).toBeUndefined();
  });
});

describe('NewWorkspaceDialog — no connected account', () => {
  it('renders the Connect GitHub empty state and reloads PRs after connecting', async () => {
    installApi({ prReject: true });
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('source-tab-pr'));

    await waitFor(() => {
      expect(screen.getByTestId('github-empty')).toBeInTheDocument();
    });
    // The dialog itself is still mounted (did not crash).
    expect(screen.getByTestId('new-workspace-dialog')).toBeInTheDocument();
    expect(screen.queryAllByTestId('pr-item').length).toBe(0);

    fireEvent.change(screen.getByTestId('github-token-input'), {
      target: { value: 'github_pat_secret123' },
    });
    fireEvent.click(screen.getByTestId('github-connect-submit'));

    await waitFor(() => {
      expect(screen.getAllByTestId('pr-item').length).toBe(PRS.length);
    });
  });

  it('uses an authenticated GitHub CLI session from global settings before listing PRs', async () => {
    const api = installApi({
      prReject: true,
      githubCliAuthenticated: true,
    });
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('source-tab-pr'));

    await waitFor(() => {
      expect(screen.getAllByTestId('pr-item').length).toBe(PRS.length);
    });
    expect(api.invoke).toHaveBeenCalledWith('github:cliStatus', undefined);
    expect(api.invoke).toHaveBeenCalledWith('github:connectGhCli', undefined);
  });
});

describe('NewWorkspaceDialog — From Linear tab', () => {
  it('lists Linear issues and seeds a branch workspace + pendingPrompt on select', async () => {
    const api = installApi({ createdId: 'ws-linear' });
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('source-tab-linear'));

    await waitFor(() => {
      expect(screen.getAllByTestId('linear-issue-item').length).toBe(
        LINEAR_ISSUES.length,
      );
    });
    expect(api.invoke).toHaveBeenCalledWith('linear:listIssues', {});

    fireEvent.click(screen.getByTestId('linear-issue-item'));

    // A branch workspace (Linear issues are not a git ref), not a tagged source.
    await waitFor(() => {
      expect(api.stream).toHaveBeenCalled();
    });
    const call = api.stream.mock.calls.find((c) => c[0] === 'workspace:create');
    const arg = call?.[1] as { sourceKind?: string };
    expect(arg.sourceKind).toBe('branch');

    // The composer store holds the Linear issue text keyed on the new workspace id.
    await waitFor(() => {
      expect(
        useComposerStore.getState().pendingPromptByWorkspace['ws-linear'],
      ).toBeDefined();
    });
    const taken = useComposerStore.getState().takePendingPrompt('ws-linear');
    expect(taken).toContain('ENG-123');
    expect(taken).toContain('Wire up the widget');
    expect(taken).toContain('https://linear.app/x/issue/ENG-123');
  });

  it('shows the inline connect affordance and reloads issues after connecting', async () => {
    const api = installApi({ linearReject: true });
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('source-tab-linear'));

    // No account → the API-key connect affordance renders (not a crash).
    await waitFor(() => {
      expect(screen.getByTestId('linear-connect')).toBeInTheDocument();
    });
    expect(screen.queryAllByTestId('linear-issue-item').length).toBe(0);

    // Paste a key + Connect → drives linear:connect, then the list reloads with issues.
    fireEvent.change(screen.getByTestId('linear-token-input'), {
      target: { value: 'lin_api_secret123' },
    });
    fireEvent.click(screen.getByTestId('linear-connect-submit'));

    await waitFor(() => {
      expect(screen.getAllByTestId('linear-issue-item').length).toBe(
        LINEAR_ISSUES.length,
      );
    });
    const connectCall = api.stream.mock.calls.find(
      (c) => c[0] === 'linear:connect',
    );
    expect(connectCall).toBeDefined();
    expect(connectCall?.[1]).toEqual({
      mode: 'apiKey',
      token: 'lin_api_secret123',
    });
  });
});
