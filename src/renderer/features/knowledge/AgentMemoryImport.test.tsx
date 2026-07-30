import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AgentMemoryImport } from './AgentMemoryImport';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

function installApi(): ApiStub {
  const api: ApiStub = {
    invoke: vi.fn((channel: string) => {
      if (channel === 'knowledge:discoverAgentMemory') {
        return Promise.resolve({
          discoveryId: 'discovery-1',
          provider: 'claude_code',
          eligibleCount: 1,
          excludedCount: 1,
          sources: [
            {
              id: 'memory-1',
              provider: 'claude_code',
              label: 'Project memory',
              displayPath: '.claude/CLAUDE.md',
              size: 120,
              kind: 'project_instruction',
              eligible: true,
              preview: '# Build conventions',
            },
            {
              id: 'memory-2',
              provider: 'claude_code',
              label: 'Private notes',
              displayPath: '.claude/private.md',
              size: 80,
              kind: 'provider_memory',
              eligible: false,
              exclusionReason: 'secret_detected',
            },
          ],
        });
      }
      if (channel === 'knowledge:createAgentMemoryProposal') {
        return Promise.resolve({
          proposal: { id: 'proposal-1' },
          selectedCount: 1,
          operationCount: 2,
          skippedCount: 0,
          excludedCount: 1,
        });
      }
      return Promise.resolve(undefined);
    }),
    on: vi.fn(),
    stream: vi.fn(),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('AgentMemoryImport', () => {
  it('discovers, previews, selects, and creates a review proposal', async () => {
    const api = installApi();
    render(<AgentMemoryImport projectId="project-1" />);

    expect(
      screen.getByText(/nothing is read until you start discovery/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Choose & discover' }),
    );

    expect(await screen.findByText('Project memory')).toBeInTheDocument();
    expect(
      screen.getByText('Excluded: Possible secret detected'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Include Private notes')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('# Build conventions')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Create review proposal' }),
    );
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'knowledge:createAgentMemoryProposal',
        {
          projectId: 'project-1',
          provider: 'claude_code',
          discoveryId: 'discovery-1',
          sourceIds: ['memory-1'],
        },
      ),
    );
    expect(
      await screen.findByText('Review proposal created with 2 wiki changes.'),
    ).toBeInTheDocument();
  });

  it('clears stale discovery when the provider changes', async () => {
    installApi();
    render(<AgentMemoryImport projectId="project-1" />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Choose & discover' }),
    );
    expect(await screen.findByText('Project memory')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Agent memory provider'), {
      target: { value: 'codex' },
    });

    expect(screen.queryByText('Project memory')).not.toBeInTheDocument();
    expect(
      screen.getByText(/nothing is read until you start discovery/i),
    ).toBeInTheDocument();
  });
});
