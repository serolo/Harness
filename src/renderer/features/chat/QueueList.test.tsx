// QueueList (Phase 9) — the presentational follow-up queue rendered above the Composer.
// Runs under jsdom via @testing-library/react (mirrors ChatPanel.test.tsx's fireEvent
// style). The component owns NO IPC; it calls back with the derived intent (new prompt,
// the reordered id list, the id to delete, the message to steer). These tests pin that
// callback wiring + the reorder-button disabled edges.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { QueueList } from './QueueList';
import type { QueuedMessage } from '@shared/queue';

function msg(id: string, prompt: string, orderIdx: number): QueuedMessage {
  return {
    id,
    workspaceId: 'ws1',
    prompt,
    attachments: [],
    orderIdx,
    createdAt: orderIdx,
  };
}

const THREE: QueuedMessage[] = [
  msg('a', 'first', 0),
  msg('b', 'second', 1),
  msg('c', 'third', 2),
];

interface Handlers {
  onEdit: ReturnType<typeof vi.fn>;
  onReorder: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
  onSteerNow: ReturnType<typeof vi.fn>;
}

function renderList(messages: QueuedMessage[]): Handlers {
  const handlers: Handlers = {
    onEdit: vi.fn(),
    onReorder: vi.fn(),
    onDelete: vi.fn(),
    onSteerNow: vi.fn(),
  };
  render(<QueueList messages={messages} {...handlers} />);
  return handlers;
}

describe('QueueList rendering', () => {
  it('renders one row per message', () => {
    renderList(THREE);
    expect(screen.getByTestId('queue-list')).toBeInTheDocument();
    expect(screen.getAllByTestId('queue-row')).toHaveLength(3);
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('third')).toBeInTheDocument();
  });

  it('renders nothing for an empty queue', () => {
    const { container } = render(
      <QueueList
        messages={[]}
        onEdit={vi.fn()}
        onReorder={vi.fn()}
        onDelete={vi.fn()}
        onSteerNow={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('queue-list')).not.toBeInTheDocument();
  });
});

describe('QueueList inline edit', () => {
  it('edit → type → save calls onEdit(id, newPrompt)', () => {
    const h = renderList(THREE);
    // The first row's edit button.
    const editButtons = screen.getAllByTestId('queue-edit');
    fireEvent.click(editButtons[0]);

    const input = screen.getByTestId('queue-edit-input');
    fireEvent.change(input, { target: { value: 'first edited' } });
    fireEvent.click(screen.getByTestId('queue-edit-save'));

    expect(h.onEdit).toHaveBeenCalledTimes(1);
    expect(h.onEdit).toHaveBeenCalledWith('a', 'first edited');
  });

  it('edit → type → Enter also calls onEdit(id, newPrompt)', () => {
    const h = renderList(THREE);
    fireEvent.click(screen.getAllByTestId('queue-edit')[1]);
    const input = screen.getByTestId('queue-edit-input');
    fireEvent.change(input, { target: { value: 'second edited' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(h.onEdit).toHaveBeenCalledWith('b', 'second edited');
  });
});

describe('QueueList reorder', () => {
  it('queue-up on the 2nd row swaps it above the 1st', () => {
    const h = renderList(THREE);
    // Row index 1 (second) — move up swaps b above a.
    const upButtons = screen.getAllByTestId('queue-up');
    fireEvent.click(upButtons[1]);

    expect(h.onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('queue-down on the 1st row swaps it below the 2nd', () => {
    const h = renderList(THREE);
    const downButtons = screen.getAllByTestId('queue-down');
    fireEvent.click(downButtons[0]);

    expect(h.onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('disables queue-up on the first row and queue-down on the last', () => {
    renderList(THREE);
    expect(screen.getAllByTestId('queue-up')[0]).toBeDisabled();
    expect(screen.getAllByTestId('queue-down')[2]).toBeDisabled();
    // Interior rows have both enabled.
    expect(screen.getAllByTestId('queue-up')[1]).not.toBeDisabled();
    expect(screen.getAllByTestId('queue-down')[1]).not.toBeDisabled();
  });
});

describe('QueueList delete + steer', () => {
  it('queue-delete calls onDelete(id)', () => {
    const h = renderList(THREE);
    fireEvent.click(screen.getAllByTestId('queue-delete')[2]);
    expect(h.onDelete).toHaveBeenCalledWith('c');
  });

  it('queue-steer calls onSteerNow with the full message', () => {
    const h = renderList(THREE);
    fireEvent.click(screen.getAllByTestId('queue-steer')[0]);
    expect(h.onSteerNow).toHaveBeenCalledTimes(1);
    expect(h.onSteerNow).toHaveBeenCalledWith(THREE[0]);
  });
});
