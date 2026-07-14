import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { TerminalPanel } from './TerminalPanel';
import { useTerminalStore } from './terminalStore';

vi.mock('./TerminalTab', () => ({
  TerminalTab: ({ tabId }: { tabId: string }) => (
    <div data-testid={`terminal-surface-${tabId}`} />
  ),
}));

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  const api: ApiStub = {
    invoke: vi.fn((channel: string) =>
      Promise.resolve(channel === 'run:list' ? [] : undefined),
    ),
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  useTerminalStore.setState({
    tabsByWorkspace: {},
    activeTabByWorkspace: {},
    bigTerminal: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('TerminalPanel', () => {
  it('uses a compact tab bar for creating and collapsing terminals', async () => {
    const onToggleCollapsed = vi.fn();
    render(
      <TerminalPanel
        workspaceId="ws1"
        collapsed={false}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );

    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
    expect(screen.queryByText('Big Terminal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-panel')).not.toBeInTheDocument();
    expect(useTerminalStore.getState().tabsByWorkspace.ws1).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('New terminal'));
    expect(screen.getByText('Terminal 2')).toBeInTheDocument();
    expect(useTerminalStore.getState().tabsByWorkspace.ws1).toHaveLength(2);

    fireEvent.click(screen.getByLabelText('Collapse terminal section'));
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });
});
