// New Workspace dialog — a plain React modal (fixed overlay + centered panel).
//
// NOT a Radix Dialog. There is no @radix-ui/react-dialog in this project.
//
// Source tabs:
//   - Branch  : the classic flow — base branch + optional custom name + harness.
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
// tabs (data-testid + aria-pressed + per-tab disabled) and the harness/base-branch/PR/issue
// controls stay hand-rolled or adopt `Input`/`Select`/`Button`/`IconButton` where doing so
// doesn't drop a `data-testid` or a `disabled` per-option requirement (see the harness
// `<Select>` vs. keeping a raw `<input>`/`<select>` for the rest).

import { useState, useEffect, useRef, useCallback } from 'react';
import type { HarnessId } from '@shared/harness';
import type { CreateWorkspaceReq } from '@shared/models';
import type { IssueListItem, PrListItem } from '@shared/github';
import type { LinearIssue } from '@shared/linear';
import { invoke, subscribeStream } from '@renderer/ipc';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useComposerStore } from '@renderer/stores/composer';
import { Button, IconButton, Input, Select } from '@renderer/components/ui';
import { SetupLogPanel } from './SetupLogPanel';

const HARNESS_OPTIONS: { value: HarnessId; label: string }[] = [
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
];

type SourceTab = 'branch' | 'pr' | 'issue' | 'linear';

const TABS: { id: SourceTab; label: string }[] = [
  { id: 'branch', label: 'Branch' },
  { id: 'pr', label: 'From PR' },
  { id: 'issue', label: 'From issue' },
  { id: 'linear', label: 'From Linear' },
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
 * Build the one-time composer prompt for a workspace seeded from a Linear issue. Seeds the
 * identifier + title plus the issue URL — enough for the agent to pick up the thread.
 */
function linearIssuePrompt(issue: LinearIssue): string {
  return `${issue.identifier} ${issue.title}\n\n${issue.url}`;
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
  const [customBranch, setCustomBranch] = useState('');
  const [harness, setHarness] = useState<HarnessId>('claude_code');

  // PR / issue list state (loaded lazily when the matching tab opens).
  const [prs, setPrs] = useState<PrListItem[] | null>(null);
  const [issues, setIssues] = useState<IssueListItem[] | null>(null);
  const [linearIssues, setLinearIssues] = useState<LinearIssue[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  // Set when a list fetch rejects (typically "no account connected") → empty state.
  const [listError, setListError] = useState<string | null>(null);

  // Linear inline-connect affordance (shown in the Linear empty state — no account yet).
  // `linearReload` bumps to re-run the list-load effect after a successful connect.
  const [linearToken, setLinearToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [linearReload, setLinearReload] = useState(0);

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

  // Load the PR/issue list when its tab becomes active. A rejected invoke (no
  // connected account, offline) is caught and surfaced as the inline empty state.
  useEffect(() => {
    if (projectId === null) return;
    if (activeTab === 'branch') return;

    let active = true;
    setListLoading(true);
    setListError(null);

    const load =
      activeTab === 'pr'
        ? invoke('github:listPrs', { projectId }).then((rows) => {
            if (active) setPrs(rows);
          })
        : activeTab === 'issue'
          ? invoke('github:listIssues', { projectId }).then((rows) => {
              if (active) setIssues(rows);
            })
          : // 'linear' — issues for the active Linear account (project-agnostic).
            invoke('linear:listIssues', {}).then((rows) => {
              if (active) setLinearIssues(rows);
            });

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
  }, [activeTab, projectId, linearReload]);

  function handleClose(): void {
    abortRef.current?.abort();
    onClose();
  }

  /**
   * Drive the `workspace:create` stream for a request. Shared by all three tabs.
   * `onCreated` runs (with the new workspace id) on the terminal `created` frame,
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

  function handleBranchSubmit(e: React.FormEvent): void {
    e.preventDefault();
    void runCreate({
      ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      ...(customBranch.trim() ? { branch: customBranch.trim() } : {}),
      harness,
      sourceKind: 'branch',
    });
  }

  function handleSelectPr(pr: PrListItem): void {
    // Seed the worktree from the PR head; the name/branch are auto-allocated by main
    // (consistent with the branch flow leaving them blank).
    void runCreate({
      harness,
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
        harness,
        sourceKind: 'github_issue',
        sourceRef: String(issue.number),
      },
      (workspaceId) => setPendingPrompt(workspaceId, prompt),
    );
  }

  function handleSelectLinearIssue(issue: LinearIssue): void {
    // Linear issues are not a git ref, so we create a normal branch-from-base workspace
    // (sourceKind:'branch') and seed the composer with the issue text. Provenance-tagging
    // as a distinct `linear_issue` source is a follow-on (would touch frozen @shared/models).
    const prompt = linearIssuePrompt(issue);
    void runCreate({ harness, sourceKind: 'branch' }, (workspaceId) =>
      setPendingPrompt(workspaceId, prompt),
    );
  }

  /**
   * Connect a Linear account inline (API-key paste) when the issue list reports none. Drives
   * the `linear:connect` stream; on the terminal `connected` frame, clears the key and bumps
   * `linearReload` to refetch the issue list. The key lives only in local state — never logged.
   */
  async function handleConnectLinear(): Promise<void> {
    const token = linearToken.trim();
    if (token === '' || connecting) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await subscribeStream(
        'linear:connect',
        { mode: 'apiKey', token },
        (chunk) => {
          if (chunk.kind === 'connected') {
            setLinearToken('');
            setListError(null);
            setLinearReload((k) => k + 1);
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
            {/* Source type tabs */}
            <div className="mb-4">
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

            {/* Harness (shared across all source tabs) */}
            <label className="mb-4 block">
              <span className="mb-1 block text-xs text-fg-2">Harness</span>
              <Select
                value={harness}
                onChange={(e) => setHarness(e.target.value as HarnessId)}
                disabled={isStreaming}
                className="w-full"
                options={HARNESS_OPTIONS}
              />
            </label>

            {/* --- Branch tab --- */}
            {activeTab === 'branch' && (
              <form onSubmit={handleBranchSubmit}>
                <label className="mb-3 block">
                  <span className="mb-1 block text-xs text-fg-2">
                    Base branch{' '}
                    <span className="text-fg-3">
                      (optional, defaults to project default)
                    </span>
                  </span>
                  <Input
                    type="text"
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value)}
                    placeholder="e.g. main"
                    disabled={isStreaming}
                    mono
                    className="w-full"
                  />
                </label>

                <label className="mb-4 block">
                  <span className="mb-1 block text-xs text-fg-2">
                    Branch name{' '}
                    <span className="text-fg-3">
                      (optional, auto-generated if blank)
                    </span>
                  </span>
                  <Input
                    type="text"
                    value={customBranch}
                    onChange={(e) => setCustomBranch(e.target.value)}
                    placeholder="e.g. agent/paris"
                    disabled={isStreaming}
                    mono
                    className="w-full"
                  />
                </label>

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!projectId || isStreaming}
                  >
                    {isStreaming ? 'Creating…' : 'Create'}
                  </Button>
                </div>
              </form>
            )}

            {/* --- From PR / From issue tabs --- */}
            {activeTab !== 'branch' && (
              <div data-testid={`${activeTab}-list`}>
                {listLoading && (
                  <p className="py-4 text-center text-xs text-fg-3">Loading…</p>
                )}

                {/* No-account (or error) empty state — the invoke rejected. GitHub tabs
                    show a static hint; the Linear tab shows an inline connect affordance. */}
                {!listLoading &&
                  listError !== null &&
                  activeTab !== 'linear' && (
                    <div
                      data-testid="github-empty"
                      className="rounded-2 border border-border-1 bg-surface-well px-3 py-4 text-center"
                    >
                      <p className="text-sm text-fg-2">
                        Connect GitHub to list{' '}
                        {activeTab === 'pr' ? 'pull requests' : 'issues'}.
                      </p>
                      <p className="mt-1 text-xs text-fg-3">
                        No GitHub account is connected for this project.
                      </p>
                    </div>
                  )}

                {/* Linear no-account empty state: inline API-key connect. */}
                {!listLoading &&
                  listError !== null &&
                  activeTab === 'linear' && (
                    <div
                      data-testid="linear-connect"
                      className="rounded-2 border border-border-1 bg-surface-well px-3 py-4"
                    >
                      <p className="text-sm text-fg-2">Connect Linear</p>
                      <p className="mt-1 text-xs text-fg-3">
                        Paste a Linear API key (starts with{' '}
                        <code className="text-fg-2">lin_api_</code>) to list
                        your issues.
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Input
                          type="password"
                          value={linearToken}
                          onChange={(e) => setLinearToken(e.target.value)}
                          placeholder="lin_api_…"
                          disabled={connecting}
                          data-testid="linear-token-input"
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="primary"
                          onClick={() => void handleConnectLinear()}
                          disabled={connecting || linearToken.trim() === ''}
                          data-testid="linear-connect-submit"
                        >
                          {connecting ? 'Connecting…' : 'Connect'}
                        </Button>
                      </div>
                      {connectError && (
                        <p
                          data-testid="linear-connect-error"
                          className="mt-2 text-xs text-danger"
                        >
                          {connectError}
                        </p>
                      )}
                    </div>
                  )}

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
                            disabled={isStreaming}
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
                            disabled={isStreaming}
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

                {/* Linear issue list */}
                {!listLoading &&
                  listError === null &&
                  activeTab === 'linear' &&
                  (linearIssues && linearIssues.length > 0 ? (
                    <ul className="max-h-64 space-y-1 overflow-y-auto">
                      {linearIssues.map((issue) => (
                        <li key={issue.id}>
                          <button
                            type="button"
                            disabled={isStreaming}
                            onClick={() => handleSelectLinearIssue(issue)}
                            data-testid="linear-issue-item"
                            data-issue-id={issue.id}
                            className="w-full rounded-2 border border-border-1 bg-surface-well px-3 py-2 text-left transition-colors duration-fast ease-out hover:border-border-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span className="block truncate text-sm text-fg-1">
                              {issue.identifier} · {issue.title}
                            </span>
                            <span className="text-xs text-fg-3">
                              {issue.state ?? 'no state'}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-4 text-center text-xs text-fg-3">
                      No Linear issues.
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
