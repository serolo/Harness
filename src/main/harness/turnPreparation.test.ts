import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '@shared/models';
import type { EffectiveSettings } from '@shared/settings';
import type { StartTurnOpts } from '@shared/harness';
import type { KnowledgeConfig } from '@shared/knowledge';
import { KNOWLEDGE_RECONCILIATION_INSTRUCTION } from '../knowledge';
import { setUserDataRoot } from '../paths';
import { TurnPreparationService } from './turnPreparation';

const project = {
  id: 'project-1',
  name: 'Demo',
  originUrl: 'git@github.com:acme/demo.git',
  defaultBranch: 'main',
  repoPath: '/tmp/demo',
  createdAt: 1,
  directoryName: 'demo-project',
};
const workspace = {
  id: 'workspace-1',
  projectId: project.id,
  worktreePath: '/tmp/demo-worktree',
  harness: 'codex',
} as Workspace;
const config: KnowledgeConfig = {
  enabled: true,
  storage: 'local',
  proposalMode: 'review_required',
  injectContext: true,
  extractAfterTurn: true,
  search: {
    enabled: true,
    provider: 'basic',
    maxResults: 8,
    rerank: false,
  },
  format: { name: 'okf', version: '0.1' },
};

function settings(overrides: Partial<EffectiveSettings['knowledge']> = {}) {
  return {
    agent: {
      mode: 'default',
      permissionPolicy: { allow: ['read'] },
    },
    mcp: [{ name: 'project-server', command: 'server', args: [] }],
    knowledge: {
      enabled: true,
      inject_context: true,
      extract_after_turn: true,
      search: { max_context_tokens: 4_000 },
      ...overrides,
    },
  } as unknown as EffectiveSettings;
}

describe('TurnPreparationService', () => {
  let prepared: StartTurnOpts[];
  let getConfig: ReturnType<typeof vi.fn>;
  let initializeProject: ReturnType<typeof vi.fn>;
  let select: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-turn-preparation-'));
    setUserDataRoot(root);
    prepared = [];
    getConfig = vi.fn(async () => config);
    initializeProject = vi.fn(async () => ({ commit: 'a'.repeat(40) }));
    select = vi.fn(async () => ({
      context: '## Project knowledge\nUse the durable checkout flow.',
      sources: [{ path: 'workflows/checkout.md', title: 'Checkout' }],
      retrieval: {
        requestedProvider: 'basic',
        providerUsed: 'basic',
        searchEnabled: true,
        searchStatus: 'completed',
        resultCount: 1,
        contextTokens: 12,
      },
    }));
    warn = vi.fn();
  });

  afterEach(() => {
    for (const opts of prepared) {
      new TurnPreparationService({
        getProject: async () => project,
        settingsForProject: async () => settings(),
        knowledge: {
          getConfig: getConfig as never,
          initializeProject: initializeProject as never,
          contextSelectionForPrompt: select as never,
        },
        warn,
      }).discard(opts);
    }
    setUserDataRoot(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  function service(value = settings()) {
    return new TurnPreparationService({
      getProject: async () => project,
      settingsForProject: async () => value,
      knowledge: {
        getConfig: getConfig as never,
        initializeProject: initializeProject as never,
        contextSelectionForPrompt: select as never,
      },
      warn,
    });
  }

  const raw = {
    workspaceDir: workspace.worktreePath!,
    prompt: 'Fix checkout',
    attachments: [],
  };

  it('adds on-demand MCP knowledge and project defaults to a manual Codex turn', async () => {
    const opts = await service().prepareTurn(workspace, raw, 'manual', 'codex');
    prepared.push(opts);

    expect(opts.permissionPolicy).toEqual({ allow: ['read'] });
    expect(opts.mcpConfig.map((server) => server.name)).toEqual([
      'project-server',
      'harness-project-knowledge',
    ]);
    expect(opts.prompt).toContain('search_project_knowledge');
    expect(opts.prompt).toContain(KNOWLEDGE_RECONCILIATION_INSTRUCTION);
    expect(opts.knowledgeStatus).toEqual({
      kind: 'knowledge_status',
      status: 'prepared',
      provider: 'basic',
    });
    expect(initializeProject).toHaveBeenCalledWith(project.id);
    expect(select).not.toHaveBeenCalled();
  });

  it('injects bounded eager context for a Cursor meta child', async () => {
    const opts = await service().prepareTurn(
      { ...workspace, harness: 'cursor' },
      { ...raw, mcpConfig: [] },
      'meta-child',
      'cursor',
    );

    expect(opts.mcpConfig).toEqual([]);
    expect(opts.prompt).toContain('durable checkout flow');
    expect(opts.knowledgeSources).toEqual([
      { path: 'workflows/checkout.md', title: 'Checkout' },
    ]);
    expect(opts.knowledgeStatus).toEqual({
      kind: 'knowledge_status',
      status: 'read',
      provider: 'basic',
    });
    expect(select).toHaveBeenCalledWith(project.id, raw.prompt, 1_000, {
      maxResults: 2,
      catalogFallback: false,
    });
  });

  it('preserves the coordinator control MCP as its exclusive authority', async () => {
    const control = { name: 'harness-meta-control', command: 'control' };
    const opts = await service().prepareTurn(
      workspace,
      { ...raw, mcpConfig: [control], mode: 'plan' },
      'meta-coordinator',
      'codex',
    );

    expect(opts.mcpConfig).toEqual([control]);
    expect(opts.prompt).toBe(raw.prompt);
    expect(opts.knowledgeStatus).toEqual({
      kind: 'knowledge_status',
      status: 'not_configured',
      reason: 'disabled',
    });
    expect(getConfig).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('does not add reconciliation guidance to plan-mode scheduled turns', async () => {
    const opts = await service().prepareTurn(
      workspace,
      { ...raw, mode: 'plan' },
      'scheduled',
      'codex',
    );
    prepared.push(opts);

    expect(opts.prompt).not.toContain(KNOWLEDGE_RECONCILIATION_INSTRUCTION);
    expect(opts.mcpConfig.map((server) => server.name)).toContain(
      'harness-project-knowledge',
    );
  });

  it('starts the turn without retrieval when automatic initialization fails', async () => {
    initializeProject.mockRejectedValueOnce(new Error('disk unavailable'));

    const opts = await service().prepareTurn(workspace, raw, 'manual', 'codex');

    expect(opts.mcpConfig.map((server) => server.name)).toEqual([
      'project-server',
    ]);
    expect(opts.prompt).not.toContain('search_project_knowledge');
    expect(opts.prompt).toContain(KNOWLEDGE_RECONCILIATION_INSTRUCTION);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('continuing without retrieval'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('disk unavailable');
    expect(opts.knowledgeStatus).toEqual({
      kind: 'knowledge_status',
      status: 'failed',
      reason: 'initialization',
    });
  });

  it('records an honest no-results outcome for eager retrieval', async () => {
    select.mockResolvedValueOnce({
      context: '',
      sources: [],
      retrieval: {
        requestedProvider: 'basic',
        providerUsed: 'basic',
        searchEnabled: true,
        searchStatus: 'completed',
        resultCount: 0,
        contextTokens: 0,
      },
    });

    const opts = await service().prepareTurn(
      { ...workspace, harness: 'cursor' },
      raw,
      'manual',
      'cursor',
    );

    expect(opts.knowledgeStatus).toEqual({
      kind: 'knowledge_status',
      status: 'no_results',
      provider: 'basic',
    });
  });

  it('does not initialize knowledge for the exclusive coordinator policy', async () => {
    await service().prepareTurn(
      workspace,
      {
        ...raw,
        mcpConfig: [
          { name: 'harness-meta-control', command: 'control', args: [] },
        ],
      },
      'meta-coordinator',
      'codex',
    );

    expect(initializeProject).not.toHaveBeenCalled();
  });

  it('does not expose MCP retrieval when project knowledge search is disabled', async () => {
    getConfig.mockResolvedValueOnce({
      ...config,
      search: { ...config.search, enabled: false },
    });

    const opts = await service().prepareTurn(workspace, raw, 'manual', 'codex');

    expect(initializeProject).toHaveBeenCalledWith(project.id);
    expect(opts.mcpConfig.map((server) => server.name)).toEqual([
      'project-server',
    ]);
    expect(opts.prompt).not.toContain('search_project_knowledge');
  });
});
