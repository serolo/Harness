import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from './Dialog';

describe('Dialog', () => {
  it('portals the modal layer to the document body', () => {
    const host = document.createElement('div');
    host.className = 'relative z-0';
    document.body.append(host);

    const view = render(
      <Dialog title="Rename workspace" onClose={vi.fn()}>
        Dialog content
      </Dialog>,
      { container: host },
    );

    const panel = screen.getByRole('dialog', { name: 'Rename workspace' });
    const modalLayer = panel.parentElement;

    expect(modalLayer).not.toBeNull();
    expect(modalLayer?.parentElement).toBe(document.body);
    expect(modalLayer).toHaveClass('fixed', 'inset-0', 'z-[100]');

    view.unmount();
    host.remove();
  });
});
