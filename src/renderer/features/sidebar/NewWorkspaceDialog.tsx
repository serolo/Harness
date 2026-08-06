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
// All three funnel through `runCreate`, which drives the `workspace:create` stream.
// Creation is handed to the app-level workspace-creation store. The dialog closes only
// after successful creation, explicit cancellation, or a click outside the modal panel.
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

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, GitPullRequest, CircleDot, Check } from 'lucide-react';
import type { CreateWorkspaceReq } from '@shared/models';
import type { IssueListItem, PrListItem } from '@shared/github';
import { invoke, subscribeStream } from '@renderer/ipc';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useComposerStore } from '@renderer/stores/composer';
import {
  createWorkspaceInBackground,
  useWorkspaceCreationStore,
} from '@renderer/stores/workspaceCreation';
import { Button, Input } from '@renderer/components/ui';

type SourceTab = 'branch' | 'pr' | 'issue';

const TABS: { id: SourceTab; label: string }[] = [
  { id: 'pr', label: 'PRs' },
  { id: 'branch', label: 'Branches' },
  { id: 'issue', label: 'Issues' },
];

interface BranchChoice {
  ref: string;
  label: string;
}

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

function branchChoices(branches: string[]): BranchChoice[] {
  const remoteChoices: BranchChoice[] = [];
  const remoteLabels = new Set<string>();
  const localChoices: BranchChoice[] = [];

  for (const branch of branches) {
    if (branch === 'origin/HEAD') continue;
    if (branch.startsWith('origin/')) {
      const label = branch.slice('origin/'.length);
      if (label === '' || remoteLabels.has(label)) continue;
      remoteLabels.add(label);
      remoteChoices.push({ ref: branch, label });
      continue;
    }
    localChoices.push({ ref: branch, label: branch });
  }

  return [
    ...remoteChoices,
    ...localChoices.filter((choice) => !remoteLabels.has(choice.label)),
  ];
}

function matchesFilter(value: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return true;
  return value.toLowerCase().includes(needle);
}

function isValidBranchName(branch: string): boolean {
  return (
    branch.length <= 128 &&
    /^(?!.*(?:\.\.|\/\/|@\{|\\))[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9_-])?$/.test(
      branch,
    ) &&
    branch
      .split('/')
      .every(
        (part) =>
          part !== '' && !part.startsWith('.') && !part.endsWith('.lock'),
      )
  );
}

export interface NewWorkspaceDialogProps {
  /** The project to create the workspace under. Must be set before submission. */
  projectId: string | null;
  /** Called when creation succeeds, the user cancels, or clicks outside the modal panel. */
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
  const creation = useWorkspaceCreationStore((s) => s.current);

  // Form state
  const [activeTab, setActiveTab] = useState<SourceTab>('branch');
  const [baseBranches, setBaseBranches] = useState<string[]>([]);
  const [branchListLoading, setBranchListLoading] = useState(false);
  const [branchListError, setBranchListError] = useState<string | null>(null);
  const [branchListWarning, setBranchListWarning] = useState<string | null>(
    null,
  );
  const [sourceFilter, setSourceFilter] = useState('');
  const [selectedBranch, setSelectedBranch] = useState<BranchChoice | null>(
    null,
  );
  const [selectedPr, setSelectedPr] = useState<PrListItem | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueListItem | null>(
    null,
  );
  const [location, setLocation] = useState<'project' | 'worktree'>('worktree');
  const [workspaceName, setWorkspaceName] = useState('');
  const [worktreeName, setWorktreeName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branchMode, setBranchMode] = useState<'new' | 'existing'>('new');
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [currentBranchError, setCurrentBranchError] = useState<string | null>(
    null,
  );

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
  const [creationRunId, setCreationRunId] = useState<string | null>(null);

  useEffect(() => {
    if (
      creationRunId !== null &&
      creation?.runId === creationRunId &&
      creation.status === 'error'
    ) {
      setIsStreaming(false);
    }
  }, [creation, creationRunId]);

  useEffect(() => {
    if (projectId === null) return;
    let active = true;
    void invoke('workspace:suggestNames', { projectId })
      .then((names) => {
        if (!active) return;
        // Never overwrite a fast user edit if suggestions resolve after typing starts.
        setWorkspaceName((current) =>
          current === '' ? names.workspaceName : current,
        );
        setWorktreeName((current) =>
          current === '' ? names.worktreeName : current,
        );
        setBranchName((current) =>
          current === '' ? names.branchName : current,
        );
      })
      .catch(() => {
        // Creation stays disabled until collision-safe suggestions are available.
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  // Load base branches for the Branch tab. The main command fetches origin before
  // returning refs so the select reflects the latest local + remote branch list.
  useEffect(() => {
    if (projectId === null || activeTab !== 'branch') return;

    let active = true;
    setBranchListLoading(true);
    setBranchListError(null);
    setBranchListWarning(null);

    void invoke('project:listBranches', { projectId })
      .then(({ branches, fetchWarning }) => {
        if (!active) return;
        setBaseBranches(branches);
        setBranchListWarning(fetchWarning ?? null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setBaseBranches([]);
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

  useEffect(() => {
    if (projectId === null || location !== 'project') return;
    let active = true;
    setCurrentBranchError(null);
    void invoke('project:getCurrentBranch', { projectId })
      .then(({ branch }) => {
        if (active) setCurrentBranch(branch);
      })
      .catch((err: unknown) => {
        if (active) {
          setCurrentBranch(null);
          setCurrentBranchError(
            err instanceof Error ? err.message : String(err),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [location, projectId]);

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
    onClose();
  }

  /**
   * Drive the `workspace:create` stream for a request. Shared by all three tabs.
   * `onCreated` runs (with the new workspace id) on the persisted `created` frame,
   * before selection and close — used by the issue flow to stash the pending prompt.
   */
  const runCreate = useCallback(
    (
      req: Omit<CreateWorkspaceReq, 'projectId'>,
      onCreated?: (workspaceId: string) => void,
    ): void => {
      if (projectId === null || isStreaming) return;

      setIsStreaming(true);
      const runId = createWorkspaceInBackground(
        { projectId, ...req },
        (workspaceId) => {
          onCreated?.(workspaceId);
          selectWorkspace(workspaceId);
          onClose();
        },
      );
      setCreationRunId(runId);
    },
    [projectId, isStreaming, selectWorkspace, onClose],
  );

  function locationOptions(): Pick<
    CreateWorkspaceReq,
    'location' | 'name' | 'worktreeName' | 'branch'
  > {
    return {
      location,
      name: workspaceName.trim(),
      ...(location === 'worktree'
        ? {
            worktreeName: worktreeName.trim(),
            branch:
              activeTab === 'branch' &&
              branchMode === 'existing' &&
              selectedBranch !== null
                ? selectedBranch.label
                : branchName.trim(),
          }
        : {}),
    };
  }

  function handleSelectBranch(branch: BranchChoice): void {
    if (
      customWorkspaceNameInvalid ||
      customWorktreeNameInvalid ||
      customBranchInvalid
    )
      return;
    setSelectedBranch(branch);
  }

  function handleSelectPr(pr: PrListItem): void {
    setSelectedPr(pr);
  }

  function handleSelectIssue(issue: IssueListItem): void {
    setSelectedIssue(issue);
  }

  function handleCreate(): void {
    if (
      customWorkspaceNameInvalid ||
      customWorktreeNameInvalid ||
      customBranchInvalid
    )
      return;
    if (selectedLocation === 'project') {
      runCreate({
        ...locationOptions(),
        sourceKind: 'branch',
      });
      return;
    }
    if (activeTab === 'branch' && selectedBranch !== null) {
      runCreate({
        ...locationOptions(),
        baseBranch: selectedBranch.ref,
        sourceKind: 'branch',
      });
      return;
    }
    if (activeTab === 'pr' && selectedPr !== null) {
      runCreate({
        ...locationOptions(),
        sourceKind: 'pr',
        sourceRef: String(selectedPr.number),
      });
      return;
    }
    if (activeTab === 'issue' && selectedIssue !== null) {
      const prompt = issuePrompt(selectedIssue);
      runCreate(
        {
          ...locationOptions(),
          sourceKind: 'github_issue',
          sourceRef: String(selectedIssue.number),
        },
        (workspaceId) => setPendingPrompt(workspaceId, prompt),
      );
    }
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
  const customWorkspaceNameInvalid =
    workspaceName.trim().length === 0 ||
    /[\p{Cc}\p{Cf}]/u.test(workspaceName.trim());
  const customWorktreeNameInvalid =
    selectedLocation === 'worktree' &&
    !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(worktreeName.trim());
  const customBranchInvalid =
    selectedLocation === 'worktree' &&
    (activeTab !== 'branch' || branchMode === 'new') &&
    !isValidBranchName(branchName.trim());
  const branchRows = useMemo(
    () =>
      branchChoices(baseBranches).filter((branch) =>
        matchesFilter(branch.label, sourceFilter),
      ),
    [baseBranches, sourceFilter],
  );
  const prRows = useMemo(
    () =>
      (prs ?? []).filter((pr) =>
        matchesFilter(
          `${pr.title} ${pr.number} ${pr.author ?? ''}`,
          sourceFilter,
        ),
      ),
    [prs, sourceFilter],
  );
  const issueRows = useMemo(
    () =>
      (issues ?? []).filter((issue) =>
        matchesFilter(`${issue.title} ${issue.number}`, sourceFilter),
      ),
    [issues, sourceFilter],
  );
  const canCreate =
    !isStreaming &&
    !customWorkspaceNameInvalid &&
    !customWorktreeNameInvalid &&
    !customBranchInvalid &&
    (selectedLocation === 'project' ||
      (activeTab === 'branch' && selectedBranch !== null) ||
      (activeTab === 'pr' && selectedPr !== null) ||
      (activeTab === 'issue' && selectedIssue !== null));

  return createPortal(
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-[100] bg-scrim"
        data-testid="new-workspace-overlay"
        aria-hidden="true"
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New Workspace"
        className="fixed inset-0 z-[110] flex items-center justify-center p-4"
        data-testid="new-workspace-dialog"
        onClick={(event) => {
          if (event.target === event.currentTarget) handleClose();
        }}
      >
        <div
          className="relative w-full max-w-md rounded-4 border border-border-1 bg-surface-overlay shadow-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="border-b border-border-1 px-4 py-3">
            <h2 className="text-md font-semibold text-fg-1">New Workspace</h2>
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
                    {selectedLocation === 'project' && currentBranch
                      ? `Use checked-out branch: ${currentBranch}`
                      : 'Work in the project folder'}
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
              {selectedLocation === 'project' ? (
                <p
                  className={`mt-2 text-xs ${
                    currentBranchError ? 'text-danger' : 'text-fg-3'
                  }`}
                  data-testid="current-workspace-branch"
                >
                  {currentBranchError ??
                    (currentBranch
                      ? `New workspace will use the currently checked-out branch: ${currentBranch}.`
                      : 'Reading the currently checked-out branch…')}
                </p>
              ) : null}
            </fieldset>

            <fieldset className="mb-4">
              <legend className="mb-1 text-xs text-fg-2">
                Workspace name
              </legend>
              <Input
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="Generating name…"
                disabled={isStreaming}
                data-testid="workspace-name-input"
                aria-invalid={customWorkspaceNameInvalid}
              />
              {customWorkspaceNameInvalid && workspaceName.trim() !== '' ? (
                <p className="mt-1 text-xs text-danger">
                  Workspace name is required.
                </p>
              ) : null}
            </fieldset>

            {selectedLocation === 'worktree' ? (
              <fieldset className="mb-4">
                <legend className="mb-1 text-xs text-fg-2">
                  Worktree name
                </legend>
                <Input
                  value={worktreeName}
                  onChange={(event) => setWorktreeName(event.target.value)}
                  placeholder="Generating name…"
                  disabled={isStreaming}
                  data-testid="worktree-name-input"
                  aria-invalid={customWorktreeNameInvalid}
                />
                {customWorktreeNameInvalid && worktreeName.trim() !== '' ? (
                  <p className="mt-1 text-xs text-danger">
                    Use 1–63 lowercase letters, numbers, or hyphens.
                  </p>
                ) : null}
              </fieldset>
            ) : null}

            {selectedLocation === 'worktree' ? (
              <fieldset className="mb-4">
                <legend className="mb-1 text-xs text-fg-2">
                  Branch name
                </legend>
                {activeTab === 'branch' ? (
                  <div className="mb-2 flex gap-3 text-xs text-fg-2">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="branch-mode"
                        checked={branchMode === 'new'}
                        onChange={() => setBranchMode('new')}
                        disabled={isStreaming}
                        data-testid="branch-mode-new"
                      />
                      Create new branch
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="branch-mode"
                        checked={branchMode === 'existing'}
                        onChange={() => setBranchMode('existing')}
                        disabled={isStreaming}
                        data-testid="branch-mode-existing"
                      />
                      Use selected branch
                    </label>
                  </div>
                ) : null}
                {activeTab === 'branch' && branchMode === 'existing' ? (
                  <div
                    className="rounded-2 border border-border-1 bg-surface-well px-3 py-2 text-sm text-fg-2"
                    data-testid="existing-branch-name"
                  >
                    {selectedBranch?.label ??
                      'Select an existing branch below.'}
                  </div>
                ) : (
                  <>
                    <Input
                      value={branchName}
                      onChange={(event) => setBranchName(event.target.value)}
                      placeholder="Generating name…"
                      disabled={isStreaming}
                      data-testid="branch-name-input"
                      aria-invalid={customBranchInvalid}
                    />
                    {customBranchInvalid && branchName.trim() !== '' ? (
                      <p className="mt-1 text-xs text-danger">
                        Enter a valid Git branch name without spaces, double
                        dots, or consecutive slashes.
                      </p>
                    ) : null}
                  </>
                )}
              </fieldset>
            ) : null}

            {/* A project-checkout workspace always uses its already checked-out branch,
                so source selection only applies to isolated worktrees. */}
            {selectedLocation === 'worktree' ? (
              <>
                <div className="mb-4" data-testid="source-section">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-caps text-fg-3">
                Create From
              </h3>
              <div className="mb-3 flex gap-1 border-y border-border-1 py-2">
                {TABS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    disabled={isStreaming}
                    onClick={() => setActiveTab(id)}
                    data-testid={`source-tab-${id}`}
                    className={`rounded-2 px-3 py-2 text-sm font-medium transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
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
              <Input
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                placeholder="Search by name"
                disabled={isStreaming}
                data-testid="source-filter"
                className="h-12 rounded-3 border-border-1 bg-surface-overlay px-4 text-sm"
              />
                </div>

                {/* --- Branch tab --- */}
                {activeTab === 'branch' && (
              <div
                className="h-64 overflow-y-auto"
                data-testid="branch-results"
              >
                {branchListLoading && (
                  <p className="py-4 text-center text-xs text-fg-3">
                    Loading branches...
                  </p>
                )}

                {branchListError !== null && (
                  <p
                    data-testid="branch-list-error"
                    className="mb-3 rounded-2 border border-danger/30 bg-danger-muted px-2 py-1.5 text-xs text-danger"
                  >
                    {branchListError}
                  </p>
                )}

                {branchListWarning !== null && (
                  <p
                    data-testid="branch-list-warning"
                    className="mb-3 rounded-2 border border-warning/30 bg-warning-muted px-2 py-1.5 text-xs text-warning"
                  >
                    {branchListWarning}
                  </p>
                )}

                {!branchListLoading &&
                  branchListError === null &&
                  (branchRows.length > 0 ? (
                    <ul className="space-y-1">
                      {branchRows.map((branch) => (
                        <li key={branch.ref}>
                          <button
                            type="button"
                            disabled={
                              isStreaming ||
                              customWorkspaceNameInvalid ||
                              customWorktreeNameInvalid ||
                              customBranchInvalid
                            }
                            onClick={() => handleSelectBranch(branch)}
                            data-testid="branch-item"
                            data-branch-ref={branch.ref}
                            aria-pressed={selectedBranch?.ref === branch.ref}
                            className={`group flex w-full items-center gap-3 rounded-2 border px-3 py-2 text-left transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                              selectedBranch?.ref === branch.ref
                                ? 'border-accent bg-accent-muted'
                                : 'border-transparent bg-surface-well hover:bg-bg-4'
                            }`}
                          >
                            <GitBranch
                              className="h-4 w-4 shrink-0 text-fg-3"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate text-sm text-fg-1">
                              {branch.label}
                            </span>
                            {selectedBranch?.ref === branch.ref ? (
                              <Check
                                className="h-4 w-4 text-accent"
                                aria-hidden
                              />
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-4 text-center text-xs text-fg-3">
                      No branches found.
                    </p>
                  ))}
              </div>
                )}

                {/* --- From PR / From issue tabs --- */}
                {activeTab !== 'branch' && (
              <div
                className="h-64 overflow-y-auto"
                data-testid={`${activeTab}-list`}
              >
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
                  (prRows.length > 0 ? (
                    <ul className="space-y-1">
                      {prRows.map((pr) => (
                        <li key={pr.number}>
                          <button
                            type="button"
                            disabled={
                              isStreaming ||
                              customWorkspaceNameInvalid ||
                              customWorktreeNameInvalid ||
                              customBranchInvalid
                            }
                            onClick={() => handleSelectPr(pr)}
                            data-testid="pr-item"
                            data-pr-number={pr.number}
                            aria-pressed={selectedPr?.number === pr.number}
                            className={`group flex w-full items-center gap-3 rounded-2 border px-3 py-2 text-left transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                              selectedPr?.number === pr.number
                                ? 'border-accent bg-accent-muted'
                                : 'border-transparent bg-surface-well hover:bg-bg-4'
                            }`}
                          >
                            <GitPullRequest
                              className="h-4 w-4 shrink-0 text-fg-3"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-fg-1">
                                {pr.title}
                              </span>
                              <span className="text-xs text-fg-3">
                                #{pr.number}
                                {pr.author ? ` · ${pr.author}` : ''}
                              </span>
                            </span>
                            {selectedPr?.number === pr.number ? (
                              <Check
                                className="h-4 w-4 text-accent"
                                aria-hidden
                              />
                            ) : null}
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
                  (issueRows.length > 0 ? (
                    <ul className="space-y-1">
                      {issueRows.map((issue) => (
                        <li key={issue.number}>
                          <button
                            type="button"
                            disabled={
                              isStreaming ||
                              customWorkspaceNameInvalid ||
                              customWorktreeNameInvalid ||
                              customBranchInvalid
                            }
                            onClick={() => handleSelectIssue(issue)}
                            data-testid="issue-item"
                            data-issue-number={issue.number}
                            aria-pressed={
                              selectedIssue?.number === issue.number
                            }
                            className={`group flex w-full items-center gap-3 rounded-2 border px-3 py-2 text-left transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                              selectedIssue?.number === issue.number
                                ? 'border-accent bg-accent-muted'
                                : 'border-transparent bg-surface-well hover:bg-bg-4'
                            }`}
                          >
                            <CircleDot
                              className="h-4 w-4 shrink-0 text-fg-3"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-fg-1">
                                {issue.title}
                              </span>
                              <span className="text-xs text-fg-3">
                                #{issue.number}
                              </span>
                            </span>
                            {selectedIssue?.number === issue.number ? (
                              <Check
                                className="h-4 w-4 text-accent"
                                aria-hidden
                              />
                            ) : null}
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
              </>
            ) : null}

            <div className="mt-4 flex justify-end gap-2 border-t border-border-1 pt-4">
              {creationRunId !== null &&
              creation?.runId === creationRunId ? (
                <p
                  className={`mr-auto self-center text-xs ${
                    creation.status === 'error'
                      ? 'text-danger'
                      : creation.status === 'complete'
                        ? 'text-ok'
                        : 'text-fg-3'
                  }`}
                  data-testid="workspace-creation-status"
                >
                  {creation.error ?? creation.phase}
                </p>
              ) : null}
              <Button type="button" variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={!canCreate}
                onClick={handleCreate}
                data-testid="create-workspace-submit"
              >
                Create
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
