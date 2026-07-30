import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KnowledgeContextCard } from './KnowledgeContextCard';

describe('KnowledgeContextCard', () => {
  it('shows the selected knowledge sources on demand', () => {
    render(
      <KnowledgeContextCard
        sources={[
          {
            path: 'index.md',
            title: 'Project knowledge',
            estimatedTokens: 312,
          },
          {
            path: 'architecture/api.md',
            title: 'API architecture',
            estimatedTokens: 1_204,
          },
        ]}
      />,
    );

    const toggle = screen.getByRole('button', {
      name: 'Knowledge used (2) · ~1,516 tokens',
    });
    expect(toggle).toHaveTextContent('~1,516 tokens');
    expect(screen.queryByText('API architecture')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(
      screen.getByText("Included in this turn's context"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/selected these project knowledge files/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/actual usage varies by model/),
    ).toBeInTheDocument();
    expect(screen.getByText('~312 tokens')).toBeInTheDocument();
    expect(screen.getByText('~1,204 tokens')).toBeInTheDocument();
    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(screen.getByText('Source 2')).toBeInTheDocument();
    expect(screen.getByText('API architecture')).toBeInTheDocument();
    expect(screen.getByText('architecture')).toBeInTheDocument();
    expect(screen.getByText('api.md')).toHaveAttribute(
      'title',
      'architecture/api.md',
    );
    expect(screen.getByText('Project knowledge root')).toBeInTheDocument();
    expect(screen.getByText('index.md')).toHaveAttribute('title', 'index.md');
  });
});
