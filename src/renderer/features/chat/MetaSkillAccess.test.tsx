import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Transcript } from './Transcript';

describe('meta skill access transcript evidence', () => {
  it('renders the exact skill revision made available to the turn', () => {
    render(
      <Transcript
        turns={[
          {
            turnId: 'turn-1',
            status: 'completed',
            events: [
              {
                kind: 'meta_skill_access',
                skills: [{ slug: 'migration-guide', digest: 'a'.repeat(64) }],
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByTestId('meta-skill-access-event')).toHaveTextContent(
      'migration-guide@aaaaaaaaaaaa',
    );
  });
});
