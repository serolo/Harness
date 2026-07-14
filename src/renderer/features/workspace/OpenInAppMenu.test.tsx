import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@renderer/app/providers';
import { OpenInAppMenu } from './OpenInAppMenu';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

function installApi(): ApiStub {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'workspace:listOpenApps') {
      return Promise.resolve([
        { id: 'finder', label: 'Finder', kind: 'finder' },
        { id: 'vscode', label: 'Visual Studio Code', kind: 'editor' },
      ]);
    }
    return Promise.resolve(undefined);
  });
  const api = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

function renderMenu(workspaceId: string | null): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <OpenInAppMenu workspaceId={workspaceId} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('OpenInAppMenu', () => {
  it('lists detected applications and opens the workspace in the selected app', async () => {
    const api = installApi();
    renderMenu('ws-1');

    fireEvent.click(screen.getByTestId('open-app-menu'));
    fireEvent.click(await screen.findByTestId('open-app-vscode'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('workspace:openInApp', {
        workspaceId: 'ws-1',
        appId: 'vscode',
      }),
    );
    expect(screen.queryByTestId('open-app-list')).not.toBeInTheDocument();
  });

  it('is disabled when no workspace is selected', () => {
    installApi();
    renderMenu(null);

    expect(screen.getByTestId('open-app-menu')).toBeDisabled();
  });
});
