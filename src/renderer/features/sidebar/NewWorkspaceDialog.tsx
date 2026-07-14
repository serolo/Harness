// New Workspace dialog — a plain React modal (fixed overlay + centered panel).
//
// NOT a Radix Dialog. There is no @radix-ui/react-dialog in this project.
//
// Location and worktree naming are shared by every source and stay mounted above the
// source picker. Switching source changes only the source-specific content below it.
// Source tabs:
//   - Branch  : base branch.
//   - From PR : lists the project's open PRs (`github:listPrs`); selecting one creates
//               a workspace seeded from the PR head (`sourceKind:'pr'`).
//   - From issue: lists the project's open issues (`github:listIssues`); selecting one
//               creates a normal (branch-from-base) workspace tagged `github_issue` AND
//               seeds a one-time `pendingPrompt` (the issue text) for the chat composer.
//
// All three funnel through `runCreate`, which drives the `workspace:create` stream:
//   - `{ kind: 'setupLog' }` chunks accumulate into <SetupLogPanel>.
//   - `{ kind: 'phase' }` chunks update the status line.
//   - `{ kind: 'created' }` → optional per-workspace hook → selectWorkspace + close.
//
// The PR/issue lists degrade gracefully: when no GitHub account is connected the
// `invoke` rejects with a typed AppError and an inline "Connect GitHub" empty state is
// shown instead of crashing the dialog.
//
// Design system note (Batch A): the overlay/panel chrome mirrors `components/ui/Dialog`
// (rounded-4/border-border-1/bg-surface-overlay/shadow-4) by hand rather than importing
// the primitive — Dialog has no slot for the tabbed source picker + streaming log body
// this component drives, so re-using its visual recipe (not its markup) keeps the same
// look without forcing the multi-tab logic through a single `children` slot. The source
// tabs (data-testid + aria-pressed + per-tab disabled) and the location/base-branch/PR/issue
// controls stay hand-rolled or adopt `Input`/`Select`/`Button`/`IconButton` where useful.

import { useState, useEffect, useRef, useCallback } from 'react';
import type { CreateWorkspaceReq } from '@shared/models';
import type { IssueListItem, PrListItem } from '@shared/github';
import { invoke, subscribeStream } from '@renderer/ipc';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useComposerStore } from '@renderer/stores/composer';
import { Button, IconButton, Input, Select } from '@renderer/components/ui';
import { SetupLogPanel } from './SetupLogPanel';

type SourceTab = 'branch' | 'pr' | 'issue';

const TABS: { id: SourceTab; label: string }[] = [
  { id: 'branch', label: 'Branch' },
  { id: 'pr', label: 'From PR' },
  { id: 'issue', label: 'From issue' },
];

/**
 * Build the one-time composer prompt for a workspace seeded from a GitHub issue.
 * `IssueListItem` carries no body (the list DTO is title-only), so we seed the title
 * plus a reference URL — enough for the agent to pick up the thread.
 */
function issuePrompt(issue: IssueListItem): string {
  return `${issue.title}\n\n${issue.url}`;
}

/**
 * Treat GitHub auth as global app configuration. Settings may show a valid GitHub CLI
 * session even before it has been imported into the encrypted integration store; the
 * picker needs a stored integration for API calls, so import from `gh` on demand.
 */
async function ensureGithubConnected(): Promise<boolean> {
  const accounts = await invoke('github:accounts', undefined);
  if (accounts.length > 0) return true;

  let cliAuthenticated = false;
  try {
    const cli = await invoke('github:cliStatus', undefined);
    cliAuthenticated = cli.authenticated;
  } catch (err) {
    if (!isMissingIpcHandler(err)) throw err;
  }

  if (!cliAuthenticated) return false;

  try {
    await invoke('github:connectGhCli', undefined);
    return true;
  } catch (err) {
    if (isMissingIpcHandler(err)) return false;
    throw err;
  }
}

function isMissingIpcHandler(err: unknown): boolean {
  return err instanceof Error && /No handler registered/i.test(err.message);
}

export interface NewWorkspaceDialogProps {
  /** The project to create the workspace under. Must be set before submission. */
  projectId: string | null;
  /** Called when the user cancels or the workspace is successfully created. */
  onClose: () => void;
}

/**
 * A fixed-position modal for creating a new workspace. Plain React — no Radix
 * Dialog dependency. Streams workspace creation progress into SetupLogPanel.
 */
export function NewWorkspaceDialog({
  projectId,
  onClose,
}: NewWorkspaceDialogProps): React.JSX.Element {
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const setPendingPrompt = useComposerStore((s) => s.setPendingPrompt);

  // Form state
  const [activeTab, setActiveTab] = useState<SourceTab>('branch');
  const [baseBranch, setBaseBranch] = useState('');
  const [baseBranches, setBaseBranches] = useState<string[]>([]);
  const [branchListLoading, setBranchListLoading] = useState(false);
  const [branchListError, setBranchListError] = useState<string | null>(null);
  const [location, setLocation] = useState<'project' | 'worktree'>('worktree');
  const [worktreeNaming, setWorktreeNaming] = useState<'automatic' | 'custom'>(
    'automatic',
  );
  const [worktreeName, setWorktreeName] = useState('');

  // PR / issue list state (loaded lazily when the matching tab opens).
  const [prs, setPrs] = useState<PrListItem[] | null>(null);
  const [issues, setIssues] = useState<IssueListItem[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  // Set when a list fetch rejects (typically "no account connected") → empty state.
  const [listError, setListError] = useState<string | null>(null);

  // GitHub inline-connect affordance (shown in the GitHub empty state — no account yet).
  // `githubReload` bumps to re-run the list-load effect after a successful connect.
  const [githubToken, setGithubToken] = useState('');
  const [githubReload, setGithubReload] = useState(0);

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Streaming state
  const [isStreaming, setIsStreaming] = useState(false);
  const [phaseMessage, setPhaseMessage] = useState('');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Abort controller for cancellation
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Load base branches for the Branch tab. The main command fetches origin before
  // returning refs so the select reflects the latest local + remote branch list.
  useEffect(() => {
    if (projectId === null || activeTab !== 'branch') return;

    let active = true;
    setBranchListLoading(true);
    setBranchListError(null);

    void invoke('project:listBranches', { projectId })
      .then(({ defaultBranch, branches }) => {
        if (!active) return;
        setBaseBranches(branches);
        setBaseBranch((prev) => {
          if (prev !== '' && branches.includes(prev)) return prev;
          if (branches.includes(defaultBranch)) return defaultBranch;
          const remoteDefault = `origin/${defaultBranch}`;
          if (branches.includes(remoteDefault)) return remoteDefault;
          return branches[0] ?? '';
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setBaseBranches([]);
        setBaseBranch('');
        setBranchListError(
          isMissingIpcHandler(err)
            ? 'Restart the app to load the latest branch list support.'
            : err instanceof Error
              ? err.message
              : String(err),
        );
      })
      .finally(() => {
        if (active) setBranchListLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activeTab, projectId]);

  // Load the PR/issue list when its tab becomes active. A rejected invoke (no
  // connected account, offline) is caught and surfaced as the inline empty state.
  useEffect(() => {
    if (projectId === null) return;
    if (activeTab === 'branch') return;

    let active = true;
    setListLoading(true);
    setListError(null);

    const load = (async (): Promise<void> => {
      const connected = await ensureGithubConnected();
      if (!connected) {
        if (active) setListError('no GitHub account connected');
        return;
      }

      if (activeTab === 'pr') {
        const rows = await invoke('github:listPrs', { projectId });
        if (active) setPrs(rows);
        return;
      }

      if (activeTab === 'issue') {
        const rows = await invoke('github:listIssues', { projectId });
        if (active) setIssues(rows);
        return;
      }

      const rows = await invoke('github:listIssues', { projectId });
      if (active) setIssues(rows);
    })();

    void load
      .catch((err: unknown) => {
        if (!active) return;
        setListError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setListLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activeTab, projectId, githubReload]);

  function handleClose(): void {
    abortRef.current?.abort();
    onClose();
  }

  /**
   * Drive the `workspace:create` stream for a request. Shared by all three tabs.
   * `onCreated` runs (with the new workspace id) on the persisted `created` frame,
   * before selection + close — used by the issue flow to stash the pending prompt.
   */
  const runCreate = useCallback(
    async (
      req: Omit<CreateWorkspaceReq, 'projectId'>,
      onCreated?: (workspaceId: string) => void,
    ): Promise<void> => {
      if (projectId === null || isStreaming) return;

      setIsStreaming(true);
      setLogLines([]);
      setPhaseMessage('');
      setError(null);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        await subscribeStream(
          'workspace:create',
          { projectId, ...req },
          (chunk) => {
            if (chunk.kind === 'setupLog') {
              setLogLines((prev) => [...prev, chunk.chunk]);
            } else if (chunk.kind === 'phase') {
              setPhaseMessage(chunk.message ?? chunk.phase);
            } else if (chunk.kind === 'created') {
              onCreated?.(chunk.workspace.id);
              selectWorkspace(chunk.workspace.id);
              onClose();
            }
          },
          { signal: ctrl.signal },
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [projectId, isStreaming, selectWorkspace, onClose],
  );

  function locationOptions(): Pick<CreateWorkspaceReq, 'location' | 'name'> {
    return {
      location,
      ...(location === 'worktree' &&
      worktreeNaming === 'custom' &&
      worktreeName.trim() !== ''
        ? { name: worktreeName.trim() }
        : {}),
    };
  }

  function handleBranchSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (baseBranch.trim() === '') return;
    void runCreate({
      ...locationOptions(),
      baseBranch: baseBranch.trim(),
      sourceKind: 'branch',
    });
  }

  function handleSelectPr(pr: PrListItem): void {
    // Seed the worktree from the PR head; the name/branch are auto-allocated by main
    // (consistent with the branch flow leaving them blank).
    void runCreate({
      ...locationOptions(),
      sourceKind: 'pr',
      sourceRef: String(pr.number),
    });
  }

  function handleSelectIssue(issue: IssueListItem): void {
    // A normal branch-from-base workspace tagged with the issue, plus a one-time
    // composer prompt keyed on the freshly-created workspace id.
    const prompt = issuePrompt(issue);
    void runCreate(
      {
        ...locationOptions(),
        sourceKind: 'github_issue',
        sourceRef: String(issue.number),
      },
      (workspaceId) => setPendingPrompt(workspaceId, prompt),
    );
  }

  /**
   * Connect a GitHub account inline (PAT paste) when PR/issue listing reports none. Drives
   * the `github:connect` stream; on the terminal `connected` frame, clears the token and
   * bumps `githubReload` to refetch the active GitHub list. The token lives only in local
   * state — never logged.
   */
  async function handleConnectGithub(): Promise<void> {
    const token = githubToken.trim();
    if (token === '' || connecting) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await subscribeStream(
        'github:connect',
        { mode: 'pat', token },
        (chunk) => {
          if (chunk.kind === 'connected') {
            setGithubToken('');
            setListError(null);
            setGithubReload((k) => k + 1);
          } else if (chunk.kind === 'error') {
            setConnectError(chunk.message);
          }
        },
      );
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  const selectedLocation = location;
  const customNameInvalid =
    selectedLocation === 'worktree' &&
    worktreeNaming === 'custom' &&
    !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(worktreeName.trim());

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-40 bg-scrim"
        aria-hidden="true"
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New Workspace"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        data-testid="new-workspace-dialog"
      >
        <div
          className="relative w-full max-w-md rounded-4 border border-border-1 bg-surface-overlay shadow-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-1 px-4 py-3">
            <h2 className="text-md font-semibold text-fg-1">New Workspace</h2>
            <IconButton label="Close" size="sm" onClick={handleClose}>
              ✕
            </IconButton>
          </div>

          {/* Body */}
          <div className="p-4">
            <fieldset className="mb-4">
              <legend className="mb-1.5 text-xs font-medium uppercase tracking-caps text-fg-3">
                Location
              </legend>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  data-testid="location-project"
                  aria-pressed={selectedLocation === 'project'}
                  disabled={isStreaming}
                  onClick={() => setLocation('project')}
                  className={`rounded-2 border px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    selectedLocation === 'project'
                      ? 'border-accent bg-accent-muted text-fg-1'
                      : 'border-border-1 bg-surface-well text-fg-2'
                  }`}
                >
                  <span className="block font-medium">Current workspace</span>
                  <span className="mt-0.5 block text-fg-3">
                    Work in the project folder
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="location-worktree"
                  aria-pressed={selectedLocation === 'worktree'}
                  disabled={isStreaming}
                  onClick={() => setLocation('worktree')}
                  className={`rounded-2 border px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    selectedLocation === 'worktree'
                      ? 'border-accent bg-accent-muted text-fg-1'
                      : 'border-border-1 bg-surface-well text-fg-2'
                  }`}
                >
                  <span className="block font-medium">Add worktree</span>
                  <span className="mt-0.5 block text-fg-3">
                    Create an isolated checkout
                  </span>
                </button>
              </div>
            </fieldset>

            {selectedLocation === 'worktree' && (
              <fieldset className="mb-4">
                <legend className="mb-1 text-xs text-fg-2">
                  Worktree name
                </legend>
                <div className="flex gap-3 text-xs text-fg-2">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="worktree-naming"
                      checked={worktreeNaming === 'automatic'}
                      onChange={() => setWorktreeNaming('automatic')}
                      disabled={isStreaming}
                      data-testid="worktree-name-automatic"
                    />
                    Assign automatically
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="worktree-naming"
                      checked={worktreeNaming === 'custom'}
                      onChange={() => setWorktreeNaming('custom')}
                      disabled={isStreaming}
                      data-testid="worktree-name-custom"
                    />
                    Choose a name
                  </label>
                </div>
                {worktreeNaming === 'custom' && (
                  <div className="mt-2">
                    <Input
                      value={worktreeName}
                      onChange={(e) => setWorktreeName(e.target.value)}
                      placeholder="my-worktree"
                      disabled={isStreaming}
                      data-testid="worktree-name-input"
                      aria-invalid={customNameInvalid}
                    />
                    {customNameInvalid && worktreeName.trim() !== '' && (
                      <p className="mt-1 text-xs text-danger">
                        Use 1–63 lowercase letters, numbers, or hyphens.
                      </p>
                    )}
                  </div>
                )}
              </fieldset>
            )}

            {/* Source selection is intentionally below location + naming. Changing it
                swaps only the source-specific controls that follow. */}
            <div className="mb-4" data-testid="source-section">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-caps text-fg-3">
                Source
              </p>
              <div className="flex gap-1 rounded-2 border border-border-2 bg-surface-well p-0.5">
                {TABS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    disabled={isStreaming}
                    onClick={() => setActiveTab(id)}
                    data-testid={`source-tab-${id}`}
                    className={`flex-1 rounded-1 px-2 py-1 text-xs transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                      activeTab === id
                        ? 'bg-bg-4 text-fg-1'
                        : 'text-fg-2 hover:text-fg-1'
                    }`}
                    aria-pressed={activeTab === id}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* --- Branch tab --- */}
            {activeTab === 'branch' && (
              <form onSubmit={handleBranchSubmit}>
                <label className="mb-3 block">
                  <span className="mb-1 block text-xs text-fg-2">
                    Base branch
                  </span>
                  <Select
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value)}
                    disabled={isStreaming || branchListLoading}
                    className="w-full"
                    data-testid="base-branch-select"
                    options={
                      branchListLoading
                        ? [{ value: '', label: 'Loading branches...' }]
                        : baseBranches.map((branch) => ({
                            value: branch,
                            label: branch,
                          }))
                    }
                  />
                </label>

                {branchListError !== null && (
                  <p
                    data-testid="branch-list-error"
                    className="mb-3 rounded-2 border border-danger/30 bg-danger-muted px-2 py-1.5 text-xs text-danger"
                  >
                    {branchListError}
                  </p>
                )}

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      !projectId ||
                      isStreaming ||
                      branchListLoading ||
                      branchListError !== null ||
                      baseBranch.trim() === '' ||
                      customNameInvalid
                    }
                  >
                    {isStreaming ? 'Creating…' : 'Create'}
                  </Button>
                </div>
              </form>
            )}

            {/* --- From PR / From issue tabs --- */}
            {activeTab !== 'branch' && (
              <div data-testid={`${activeTab}-list`}>
                {activeTab === 'pr' && selectedLocation === 'project' ? (
                  <p
                    className="mb-3 rounded-2 border border-warn/30 bg-warn-muted px-2.5 py-2 text-xs text-warn"
                    data-testid="pr-location-warning"
                  >
                    Pull requests require an isolated worktree. Select Add
                    worktree above to continue.
                  </p>
                ) : null}
                {listLoading && (
                  <p className="py-4 text-center text-xs text-fg-3">Loading…</p>
                )}

                {/* No-account (or error) empty state — the invoke rejected. */}
                {!listLoading &&
                  listError !== null &&
                  (listError === 'no GitHub account connected' ? (
                    <div
                      data-testid="github-empty"
                      className="rounded-2 border border-border-1 bg-surface-well px-3 py-4"
                    >
                      <p className="text-sm text-fg-2 text-center">
                        Connect GitHub to list{' '}
                        {activeTab === 'pr' ? 'pull requests' : 'issues'}.
                      </p>
                      <p className="mt-1 text-center text-xs text-fg-3">
                        Paste a GitHub personal access token with repo access.
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Input
                          type="password"
                          value={githubToken}
                          onChange={(e) => setGithubToken(e.target.value)}
                          placeholder="github_pat_…"
                          disabled={connecting}
                          data-testid="github-token-input"
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="primary"
                          onClick={() => void handleConnectGithub()}
                          disabled={connecting || githubToken.trim() === ''}
                          data-testid="github-connect-submit"
                        >
                          {connecting ? 'Connecting…' : 'Connect'}
                        </Button>
                      </div>
                      {connectError && (
                        <p
                          data-testid="github-connect-error"
                          className="mt-2 text-xs text-danger"
                        >
                          {connectError}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div
                      data-testid="github-list-error"
                      className="rounded-2 border border-danger/30 bg-danger-muted px-3 py-4"
                    >
                      <p className="text-xs text-danger">{listError}</p>
                    </div>
                  ))}

                {/* PR list */}
                {!listLoading &&
                  listError === null &&
                  activeTab === 'pr' &&
                  (prs && prs.length > 0 ? (
                    <ul className="max-h-64 space-y-1 overflow-y-auto">
                      {prs.map((pr) => (
                        <li key={pr.number}>
                          <button
                            type="button"
                            disabled={
                              isStreaming ||
                              customNameInvalid ||
                              selectedLocation === 'project'
                            }
                            onClick={() => handleSelectPr(pr)}
                            data-testid="pr-item"
                            data-pr-number={pr.number}
                            className="w-full rounded-2 border border-border-1 bg-surface-well px-3 py-2 text-left transition-colors duration-fast ease-out hover:border-border-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span className="block truncate text-sm text-fg-1">
                              {pr.title}
                            </span>
                            <span className="text-xs text-fg-3">
                              #{pr.number}
                              {pr.author ? ` · ${pr.author}` : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-4 text-center text-xs text-fg-3">
                      No open pull requests.
                    </p>
                  ))}

                {/* Issue list */}
                {!listLoading &&
                  listError === null &&
                  activeTab === 'issue' &&
                  (issues && issues.length > 0 ? (
                    <ul className="max-h-64 space-y-1 overflow-y-auto">
                      {issues.map((issue) => (
                        <li key={issue.number}>
                          <button
                            type="button"
                            disabled={isStreaming || customNameInvalid}
                            onClick={() => handleSelectIssue(issue)}
                            data-testid="issue-item"
                            data-issue-number={issue.number}
                            className="w-full rounded-2 border border-border-1 bg-surface-well px-3 py-2 text-left transition-colors duration-fast ease-out hover:border-border-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span className="block truncate text-sm text-fg-1">
                              {issue.title}
                            </span>
                            <span className="text-xs text-fg-3">
                              #{issue.number}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-4 text-center text-xs text-fg-3">
                      No open issues.
                    </p>
                  ))}
              </div>
            )}

            {/* Phase status line */}
            {phaseMessage && (
              <p className="mt-3 text-xs text-fg-2">
                <span className="mr-1 inline-block h-2 w-2 animate-spin rounded-full border border-accent border-t-transparent align-middle" />
                {phaseMessage}
              </p>
            )}

            {/* Setup log */}
            {(isStreaming || logLines.length > 0) && (
              <div className="mt-3">
                <SetupLogPanel lines={logLines} />
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="mt-3 rounded-2 border border-danger/30 bg-danger-muted px-2 py-1.5 text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
