import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock('@renderer/ipc', () => api);

import { Markdown } from './markdown';

describe('Markdown', () => {
  beforeEach(() => {
    api.invoke.mockClear();
  });

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

  it('opens web links through the system browser instead of an Electron window', () => {
    render(
      <Markdown text="Read the [documentation](https://example.com/docs)." />,
    );

    const link = screen.getByRole('link', { name: 'documentation' });
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });

    expect(link).not.toHaveAttribute('target');
    expect(link.dispatchEvent(click)).toBe(false);
    expect(api.invoke).toHaveBeenCalledWith('external:openUrl', {
      url: 'https://example.com/docs',
    });
  });
});
