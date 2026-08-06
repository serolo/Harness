import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MetaAgentDetail } from '@shared/agents';
import { AgentEditor } from './AgentEditor';

const config = `version: 1\nname: Custom\nprompt: Coordinate.\nexecutor:\n  harness: claude_code\n  mode: plan\n`;

const agent: MetaAgentDetail = {
  id: 'project:project-1:custom',
  projectId: 'project-1',
  slug: 'custom',
  origin: 'project',
  name: 'Custom',
  description: '',
  revision: 'revision',
  valid: true,
  diagnostics: [],
  requiredProviders: ['claude_code'],
  capabilities: ['delegate'],
  available: true,
  unavailableReasons: [],
  editable: true,
  files: ['config.yaml'],
};

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('AgentEditor', () => {
  it('adds a referenced child and saves both files as one atomic bundle edit', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'metaAgent:readFile')
        return { path: 'config.yaml', content: config, diagnostics: [] };
      if (channel === 'metaAgent:validateFile') return [];
      if (channel === 'metaAgent:saveBundleFiles')
        return {
          ...agent,
          files: ['agents/reviewer/config.yaml', 'config.yaml'],
        };
      throw new Error(`unexpected channel ${channel}`);
    });
    (window as unknown as { api: unknown }).api = {
      invoke,
      on: vi.fn(() => vi.fn()),
      stream: vi.fn(),
      cancelStream: vi.fn(),
    };
    render(
      <AgentEditor
        projectId="project-1"
        agent={agent}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Agent bundle file')).toHaveValue(config),
    );

    fireEvent.change(screen.getByLabelText('New bundle file path'), {
      target: { value: 'agents/reviewer/config.yaml' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add file' }));
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'config.yaml' },
    });
    fireEvent.change(screen.getByLabelText('Agent bundle file'), {
      target: { value: `${config}tools:\n  agents: [reviewer]\n` },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Validate and save atomically' }),
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('metaAgent:saveBundleFiles', {
        projectId: 'project-1',
        agentId: agent.id,
        files: expect.arrayContaining([
          {
            path: 'config.yaml',
            content: `${config}tools:\n  agents: [reviewer]\n`,
          },
          {
            path: 'agents/reviewer/config.yaml',
            content: expect.stringContaining('name: New role'),
          },
        ]),
      }),
    );
  });
});
