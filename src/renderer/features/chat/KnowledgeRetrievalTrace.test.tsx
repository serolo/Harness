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

  it('numbers multiple search attempts so equal results do not look duplicated', () => {
    render(
      <Transcript
        turns={[
          {
            turnId: 'turn-retried-search',
            status: 'completed',
            events: [
              {
                kind: 'tool_use',
                name: 'mcp__harness-project-knowledge__search_project_knowledge',
                input: { query: 'ProfileHub Power BI reports FCM' },
              },
              {
                kind: 'tool_result',
                output: '{"provider":"qmd","results":[]}',
              },
              {
                kind: 'tool_use',
                name: 'mcp__harness-project-knowledge__search_project_knowledge',
                input: { query: 'company settings profile hub' },
              },
              {
                kind: 'tool_result',
                output: '{"provider":"qmd","results":[]}',
              },
              {
                kind: 'knowledge_retrieval',
                operation: 'search',
                provider: 'qmd',
                resultCount: 0,
                contextTokens: 19,
              },
              {
                kind: 'knowledge_retrieval',
                operation: 'search',
                provider: 'qmd',
                resultCount: 0,
                contextTokens: 19,
              },
            ],
          },
        ]}
      />,
    );

    const cards = screen.getAllByTestId('knowledge-retrieval-event');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Project knowledge search 1 of 2');
    expect(cards[1]).toHaveTextContent('Project knowledge search 2 of 2');
    expect(cards[0]).toHaveTextContent(
      'Looking for: ProfileHub Power BI reports FCM',
    );
    expect(cards[1]).toHaveTextContent(
      'Looking for: company settings profile hub',
    );
  });

  it('distinguishes available-but-unused knowledge from used and failed outcomes', () => {
    render(
      <Transcript
        turns={[
          {
            turnId: 'turn-unused',
            status: 'completed',
            events: [
              {
                kind: 'knowledge_status',
                status: 'unused',
                provider: 'qmd',
                reason: 'unused',
              },
            ],
          },
          {
            turnId: 'turn-read',
            status: 'completed',
            events: [
              {
                kind: 'knowledge_status',
                status: 'read',
                provider: 'basic',
              },
            ],
          },
          {
            turnId: 'turn-failed',
            status: 'completed',
            events: [
              {
                kind: 'knowledge_status',
                status: 'failed',
                provider: 'qmd',
                reason: 'gateway',
              },
            ],
          },
        ]}
      />,
    );

    const cards = screen.getAllByTestId('knowledge-status-event');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent(
      'Knowledge was available but not consulted',
    );
    expect(cards[1]).toHaveTextContent('Knowledge was used');
    expect(cards[2]).toHaveTextContent(
      'Knowledge retrieval encountered an error; the turn continued',
    );
  });
});
