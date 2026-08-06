import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Transcript } from './Transcript';

describe('knowledge_retrieval transcript trace', () => {
  it('distinguishes free local search work from snippets and reads added to model context', () => {
    render(
      <Transcript
        turns={[
          {
            turnId: 'turn-1',
            status: 'completed',
            events: [
              {
                kind: 'knowledge_retrieval',
                operation: 'search',
                provider: 'basic',
                resultCount: 3,
                contextTokens: 250,
              },
              {
                kind: 'knowledge_retrieval',
                operation: 'read',
                provider: 'basic',
                path: 'operations/runbook.md',
                contextTokens: 750,
                truncated: true,
              },
            ],
          },
        ]}
      />,
    );

    const cards = screen.getAllByTestId('knowledge-retrieval-event');
    expect(cards).toHaveLength(2);

    expect(
      within(cards[0]).getByText('Project knowledge search'),
    ).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent('local search is free');
    expect(cards[0]).toHaveTextContent('3 results returned');
    expect(cards[0]).toHaveTextContent(
      '~250 context tokens in ranked snippets',
    );
    expect(cards[0]).not.toHaveTextContent('context tokens returned');

    expect(
      within(cards[1]).getByText('Project knowledge read'),
    ).toBeInTheDocument();
    expect(cards[1]).toHaveTextContent('operations/runbook.md');
    expect(cards[1]).toHaveTextContent('~750 context tokens returned');
    expect(cards[1]).toHaveTextContent('truncated to the turn budget');
    expect(cards[1]).not.toHaveTextContent('local search is free');
  });
});
