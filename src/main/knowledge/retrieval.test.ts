import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KnowledgeConfig } from '@shared/knowledge';
import { openDb, type AppDatabase } from '../db';
import { ProjectsRepo } from '../db/repos/projects';
import { knowledgeDir, setUserDataRoot } from '../paths';
import { WikiService } from '.';
import {
  consumeKnowledgeTrace,
  KNOWLEDGE_MCP_INSTRUCTION,
  prepareMcpTurnKnowledge,
  usesKnowledgeMcp,
} from './retrieval';

let root: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-progressive-knowledge-'));
  setUserDataRoot(join(root, 'data'));
});

afterEach(async () => {
  if (db) await db.destroy();
  db = undefined;
  setUserDataRoot(undefined);
  await rm(root, { recursive: true, force: true });
});

const knowledgeConfig: KnowledgeConfig = {
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

async function wikiFixture(): Promise<{
  service: WikiService;
  projectId: string;
}> {
  const repoPath = join(root, 'repo');
  await mkdir(join(repoPath, '.harness'), { recursive: true });
  await writeFile(
    join(repoPath, '.harness', 'settings.toml'),
    '[knowledge]\nenabled = true\n',
    'utf8',
  );
  db = openDb(join(root, 'app.db'));
  const project = await new ProjectsRepo(db).create({
    name: 'Harness',
    originUrl: '',
    defaultBranch: 'main',
    repoPath,
  });
  return { service: new WikiService(db), projectId: project.id };
}

describe('MCP-capable progressive knowledge setup', () => {
  it('adds only a compact tool instruction to the initial prompt, never catalog or page content', async () => {
    const projectId = 'project-mcp';
    const canonicalRoot = knowledgeDir(projectId);
    await mkdir(join(canonicalRoot, 'components'), { recursive: true });
    await writeFile(
      join(canonicalRoot, 'index.md'),
      '# SECRET CATALOG CONTENT THAT MUST NOT ENTER THE INITIAL PROMPT\n',
      'utf8',
    );
    await writeFile(
      join(canonicalRoot, 'components', 'payments.md'),
      '---\ntype: Component\nstatus: canonical\n---\n\nSECRET PAGE CONTENT THAT MUST BE ON DEMAND\n',
      'utf8',
    );

    const prepared = prepareMcpTurnKnowledge(
      projectId,
      projectId,
      knowledgeConfig,
      4_000,
    );
    try {
      const configPath = prepared.server.env?.['HARNESS_KNOWLEDGE_CONFIG'];
      expect(configPath).toBeTruthy();
      const privateConfig = JSON.parse(
        await readFile(configPath!, 'utf8'),
      ) as Record<string, unknown>;

      expect(prepared.instruction).toBe(KNOWLEDGE_MCP_INSTRUCTION);
      expect(prepared.instruction.length).toBeLessThan(300);
      expect(prepared.instruction).toContain('search_project_knowledge');
      expect(prepared.instruction).toContain('read_project_knowledge');
      expect(prepared.instruction).not.toContain('SECRET CATALOG CONTENT');
      expect(prepared.instruction).not.toContain('SECRET PAGE CONTENT');
      expect(JSON.stringify(privateConfig)).not.toContain(
        'SECRET CATALOG CONTENT',
      );
      expect(JSON.stringify(privateConfig)).not.toContain(
        'SECRET PAGE CONTENT',
      );
      expect(privateConfig).toMatchObject({
        projectId,
        root: canonicalRoot,
        maxContextTokens: 4_000,
      });
      expect(prepared.server.name).toBe('harness-project-knowledge');
    } finally {
      consumeKnowledgeTrace(prepared.trace);
    }
  });

  it('uses progressive MCP retrieval for Claude Code and Codex, but not Cursor', () => {
    expect(usesKnowledgeMcp('claude_code')).toBe(true);
    expect(usesKnowledgeMcp('codex')).toBe(true);
    expect(usesKnowledgeMcp('cursor')).toBe(false);
  });
});

describe('Cursor-compatible preturn knowledge selection', () => {
  it('injects at most two relevant pages within 1000 tokens and never adds index.md', async () => {
    const { service, projectId } = await wikiFixture();
    await service.initializeProject(projectId);
    const proposal = await service.createProposal({
      projectId,
      title: 'Deployment knowledge',
      summary: 'Three relevant pages exercise the Cursor preturn bound.',
      operations: ['alpha', 'beta', 'gamma'].map((name) => ({
        op: 'create' as const,
        path: `operations/${name}.md`,
        content:
          `---\ntype: Operations\ntitle: ${name}\nstatus: canonical\n---\n\n` +
          `# ${name}\n\ndeployment ${name} ${name.repeat(100)}\n`,
      })),
    });
    await service.acceptProposal(projectId, proposal.id);

    const selected = await service.contextSelectionForPrompt(
      projectId,
      'deployment',
      1_000,
      { maxResults: 2, catalogFallback: false },
    );

    expect(selected.sources).toHaveLength(2);
    expect(selected.sources.every((source) => source.path !== 'index.md')).toBe(
      true,
    );
    expect(selected.context).not.toContain('index.md');
    expect(selected.context.length).toBeLessThanOrEqual(4_000);
    expect(selected.retrieval).toMatchObject({
      candidateCount: 2,
      selectedCount: 2,
      catalogFallback: false,
      maxContextTokens: 1_000,
    });
  });

  it('returns no eager catalog when no page is relevant', async () => {
    const { service, projectId } = await wikiFixture();
    await service.initializeProject(projectId);

    const selected = await service.contextSelectionForPrompt(
      projectId,
      'zyxqvblorpt',
      1_000,
      { maxResults: 2, catalogFallback: false },
    );

    expect(selected.context).toBe('');
    expect(selected.sources).toEqual([]);
    expect(selected.retrieval).toMatchObject({
      selectedCount: 0,
      catalogFallback: false,
      maxContextTokens: 1_000,
    });
  });
});
