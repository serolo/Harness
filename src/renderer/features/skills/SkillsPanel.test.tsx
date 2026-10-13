import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useComposerStore } from '@renderer/stores/composer';
import { SkillsPanel, skillCreationPrompt } from './SkillsPanel';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

function installApi(): ApiStub {
  const invoke = vi.fn((channel: string, request?: unknown) => {
    if (channel !== 'slash:list') return Promise.resolve(undefined);
    const harness = (request as { harness?: string } | undefined)?.harness;
    if (harness === 'claude_code') {
      return Promise.resolve([
        {
          name: 'review',
          template: '/review $ARGS',
          description: 'Review the current changes',
          source: 'native_skill',
          provider: 'claude_code',
          provenance: 'workspace',
          invocation: 'slash',
        },
        {
          name: 'not-a-skill',
          template: 'Prompt',
          source: 'configured_prompt',
          provenance: 'app',
          invocation: 'slash',
        },
      ]);
    }
    return Promise.resolve([
      {
        name: 'review',
        template: '$review $ARGS',
        description: 'Review the current changes',
        source: 'native_skill',
        provider: 'codex',
        provenance: 'workspace',
        invocation: 'dollar',
      },
      {
        name: 'deploy',
        template: '$deploy $ARGS',
        description: 'Deploy safely',
        source: 'native_skill',
        provider: 'codex',
        provenance: 'user',
        invocation: 'dollar',
      },
      {
        name: 'review',
        template: '$review $ARGS',
        description: 'A second same-scope review skill',
        source: 'native_skill',
        provider: 'codex',
        provenance: 'workspace',
        invocation: 'dollar',
      },
    ]);
  });
  const api: ApiStub = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

beforeEach(() => {
  useComposerStore.setState({ pendingPromptByWorkspace: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('SkillsPanel', () => {
  it('lists native skills and consolidates provider copies by name and scope', async () => {
    const api = installApi();
    render(<SkillsPanel workspaceId="workspace-1" />);

    const review = await screen.findByTestId('skill-review-workspace-0');
    expect(review).toHaveTextContent('/review');
    expect(review).toHaveTextContent('Claude');
    expect(review).toHaveTextContent('Codex');
    expect(screen.getAllByText('/review')).toHaveLength(2);
    expect(screen.getByTestId('skill-review-workspace-1')).toHaveTextContent(
      'A second same-scope review skill',
    );
    expect(screen.getByTestId('skill-deploy-user-0')).toHaveTextContent(
      'Personal',
    );
    expect(screen.queryByText('/not-a-skill')).not.toBeInTheDocument();
    expect(api.invoke).toHaveBeenCalledWith('slash:list', {
      workspaceId: 'workspace-1',
      harness: 'claude_code',
    });
    expect(api.invoke).toHaveBeenCalledWith('slash:list', {
      workspaceId: 'workspace-1',
      harness: 'codex',
    });
  });

  it('prepares a reviewed chat request for matching Claude and Codex skills', async () => {
    installApi();
    render(<SkillsPanel workspaceId="workspace-1" />);
    await screen.findByTestId('skill-review-workspace-0');

    fireEvent.click(screen.getByTestId('skill-new'));
    fireEvent.change(screen.getByLabelText('Skill name'), {
      target: { value: 'release-checklist' },
    });
    fireEvent.change(screen.getByLabelText('Skill purpose'), {
      target: { value: 'Prepare and verify a release before publishing.' },
    });
    fireEvent.click(screen.getByTestId('skill-prepare'));

    await waitFor(() =>
      expect(
        useComposerStore.getState().pendingPromptByWorkspace['workspace-1'],
      ).toBe(
        skillCreationPrompt(
          'release-checklist',
          'Prepare and verify a release before publishing.',
        ),
      ),
    );
    expect(screen.getByTestId('skill-prompt-prepared')).toHaveTextContent(
      'ready in chat',
    );
    const prompt =
      useComposerStore.getState().pendingPromptByWorkspace['workspace-1'];
    expect(prompt).toContain('.claude/skills/release-checklist/SKILL.md');
    expect(prompt).toContain('.agents/skills/release-checklist/SKILL.md');
  });

  it('searches skills and filters by provider and scope', async () => {
    installApi();
    render(<SkillsPanel workspaceId="workspace-1" />);
    await screen.findByTestId('skill-review-workspace-0');

    expect(screen.getByTestId('skills-result-count')).toHaveTextContent(
      '3 of 3 skills',
    );

    fireEvent.change(screen.getByLabelText('Search skills'), {
      target: { value: 'deploy' },
    });
    expect(screen.getByTestId('skill-deploy-user-0')).toBeInTheDocument();
    expect(screen.queryByText('/review')).not.toBeInTheDocument();
    expect(screen.getByTestId('skills-result-count')).toHaveTextContent(
      '1 of 3 skills',
    );

    fireEvent.change(screen.getByLabelText('Search skills'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText('Filter skills by provider'), {
      target: { value: 'claude_code' },
    });
    expect(screen.getAllByText('/review')).toHaveLength(1);
    expect(screen.queryByText('/deploy')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter skills by provider'), {
      target: { value: 'all' },
    });
    fireEvent.change(screen.getByLabelText('Filter skills by scope'), {
      target: { value: 'user' },
    });
    expect(screen.getByText('/deploy')).toBeInTheDocument();
    expect(screen.queryByText('/review')).not.toBeInTheDocument();
  });

  it('shows and clears the no-results filter state', async () => {
    installApi();
    render(<SkillsPanel workspaceId="workspace-1" />);
    await screen.findByTestId('skill-review-workspace-0');

    fireEvent.change(screen.getByLabelText('Search skills'), {
      target: { value: 'does-not-exist' },
    });
    expect(
      screen.getByText('No skills match your search and filters.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('skills-clear-filters'));
    expect(screen.getByTestId('skills-result-count')).toHaveTextContent(
      '3 of 3 skills',
    );
    expect(screen.getByTestId('skill-deploy-user-0')).toBeInTheDocument();
  });

  it('rejects unsafe skill names before handing work to the agent', async () => {
    installApi();
    render(<SkillsPanel workspaceId="workspace-1" />);
    await screen.findByTestId('skill-review-workspace-0');

    fireEvent.click(screen.getByTestId('skill-new'));
    fireEvent.change(screen.getByLabelText('Skill name'), {
      target: { value: '../escape' },
    });
    fireEvent.change(screen.getByLabelText('Skill purpose'), {
      target: { value: 'Do something useful.' },
    });
    fireEvent.click(screen.getByTestId('skill-prepare'));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'lowercase letters, numbers, and hyphens',
    );
    expect(
      useComposerStore.getState().pendingPromptByWorkspace['workspace-1'],
    ).toBeUndefined();
  });
});
