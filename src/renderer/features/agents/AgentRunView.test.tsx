import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { AgentDispatchSummary, MetaRunDetail } from '@shared/agents';
import { AgentRunView } from './AgentRunView';

function dispatch(
  id: string,
  role: string,
  summary: string,
  purpose: AgentDispatchSummary['purpose'] = 'research',
): AgentDispatchSummary {
  return {
    id,
    runId: 'run-1',
    parentDispatchId: null,
    role,
    purpose,
    childAgentSlug: role,
    workspaceId: `workspace-${id}`,
    branch: `agent/${role}`,
    turnId: `turn-${id}`,
    sessionId: `session-${id}`,
    harness: role.startsWith('claude') ? 'claude_code' : 'codex',
    model: null,
    status: 'completed',
    summary,
    changedFiles: ['src/example.ts'],
    diffStat: '1 file changed',
    error: null,
    startedAt: 1,
    endedAt: 2,
  };
}

function run(overrides: Partial<MetaRunDetail> = {}): MetaRunDetail {
  return {
    id: 'run-1',
    projectId: 'project-1',
    sourceWorkspaceId: 'source',
    coordinatorWorkspaceId: 'coordinator',
    agentId: 'builtin:harness',
    agentName: 'Harness PIV',
    agentRevision: '1234567890abcdef',
    goal: 'Implement safely',
    status: 'running',
    allowPush: false,
    allowOpenPr: false,
    finalSummary: null,
    error: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    dispatches: [],
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('AgentRunView', () => {
  it('shows retained workspace identity, status, results, failures, and active actions', () => {
    const onCancel = vi.fn();
    const onTakeOver = vi.fn();
    render(
      <AgentRunView
        run={run({
          dispatches: [
            dispatch('one', 'coder', 'Implemented the change', 'implement'),
            {
              ...dispatch('two', 'reviewer', '', 'review'),
              status: 'failed',
              error: 'Review provider exited',
            },
          ],
        })}
        onClose={vi.fn()}
        onCancel={onCancel}
        onTakeOver={onTakeOver}
      />,
    );

    expect(screen.getByTestId('agent-dispatch-list')).toHaveTextContent(
      'agent/coder',
    );
    expect(screen.getByText('Implemented the change')).toBeInTheDocument();
    expect(screen.getByText('Review provider exited')).toBeInTheDocument();
    expect(screen.getAllByText('src/example.ts')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onTakeOver).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('renders both Debby partners and critique rounds side-by-side before synthesis', () => {
    render(
      <AgentRunView
        run={run({
          agentId: 'builtin:debby',
          agentName: 'Debby',
          agentProtocol: 'debby',
          status: 'completed',
          dispatches: [
            {
              ...dispatch('one', 'claude-partner', 'Claude answer'),
              debateStage: 'partner',
              debateRound: 0,
            },
            {
              ...dispatch('two', 'codex-partner', 'Codex answer'),
              debateStage: 'partner',
              debateRound: 0,
            },
            {
              ...dispatch(
                'three',
                'claude-critic',
                'Claude critique round one',
                'critique',
              ),
              debateStage: 'critique',
              debateRound: 1,
            },
            {
              ...dispatch(
                'four',
                'codex-critic',
                'Codex critique round one',
                'critique',
              ),
              debateStage: 'critique',
              debateRound: 1,
            },
            {
              ...dispatch(
                'five',
                'claude-critic',
                'Claude critique round two',
                'critique',
              ),
              debateStage: 'critique',
              debateRound: 2,
            },
            {
              ...dispatch(
                'six',
                'codex-critic',
                'Codex critique round two',
                'critique',
              ),
              debateStage: 'critique',
              debateRound: 2,
            },
          ],
          finalSummary: 'Balanced synthesis',
        })}
        onClose={vi.fn()}
        onCancel={vi.fn()}
        onTakeOver={vi.fn()}
      />,
    );

    const comparison = screen.getByTestId('debby-comparison');
    expect(comparison).toHaveTextContent('Claude answer');
    expect(comparison).toHaveTextContent('Codex answer');
    const roundOne = screen.getByRole('heading', {
      name: 'Critique round 1',
    }).parentElement;
    const roundTwo = screen.getByRole('heading', {
      name: 'Critique round 2',
    }).parentElement;
    expect(roundOne).toHaveTextContent('Claude critique round one');
    expect(roundOne).toHaveTextContent('Codex critique round one');
    expect(roundOne).not.toHaveTextContent('round two');
    expect(roundTwo).toHaveTextContent('Claude critique round two');
    expect(roundTwo).toHaveTextContent('Codex critique round two');
    expect(roundTwo).not.toHaveTextContent('round one');
    expect(screen.getByText('Balanced synthesis')).toBeInTheDocument();
    expect(
      screen
        .getByRole('heading', { name: 'Synthesis' })
        .compareDocumentPosition(
          screen.getByRole('heading', { name: 'Critique round 2' }),
        ) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('renders provider output as inert plain text', () => {
    const payload = '<img src=x onerror="globalThis.compromised=true">';
    const { container } = render(
      <AgentRunView
        run={run({ dispatches: [dispatch('one', 'coder', payload)] })}
        onClose={vi.fn()}
        onCancel={vi.fn()}
        onTakeOver={vi.fn()}
      />,
    );

    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
