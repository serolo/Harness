import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { KnowledgeExtractionEvent } from '@shared/harness';
import { Transcript } from './Transcript';

describe('post-turn knowledge outcome', () => {
  it.each([
    ['failed', 'Failed to extract knowledge'],
    ['proposed', '1 proposal(s) awaiting review'],
    ['no_proposals', 'The agent returned no knowledge proposal'],
    ['disabled', 'Disabled for this project'],
    ['skipped', 'Skipped: no eligible repository changes'],
  ] as const)(
    'renders %s without implying an automatic commit',
    (status, message) => {
      const event: KnowledgeExtractionEvent = {
        kind: 'knowledge_extraction',
        status,
        proposalCount: status === 'proposed' ? 1 : 0,
        rejectedCount: 0,
      };
      render(
        <Transcript
          turns={[{ turnId: 'turn', status: 'completed', events: [event] }]}
        />,
      );
      expect(
        screen.getByTestId('knowledge-extraction-event'),
      ).toHaveTextContent(message);
    },
  );

  it('shows validation failures alongside successful pending proposals', () => {
    render(
      <Transcript
        turns={[
          {
            turnId: 'turn',
            status: 'completed',
            events: [
              {
                kind: 'knowledge_extraction',
                status: 'proposed',
                proposalCount: 1,
                rejectedCount: 2,
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByTestId('knowledge-extraction-event')).toHaveTextContent(
      '2 proposal(s) rejected during validation',
    );
    expect(screen.getByTestId('knowledge-extraction-event')).toHaveTextContent(
      'Approve in Project knowledge to commit',
    );
  });
});
