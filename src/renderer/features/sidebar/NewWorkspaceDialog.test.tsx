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
import { useWorkspaceCreationStore } from '@renderer/stores/workspaceCreation';
import type { IssueListItem, PrListItem } from '@shared/github';

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

const BRANCHES = ['main', 'local-only', 'origin/main', 'origin/release'];

/**
 * Install a stubbed window.api. `invoke` dispatches on channel; `prReject`/`issueReject`
 * make the corresponding list fetch reject (to exercise the no-account empty state).
 * `stream` records its calls and, on `workspace:create`, synchronously emits a terminal
 * `created` frame carrying `createdId`.
 */
function installApi(opts?: {
  prReject?: boolean;
  issueReject?: boolean;
  githubCliAuthenticated?: boolean;
  createdId?: string;
  fetchWarning?: string;
}): ApiStub {
  const createdId = opts?.createdId ?? 'ws-new';
  // GitHub starts unconnected iff either GitHub list should reject; a successful
  // `github:connect` flips this so the subsequent list reload resolves.
  let githubConnected = !opts?.prReject && !opts?.issueReject;
  const githubCliAuthenticated = opts?.githubCliAuthenticated ?? false;

  const invoke = vi.fn((channel: string) => {
    if (channel === 'project:listBranches') {
      return Promise.resolve({
        defaultBranch: 'main',
        branches: BRANCHES,
        ...(opts?.fetchWarning ? { fetchWarning: opts.fetchWarning } : {}),
      });
    }
    if (channel === 'project:getCurrentBranch') {
      return Promise.resolve({ branch: 'feature/current-work' });
    }
    if (channel === 'workspace:suggestNames') {
      return Promise.resolve({
        workspaceName: 'paris',
        worktreeName: 'paris',
        branchName: 'paris',
      });
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
  useWorkspaceCreationStore.setState({ current: null });
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
  it('shows editable generated names without workspace/worktree naming modes', async () => {
    installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    expect(await screen.findByTestId('workspace-name-input')).toHaveValue(
      'paris',
    );
    expect(screen.getByTestId('worktree-name-input')).toHaveValue('paris');
    expect(screen.getByTestId('branch-name-input')).toHaveValue('paris');
    expect(screen.getByTestId('workspace-name-input')).toHaveClass('w-full');
    expect(screen.getByTestId('worktree-name-input')).toHaveClass('w-full');
    expect(screen.getByTestId('branch-name-input')).toHaveClass('w-full');
    expect(screen.queryByTestId('workspace-name-automatic')).toBeNull();
    expect(screen.queryByTestId('worktree-name-automatic')).toBeNull();
  });

  it('can use the selected existing branch instead of creating a new one', async () => {
    const api = installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('branch-mode-existing'));
    const release = (await screen.findAllByTestId('branch-item')).find(
      (item) => item.getAttribute('data-branch-ref') === 'origin/release',
    );
    fireEvent.click(release as HTMLElement);

    expect(screen.getByTestId('existing-branch-name')).toHaveTextContent(
      'release',
    );
    fireEvent.click(screen.getByTestId('create-workspace-submit'));

    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    expect(
      api.stream.mock.calls.find((call) => call[0] === 'workspace:create')?.[1],
    ).toMatchObject({
      baseBranch: 'origin/release',
      branch: 'release',
      sourceKind: 'branch',
    });
  });

  it('keeps the branch results area at a fixed scrollable height', async () => {
    installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    await screen.findAllByTestId('branch-item');
    expect(screen.getByTestId('branch-results')).toHaveClass(
      'h-64',
      'overflow-y-auto',
    );
    expect(screen.getByTestId('new-workspace-overlay')).toHaveClass(
      'fixed',
      'inset-0',
      'z-[100]',
    );
    expect(screen.getByTestId('new-workspace-dialog')).toHaveClass('z-[110]');
    expect(screen.getByTestId('new-workspace-dialog').parentElement).toBe(
      document.body,
    );
  });

  it('closes when clicking outside the modal panel', async () => {
    installApi();
    const onClose = vi.fn();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={onClose} />);

    const outside = screen.getByTestId('new-workspace-dialog');
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open when a text-selection drag starts inside and ends outside', async () => {
    installApi();
    const onClose = vi.fn();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={onClose} />);

    const outside = screen.getByTestId('new-workspace-dialog');
    fireEvent.pointerDown(screen.getByText('New Workspace'));
    fireEvent.pointerUp(outside);
    fireEvent.click(outside);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open when clicking inside the modal panel', async () => {
    installApi();
    const onClose = vi.fn();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={onClose} />);

    fireEvent.click(screen.getByText('New Workspace'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when pressing Cancel', async () => {
    installApi();
    const onClose = vi.fn();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps PR and issue results at the same fixed scrollable height', async () => {
    installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('source-tab-pr'));
    await screen.findAllByTestId('pr-item');
    expect(screen.getByTestId('pr-list')).toHaveClass(
      'h-64',
      'overflow-y-auto',
    );

    fireEvent.click(screen.getByTestId('source-tab-issue'));
    await screen.findAllByTestId('issue-item');
    expect(screen.getByTestId('issue-list')).toHaveClass(
      'h-64',
      'overflow-y-auto',
    );
  });

  it('keeps cached branches usable when the remote refresh fails', async () => {
    installApi({
      fetchWarning:
        'Could not refresh the remote. Showing cached local branches.',
    });
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={vi.fn()} />);

    expect(await screen.findByTestId('branch-list-warning')).toHaveTextContent(
      'Showing cached local branches',
    );
    expect(screen.getAllByTestId('branch-item')).toHaveLength(3);
    fireEvent.click(screen.getAllByTestId('branch-item')[0]);
    expect(screen.getByTestId('create-workspace-submit')).toBeEnabled();
  });

  it('closes after the workspace is created and selected', async () => {
    const api = installApi();
    const onClose = vi.fn();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={onClose} />);

    await waitFor(() =>
      expect(screen.getAllByTestId('branch-item')).not.toHaveLength(0),
    );
    fireEvent.click(screen.getAllByTestId('branch-item')[0]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('create-workspace-submit'));

    expect(onClose).toHaveBeenCalledOnce();
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-new');
    expect(api.stream).toHaveBeenCalledWith(
      'workspace:create',
      expect.objectContaining({ projectId: PROJECT_ID }),
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('shows remote branches without origin/ plus local-only branches and creates from the selected ref', async () => {
    const api = installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('branch-item').length).toBe(3);
    });
    expect(api.invoke).toHaveBeenCalledWith('project:listBranches', {
      projectId: PROJECT_ID,
    });
    const labels = screen
      .getAllByTestId('branch-item')
      .map((item) => item.textContent ?? '');
    expect(labels.some((text) => text.includes('origin/'))).toBe(false);
    expect(labels.some((text) => text.includes('main'))).toBe(true);
    expect(labels.some((text) => text.includes('release'))).toBe(true);
    expect(labels.some((text) => text.includes('local-only'))).toBe(true);

    const release = screen
      .getAllByTestId('branch-item')
      .find((el) => el.getAttribute('data-branch-ref') === 'origin/release');
    fireEvent.click(release as HTMLElement);
    expect(api.stream).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('create-workspace-submit'));

    await waitFor(() => {
      expect(api.stream).toHaveBeenCalled();
    });
    const call = api.stream.mock.calls.find((c) => c[0] === 'workspace:create');
    expect(call).toBeDefined();
    const arg = call?.[1] as {
      sourceKind?: string;
      baseBranch?: string;
      location?: string;
    };
    expect(arg.sourceKind).toBe('branch');
    expect(arg.baseBranch).toBe('origin/release');
    expect(arg.location).toBe('worktree');
  });

  it('filters branch rows by name', async () => {
    installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('branch-item').length).toBe(3);
    });

    fireEvent.change(screen.getByTestId('source-filter'), {
      target: { value: 'rel' },
    });

    expect(screen.getAllByTestId('branch-item')).toHaveLength(1);
    expect(screen.getByText('release')).toBeInTheDocument();
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });

  it('can use the current checkout without showing a harness picker', async () => {
    const api = installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    expect(screen.queryByText('From Linear')).not.toBeInTheDocument();
    expect(screen.queryByText('Harness')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('location-project'));

    expect(
      await screen.findByTestId('current-workspace-branch'),
    ).toHaveTextContent('feature/current-work');
    expect(screen.queryByTestId('source-section')).toBeNull();
    expect(screen.getByTestId('create-workspace-submit')).toBeEnabled();
    fireEvent.click(screen.getByTestId('create-workspace-submit'));

    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    const call = api.stream.mock.calls.find((c) => c[0] === 'workspace:create');
    expect(call?.[1]).toMatchObject({
      sourceKind: 'branch',
      location: 'project',
    });
    expect(call?.[1]).not.toHaveProperty('baseBranch');
    expect(call?.[1]).not.toHaveProperty('harness');
  });

  it('sends a validated custom worktree name when selected', async () => {
    const api = installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId('worktree-name-input'), {
      target: { value: 'feature-search' },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('branch-item').length).toBe(3);
    });
    fireEvent.click(screen.getAllByTestId('branch-item')[0]);
    fireEvent.click(screen.getByTestId('create-workspace-submit'));

    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    const call = api.stream.mock.calls.find((c) => c[0] === 'workspace:create');
    expect(call?.[1]).toMatchObject({
      location: 'worktree',
      worktreeName: 'feature-search',
    });
  });

  it('normalizes typed worktree names to the filesystem-safe format', async () => {
    installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);
    const input = screen.getByTestId('worktree-name-input');

    fireEvent.change(input, { target: { value: 'W2BT-17908' } });
    expect(input).toHaveValue('w2bt-17908');
    expect(input).toHaveAttribute('aria-invalid', 'false');

    fireEvent.change(input, { target: { value: ' Feature / Search ' } });
    expect(input).toHaveValue('feature-search-');
    fireEvent.blur(input);
    expect(input).toHaveValue('feature-search');

    fireEvent.change(input, { target: { value: 'Résumé---Été' } });
    expect(input).toHaveValue('resume-ete');

    fireEvent.change(input, { target: { value: '///' } });
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('create-workspace-submit')).toBeDisabled();
  });

  it('fully normalizes pasted worktree names and submits the result', async () => {
    const api = installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);
    const input = screen.getByTestId('worktree-name-input');
    await waitFor(() => expect(input).toHaveValue('paris'));
    (input as HTMLInputElement).setSelectionRange(0, 'paris'.length);

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => ` W2BT / Feature ${'A'.repeat(80)} `,
      },
    });

    const expected = `w2bt-feature-${'a'.repeat(50)}`;
    expect(input).toHaveValue(expected);
    expect(expected).toHaveLength(63);
    expect(input).toHaveAttribute('aria-invalid', 'false');

    await waitFor(() => {
      expect(screen.getAllByTestId('branch-item').length).toBe(3);
    });
    fireEvent.click(screen.getAllByTestId('branch-item')[0]);
    fireEvent.click(screen.getByTestId('create-workspace-submit'));

    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    expect(
      api.stream.mock.calls.find((call) => call[0] === 'workspace:create')?.[1],
    ).toMatchObject({ worktreeName: expected });
  });

  it('sends separate custom workspace and branch names', async () => {
    const api = installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId('workspace-name-input'), {
      target: { value: 'search-workspace' },
    });
    fireEvent.change(screen.getByTestId('branch-name-input'), {
      target: { value: 'feature/search' },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('branch-item')).not.toHaveLength(0),
    );
    fireEvent.click(screen.getAllByTestId('branch-item')[0]);
    fireEvent.click(screen.getByTestId('create-workspace-submit'));

    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    expect(
      api.stream.mock.calls.find((call) => call[0] === 'workspace:create')?.[1],
    ).toMatchObject({
      name: 'search-workspace',
      branch: 'feature/search',
    });
  });

  it('accepts a human-readable workspace name', async () => {
    installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    const input = await screen.findByTestId('workspace-name-input');
    fireEvent.change(input, {
      target: { value: 'Search workspace — July' },
    });

    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('blocks invalid custom branch names', async () => {
    installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId('branch-name-input'), {
      target: { value: 'feature bad' },
    });

    expect(screen.getByTestId('branch-name-input')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByTestId('create-workspace-submit')).toBeDisabled();
  });

  it('keeps location and worktree naming above and independent from source selection', async () => {
    installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId('worktree-name-input'), {
      target: { value: 'persistent-name' },
    });

    const sourceSection = screen.getByTestId('source-section');
    expect(
      screen
        .getByTestId('location-worktree')
        .compareDocumentPosition(sourceSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen
        .getByTestId('worktree-name-input')
        .compareDocumentPosition(sourceSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId('source-tab-pr'));
    await screen.findAllByTestId('pr-item');
    expect(screen.getByTestId('location-worktree')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('worktree-name-input')).toHaveValue(
      'persistent-name',
    );

    fireEvent.click(screen.getByTestId('source-tab-issue'));
    await screen.findAllByTestId('issue-item');
    expect(screen.getByTestId('worktree-name-input')).toHaveValue(
      'persistent-name',
    );
  });
});

describe('NewWorkspaceDialog — From PR tab', () => {
  it('lists PRs and creates a workspace with sourceKind "pr" on submit', async () => {
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
    expect(api.stream).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('create-workspace-submit'));

    await waitFor(() => {
      expect(api.stream).toHaveBeenCalled();
    });
    const call = api.stream.mock.calls.find((c) => c[0] === 'workspace:create');
    expect(call).toBeDefined();
    const arg = call?.[1] as {
      sourceKind?: string;
      sourceRef?: string;
      location?: string;
    };
    expect(arg.sourceKind).toBe('pr');
    expect(arg.sourceRef).toBe('3');
    expect(arg.location).toBe('worktree');
  });

  it('hides sources for the current checkout and restores the prior tab for worktrees', async () => {
    installApi();
    render(<NewWorkspaceDialog projectId={PROJECT_ID} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('source-tab-pr'));
    await screen.findAllByTestId('pr-item');
    fireEvent.click(screen.getByTestId('location-project'));

    expect(screen.getByTestId('location-project')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByTestId('source-section')).toBeNull();
    expect(screen.getByTestId('create-workspace-submit')).toBeEnabled();

    fireEvent.click(screen.getByTestId('location-worktree'));
    expect(screen.getByTestId('source-tab-pr')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await screen.findAllByTestId('pr-item')).not.toHaveLength(0);
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
    fireEvent.click(screen.getByTestId('create-workspace-submit'));

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
