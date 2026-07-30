// TasksPanel — the "Tasks" center-tab view for the selected workspace (Phase 12). Wires
// `useTasks(workspaceId)` to the list of TaskRows + a "New task" button + the TaskForm
// dialog (create / edit / reschedule). Fetches the effective `agent.mode` once so the
// form can label the "Workspace default" option. All main access happens inside
// `useTasks` / a one-shot `settings:getEffective`, via `@renderer/ipc`.

import { useEffect, useState } from 'react';
import { CircleCheck, CircleOff, History, Plus } from 'lucide-react';
import type { AgentMode } from '@shared/harness';
import type { ScheduledTask } from '@shared/tasks';
import type {
  KnowledgeConfig,
  WikiHistoryEntry,
  WikiPage,
  WikiPageSummary,
  WikiProposal,
} from '@shared/knowledge';
import { invoke } from '@renderer/ipc';
import { Button } from '@renderer/components/ui';
import { useTasks } from './useTasks';
import { TaskRow } from './TaskRow';
import { TaskForm, type TaskFormValues } from './TaskForm';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { KnowledgeFolderBrowser } from '../knowledge/KnowledgeFolderBrowser';
import { Markdown } from '../chat/markdown';

export interface TasksPanelProps {
  workspaceId: string | null;
  projectId?: string | null;
  knowledgeReviewRequestId?: number;
}

/** The open form dialog: create, or edit a specific task (optionally on the schedule field). */
type FormState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; task: ScheduledTask; focusSchedule: boolean };

export function TasksPanel({
  workspaceId,
  projectId = null,
  knowledgeReviewRequestId = 0,
}: TasksPanelProps): React.JSX.Element {
  const { tasks, loading, error, updateTask, deleteTask, runNow, markDone } =
    useTasks(workspaceId);
  const [form, setForm] = useState<FormState>({ kind: 'closed' });
  const [defaultMode, setDefaultMode] = useState<AgentMode | undefined>();
  const [activeTab, setActiveTab] = useState<'tasks' | 'knowledge'>('tasks');
  const [expandedKnowledgeFolders, setExpandedKnowledgeFolders] = useState<
    Set<string>
  >(() => new Set());
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const projects = useWorkspacesStore((state) => state.projects);

  useEffect(() => {
    setExpandedKnowledgeFolders(new Set());
  }, [projectId]);

  useEffect(() => {
    if (knowledgeReviewRequestId > 0) setActiveTab('knowledge');
  }, [knowledgeReviewRequestId]);

  // Fetch the effective agent.mode once, for the form's "Workspace default (…)" label.
  useEffect(() => {
    let active = true;
    void invoke('settings:getEffective', undefined)
      .then((s) => {
        if (active) setDefaultMode(s.agent.mode);
      })
      .catch(() => {
        /* the label just omits the resolved mode on failure */
      });
    return () => {
      active = false;
    };
  }, []);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
        data-testid="tasks-empty-workspace"
      >
        Select a workspace to view its tasks.
      </div>
    );
  }

  async function handleSubmit(values: TaskFormValues): Promise<void> {
    if (form.kind === 'edit') {
      await updateTask({
        id: form.task.id,
        prompt: values.prompt,
        model: values.model,
        mode: values.mode,
        scheduledAt: values.scheduledAt,
        harnessOverride: values.harnessOverride,
      });
    } else {
      // Create: the request type uses optional fields (no null), so map null → undefined.
      await invoke('task:create', {
        workspaceId: values.workspaceId,
        prompt: values.prompt,
        model: values.model ?? undefined,
        mode: values.mode ?? undefined,
        scheduledAt: values.scheduledAt ?? undefined,
        harnessOverride: values.harnessOverride ?? undefined,
      });
    }
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-surface-app"
      data-testid="tasks-panel"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-1 bg-surface-panel px-3">
        <div
          className="flex h-full items-end"
          role="tablist"
          aria-label="Workspace tools"
        >
          <WorkspaceToolTab
            active={activeTab === 'tasks'}
            label="Tasks"
            testId="workspace-tab-tasks"
            onClick={() => setActiveTab('tasks')}
          />
          <WorkspaceToolTab
            active={activeTab === 'knowledge'}
            label="Knowledge"
            testId="workspace-tab-knowledge"
            onClick={() => setActiveTab('knowledge')}
          />
        </div>
        {activeTab === 'tasks' ? (
          <Button
            variant="primary"
            size="sm"
            data-testid="task-new"
            onClick={() => setForm({ kind: 'create' })}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New task
          </Button>
        ) : null}
      </div>

      {activeTab === 'knowledge' ? (
        <WorkspaceKnowledgeStatus
          projectId={projectId}
          reviewRequestId={knowledgeReviewRequestId}
          expandedFolders={expandedKnowledgeFolders}
          onExpandedFoldersChange={setExpandedKnowledgeFolders}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div
              className="flex h-full items-center justify-center p-6 text-sm text-danger"
              data-testid="tasks-error"
            >
              Could not load tasks.
            </div>
          ) : loading && tasks.length === 0 ? (
            <div
              className="flex h-full items-center justify-center p-6 text-sm text-fg-3"
              data-testid="tasks-loading"
            >
              Loading tasks…
            </div>
          ) : tasks.length === 0 ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-fg-3"
              data-testid="tasks-empty"
            >
              <p>No tasks yet.</p>
              <p className="text-2xs">
                Create a task to run a prompt on a schedule, or on demand.
              </p>
            </div>
          ) : (
            tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onRunNow={(id) => void runNow(id)}
                onMarkDone={(id) => void markDone(id)}
                onEdit={(t, focusSchedule) =>
                  setForm({
                    kind: 'edit',
                    task: t,
                    focusSchedule: focusSchedule ?? false,
                  })
                }
                onDelete={(id) => void deleteTask(id)}
              />
            ))
          )}
        </div>
      )}

      {form.kind !== 'closed' ? (
        <TaskForm
          mode={form.kind === 'create' ? 'create' : 'edit'}
          initial={form.kind === 'edit' ? form.task : undefined}
          focusSchedule={form.kind === 'edit' ? form.focusSchedule : false}
          defaultAgentMode={defaultMode}
          workspaceId={workspaceId}
          workspaces={workspaces}
          projects={projects}
          onSubmit={handleSubmit}
          onClose={() => setForm({ kind: 'closed' })}
        />
      ) : null}
    </div>
  );
}

function WorkspaceToolTab({
  active,
  label,
  testId,
  onClick,
}: {
  active: boolean;
  label: string;
  testId: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testId}
      onClick={onClick}
      className={`h-full border-b-2 px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${
        active
          ? 'border-accent text-fg-1'
          : 'border-transparent text-fg-3 hover:text-fg-1'
      }`}
    >
      {label}
    </button>
  );
}

function WorkspaceKnowledgeStatus({
  projectId,
  reviewRequestId,
  expandedFolders,
  onExpandedFoldersChange,
}: {
  projectId: string | null;
  reviewRequestId: number;
  expandedFolders: ReadonlySet<string>;
  onExpandedFoldersChange: (folders: Set<string>) => void;
}): React.JSX.Element {
  const [config, setConfig] = useState<KnowledgeConfig | null>(null);
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [selectedPage, setSelectedPage] = useState<WikiPage | null>(null);
  const [knowledgeView, setKnowledgeView] = useState<
    'content' | 'review' | 'history'
  >('content');
  const [history, setHistory] = useState<WikiHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [proposals, setProposals] = useState<WikiProposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [proposalsError, setProposalsError] = useState(false);
  const [approvingProposalId, setApprovingProposalId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setConfig(null);
    setPages([]);
    setSelectedPage(null);
    setKnowledgeView('content');
    setHistory([]);
    setHistoryError(false);
    setProposals([]);
    setProposalsError(false);
    setError(false);
    if (projectId === null) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void invoke('knowledge:config', { projectId })
      .then(async (nextConfig) => {
        if (!active) return;
        setConfig(nextConfig);
        if (nextConfig.enabled) {
          await invoke('knowledge:initialize', { projectId });
          const nextPages = await invoke('knowledge:listPages', { projectId });
          if (active) setPages(nextPages);
        }
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const openPage = (path: string): void => {
    if (projectId === null) return;
    void invoke('knowledge:getPage', { projectId, path })
      .then(setSelectedPage)
      .catch(() => setError(true));
  };

  const openHistory = (): void => {
    setKnowledgeView('history');
    setSelectedPage(null);
    if (projectId === null || history.length > 0 || historyLoading) return;
    setHistoryError(false);
    setHistoryLoading(true);
    void invoke('knowledge:history', { projectId })
      .then(setHistory)
      .catch(() => setHistoryError(true))
      .finally(() => setHistoryLoading(false));
  };

  const loadProposals = (): void => {
    if (projectId === null || proposalsLoading) return;
    setProposalsError(false);
    setProposalsLoading(true);
    void invoke('knowledge:listProposals', { projectId })
      .then((items) =>
        setProposals(
          items.filter((proposal) => proposal.status === 'pending_review'),
        ),
      )
      .catch(() => setProposalsError(true))
      .finally(() => setProposalsLoading(false));
  };

  const openReview = (): void => {
    setKnowledgeView('review');
    setSelectedPage(null);
    loadProposals();
  };

  const approveProposal = (proposalId: string): void => {
    if (projectId === null) return;
    setApprovingProposalId(proposalId);
    void invoke('knowledge:acceptProposal', { projectId, proposalId })
      .then(async () => {
        const [nextPages, nextProposals] = await Promise.all([
          invoke('knowledge:listPages', { projectId }),
          invoke('knowledge:listProposals', { projectId }),
        ]);
        setPages(nextPages);
        setProposals(
          nextProposals.filter(
            (proposal) => proposal.status === 'pending_review',
          ),
        );
        setHistory([]);
      })
      .catch(() => setProposalsError(true))
      .finally(() => setApprovingProposalId(null));
  };

  const rejectProposal = (proposalId: string, reason: string): void => {
    if (projectId === null) return;
    setApprovingProposalId(proposalId);
    void invoke('knowledge:rejectProposal', {
      projectId,
      proposalId,
      reason: reason.trim() || undefined,
    })
      .then(() =>
        setProposals((current) =>
          current.filter((proposal) => proposal.id !== proposalId),
        ),
      )
      .catch(() => setProposalsError(true))
      .finally(() => setApprovingProposalId(null));
  };

  useEffect(() => {
    if (reviewRequestId > 0 && config?.enabled) openReview();
    // The request id is the navigation trigger; config gates the initial async load.
  }, [reviewRequestId, config?.enabled]);

  if (projectId === null) {
    return (
      <KnowledgeMessage
        icon={CircleOff}
        title="No project selected"
        body="Select a workspace to check project knowledge."
      />
    );
  }
  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-5 text-xs text-fg-3">
        Checking project knowledge…
      </div>
    );
  }
  if (error) {
    return (
      <KnowledgeMessage
        icon={CircleOff}
        title="Knowledge unavailable"
        body="Harness could not check this project's knowledge system."
      />
    );
  }
  if (!config?.enabled) {
    return (
      <KnowledgeMessage
        icon={CircleOff}
        title="Knowledge is disabled"
        body="Enable it from Settings → Repo → Project knowledge."
      />
    );
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto bg-surface-app p-3"
      data-testid="workspace-knowledge-available"
    >
      <div className="mb-3 flex items-center gap-2 rounded-2 border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
        <CircleCheck className="h-4 w-4 shrink-0" aria-hidden />
        Available · OKF {config.format.version} · {pages.length} pages
      </div>
      <div
        className="mb-3 flex border-b border-border-1"
        role="tablist"
        aria-label="Knowledge views"
      >
        <button
          type="button"
          role="tab"
          aria-selected={knowledgeView === 'content'}
          data-testid="knowledge-view-content"
          className={`border-b-2 px-3 py-2 text-xs font-semibold ${
            knowledgeView === 'content'
              ? 'border-accent text-fg-1'
              : 'border-transparent text-fg-3 hover:text-fg-1'
          }`}
          onClick={() => setKnowledgeView('content')}
        >
          Content
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={knowledgeView === 'review'}
          data-testid="knowledge-view-review"
          className={`border-b-2 px-3 py-2 text-xs font-semibold ${
            knowledgeView === 'review'
              ? 'border-accent text-fg-1'
              : 'border-transparent text-fg-3 hover:text-fg-1'
          }`}
          onClick={openReview}
        >
          Review
          {proposals.length > 0 ? ` (${proposals.length})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={knowledgeView === 'history'}
          data-testid="knowledge-view-history"
          className={`border-b-2 px-3 py-2 text-xs font-semibold ${
            knowledgeView === 'history'
              ? 'border-accent text-fg-1'
              : 'border-transparent text-fg-3 hover:text-fg-1'
          }`}
          onClick={openHistory}
        >
          History
        </button>
      </div>
      {knowledgeView === 'content' && selectedPage ? (
        <button
          type="button"
          onClick={() => setSelectedPage(null)}
          className="mb-2 text-xs text-accent hover:underline"
        >
          ← All pages
        </button>
      ) : null}
      {knowledgeView === 'review' ? (
        <KnowledgeProposalReview
          proposals={proposals}
          loading={proposalsLoading}
          error={proposalsError}
          approvingProposalId={approvingProposalId}
          onApprove={approveProposal}
          onReject={rejectProposal}
        />
      ) : knowledgeView === 'history' ? (
        <KnowledgeHistory
          entries={history}
          loading={historyLoading}
          error={historyError}
        />
      ) : selectedPage ? (
        <div className="rounded-2 border border-border-1 bg-surface-panel p-3">
          <div className="text-sm font-semibold text-fg-1">
            {selectedPage.title}
          </div>
          <div className="mt-1 text-2xs text-fg-3">
            {selectedPage.type} · {selectedPage.path}
          </div>
          <div className="mt-3">
            <Markdown text={selectedPage.body} />
          </div>
        </div>
      ) : (
        <KnowledgeFolderBrowser
          pages={pages}
          onOpenPage={openPage}
          compact
          expandedFolders={expandedFolders}
          onExpandedFoldersChange={onExpandedFoldersChange}
        />
      )}
    </div>
  );
}

function KnowledgeProposalReview({
  proposals,
  loading,
  error,
  approvingProposalId,
  onApprove,
  onReject,
}: {
  proposals: WikiProposal[];
  loading: boolean;
  error: boolean;
  approvingProposalId: string | null;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string, reason: string) => void;
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="py-8 text-center text-xs text-fg-3">
        Loading proposed changes…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2 border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
        Proposed knowledge changes could not be loaded.
      </div>
    );
  }
  if (proposals.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-fg-3">
        No knowledge changes need review.
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="knowledge-proposal-list">
      {proposals.map((proposal) => (
        <KnowledgeProposalItem
          key={proposal.id}
          proposal={proposal}
          busy={approvingProposalId !== null}
          approving={approvingProposalId === proposal.id}
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}
    </div>
  );
}

function KnowledgeProposalItem({
  proposal,
  busy,
  approving,
  onApprove,
  onReject,
}: {
  proposal: WikiProposal;
  busy: boolean;
  approving: boolean;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string, reason: string) => void;
}): React.JSX.Element {
  const [reason, setReason] = useState('');
  return (
    <section className="rounded-2 border border-border-1 bg-surface-panel p-3">
      <h3 className="text-sm font-semibold text-fg-1">{proposal.title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-fg-2">
        {proposal.summary}
      </p>
      <ul className="mt-3 space-y-1">
        {proposal.operations.map((operation, index) => (
          <li key={index} className="font-mono text-2xs text-fg-3">
            {operation.op === 'move'
              ? `${operation.op}: ${operation.from} → ${operation.to}`
              : `${operation.op}: ${operation.path}`}
          </li>
        ))}
      </ul>
      <label className="mt-3 block text-xs text-fg-2">
        Rejection reason
        <textarea
          aria-label={`Rejection reason for ${proposal.title}`}
          className="mt-1 w-full rounded-2 border border-border-1 bg-bg-3 px-3 py-2 text-xs text-fg-1"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => onApprove(proposal.id)}
        >
          {approving ? 'Saving…' : 'Approve changes'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => onReject(proposal.id, reason)}
        >
          Reject
        </Button>
      </div>
    </section>
  );
}

function KnowledgeHistory({
  entries,
  loading,
  error,
}: {
  entries: WikiHistoryEntry[];
  loading: boolean;
  error: boolean;
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="py-8 text-center text-xs text-fg-3">
        Loading knowledge history…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2 border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
        Knowledge history could not be loaded.
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-fg-3">
        No knowledge changes yet.
      </div>
    );
  }
  return (
    <ol className="space-y-2" data-testid="knowledge-history-list">
      {entries.map((entry) => (
        <li
          key={entry.commit}
          className="rounded-2 border border-border-1 bg-surface-panel px-3 py-3"
        >
          <div className="flex min-w-0 items-start gap-2">
            <History
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-3"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg-1">{entry.subject}</p>
              <p className="mt-1 text-2xs text-fg-3">
                {entry.author} ·{' '}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(entry.timestamp)}
              </p>
            </div>
            <code className="shrink-0 text-2xs text-fg-3">
              {entry.commit.slice(0, 7)}
            </code>
          </div>
        </li>
      ))}
    </ol>
  );
}

function KnowledgeMessage({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof CircleOff;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center"
      data-testid="workspace-knowledge-unavailable"
    >
      <Icon className="h-6 w-6 text-fg-3" aria-hidden />
      <p className="mt-2 text-sm font-medium text-fg-2">{title}</p>
      <p className="mt-1 text-xs text-fg-3">{body}</p>
    </div>
  );
}
