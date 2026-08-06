import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import type {
  MetaAgentDetail,
  MetaAgentSummary,
  MetaRunDetail,
} from '@shared/agents';
import { AgentsPanel } from './AgentsPanel';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

const builtin: MetaAgentSummary = {
  id: 'builtin:polly',
  projectId: null,
  slug: 'polly',
  origin: 'builtin',
  name: 'Polly',
  description: 'Independent implementation and review',
  revision: 'abcdef123456',
  valid: true,
  diagnostics: [],
  requiredProviders: ['claude_code', 'codex'],
  capabilities: ['delegate'],
  available: true,
  unavailableReasons: [],
  editable: false,
};
const custom: MetaAgentSummary = {
  ...builtin,
  id: 'project:project-1:custom',
  projectId: 'project-1',
  slug: 'custom',
  origin: 'project',
  name: 'Custom',
  editable: true,
};

function detail(agent: MetaAgentSummary): MetaAgentDetail {
  return { ...agent, files: ['config.yaml'] };
}

function run(): MetaRunDetail {
  return {
    id: 'run-1',
    projectId: 'project-1',
    sourceWorkspaceId: 'workspace-1',
    coordinatorWorkspaceId: 'coordinator',
    agentId: builtin.id,
    agentName: builtin.name,
    agentRevision: builtin.revision,
    goal: 'Do work',
    status: 'running',
    allowPush: false,
    allowOpenPr: false,
    finalSummary: null,
    error: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    dispatches: [],
  };
}

function installApi(agents: MetaAgentSummary[] = [builtin, custom]) {
  const listeners: Record<string, (payload: { projectId: string }) => void> =
    {};
  const off = vi.fn();
  const invoke = vi.fn((channel: string) => {
    switch (channel) {
      case 'metaAgent:list':
        return Promise.resolve(agents);
      case 'metaRun:list':
        return Promise.resolve([]);
      case 'metaAgent:get':
        return Promise.resolve(detail(agents[0] ?? builtin));
      case 'metaAgent:duplicate':
      case 'metaAgent:create':
        return Promise.resolve(detail(custom));
      case 'metaAgent:delete':
      case 'metaAgent:import':
        return Promise.resolve(undefined);
      case 'metaAgent:startRun':
      case 'metaRun:get':
      case 'metaRun:cancel':
      case 'metaRun:takeOver':
        return Promise.resolve(run());
      default:
        return Promise.resolve(undefined);
    }
  });
  const api: ApiStub = {
    invoke,
    on: vi.fn(
      (event: string, listener: (payload: { projectId: string }) => void) => {
        listeners[event] = listener;
        return off;
      },
    ),
    stream: vi.fn(),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return { api, listeners, off };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('AgentsPanel', () => {
  it('shows the no-workspace boundary without querying privileged APIs', () => {
    const { api } = installApi();
    render(<AgentsPanel projectId={null} workspaceId={null} />);
    expect(screen.getByText(/Select a workspace/)).toBeInTheDocument();
    expect(api.invoke).not.toHaveBeenCalled();
  });

  it('renders immutable built-ins, editable custom agents, and provider diagnostics', async () => {
    const unavailable = {
      ...builtin,
      available: false,
      unavailableReasons: ['codex is not installed and authenticated'],
    };
    installApi([unavailable, custom]);
    render(<AgentsPanel projectId="project-1" workspaceId="workspace-1" />);

    expect(await screen.findByTestId('agent-polly')).toHaveTextContent(
      'builtin',
    );
    expect(screen.getByTestId('agent-polly')).toHaveTextContent(
      'codex is not installed and authenticated',
    );
    expect(
      screen
        .getByTestId('agent-polly')
        .querySelector('button:nth-last-child(1)'),
    ).not.toHaveTextContent('Delete');
    expect(screen.getByTestId('agent-custom')).toHaveTextContent('project');
    expect(screen.getByTestId('agent-custom')).toHaveTextContent('Delete');
    expect(
      screen.getByTestId('agent-polly').querySelector('button[disabled]'),
    ).toHaveTextContent('Run');
  });

  it('duplicates built-ins and starts runs only after a non-empty goal', async () => {
    const { api } = installApi([builtin]);
    render(<AgentsPanel projectId="project-1" workspaceId="workspace-1" />);
    await screen.findByText('Polly');

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('metaAgent:duplicate', {
        projectId: 'project-1',
        agentId: 'builtin:polly',
        slug: 'polly-copy',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Run goal'), {
      target: { value: 'Implement the ticket' },
    });
    fireEvent.change(screen.getByLabelText('Max dispatches'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Max parallel'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByLabelText(/Open draft pull requests/));
    expect(
      screen.getByLabelText(/Push completed child branches/),
    ).toBeChecked();
    expect(screen.getByText(/Merging is never delegated/)).toBeInTheDocument();
    fireEvent.click(start);
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('metaAgent:startRun', {
        projectId: 'project-1',
        agentId: 'builtin:polly',
        sourceWorkspaceId: 'workspace-1',
        goal: 'Implement the ticket',
        allowPush: true,
        allowOpenPr: true,
        policy: { maxDispatches: 2, maxParallel: 2 },
      }),
    );
    expect(await screen.findByText('Polly run')).toBeInTheDocument();
  });

  it('refetches matching events and unregisters both listeners on unmount', async () => {
    const { api, listeners, off } = installApi();
    const view = render(
      <AgentsPanel projectId="project-1" workspaceId="workspace-1" />,
    );
    await screen.findByText('Polly');
    const before = api.invoke.mock.calls.filter(
      ([channel]) => channel === 'metaAgent:list',
    ).length;
    act(() => listeners['metaAgent:changed']?.({ projectId: 'other-project' }));
    act(() => listeners['metaAgent:changed']?.({ projectId: 'project-1' }));
    await waitFor(() =>
      expect(
        api.invoke.mock.calls.filter(
          ([channel]) => channel === 'metaAgent:list',
        ).length,
      ).toBe(before + 1),
    );

    view.unmount();
    expect(off).toHaveBeenCalledTimes(2);
  });

  it('renders empty, invalid, and load-error states', async () => {
    const empty = installApi([]);
    const view = render(
      <AgentsPanel projectId="project-1" workspaceId="workspace-1" />,
    );
    expect(await screen.findByText('No agents available.')).toBeInTheDocument();
    view.unmount();
    empty.api.invoke.mockRejectedValue(new Error('Registry offline'));
    render(<AgentsPanel projectId="project-1" workspaceId="workspace-1" />);
    expect(await screen.findByText('Registry offline')).toBeInTheDocument();
  });
});
