import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useNavStore } from '@renderer/stores/nav';
import { KnowledgeProposalCard } from './KnowledgeProposalCard';

describe('KnowledgeProposalCard', () => {
  beforeEach(() => useNavStore.setState({ target: null }));

  it('links the completed reconciliation to Knowledge review', () => {
    render(
      <KnowledgeProposalCard
        workspaceId="workspace-1"
        projectId="project-1"
        count={2}
      />,
    );

    expect(screen.getByTestId('knowledge-proposal-card')).toHaveTextContent(
      '2 OKF changes are ready for review',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Review in Knowledge →' }),
    );
    expect(useNavStore.getState().target).toEqual({
      workspaceId: 'workspace-1',
      pane: 'knowledge',
    });
  });

  it('does not render when no change was proposed', () => {
    render(
      <KnowledgeProposalCard
        workspaceId="workspace-1"
        projectId="project-1"
        count={0}
      />,
    );

    expect(
      screen.queryByTestId('knowledge-proposal-card'),
    ).not.toBeInTheDocument();
  });
});
