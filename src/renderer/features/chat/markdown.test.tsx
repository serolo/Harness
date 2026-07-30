import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

describe('Markdown', () => {
  it('renders adjacent headings, paragraphs, lists, and tables structurally', () => {
    const { container } = render(
      <Markdown
        text={[
          'Intro paragraph.',
          '',
          '## Shared bug',
          'The explanation follows immediately.',
          '',
          '| Version | Result |',
          '|---|---|',
          '| PR | Correct |',
          '| Local | Incorrect |',
          '',
          '## Differences',
          '- First point',
          '- Second point',
        ].join('\n')}
      />,
    );

    expect(
      screen.getByRole('heading', { level: 2, name: 'Shared bug' }),
    ).toBeInTheDocument();
    expect(container.querySelector('table')).toHaveTextContent(
      'VersionResultPRCorrectLocalIncorrect',
    );
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container).not.toHaveTextContent('## Shared bug');
  });
});
