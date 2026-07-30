import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMemoryImporter } from './agentMemory';
import { parseOkfMarkdown } from '.';
import type { WikiOperation } from '@shared/knowledge';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function fixture(): Promise<{ root: string; home: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), 'harness-agent-memory-'));
  roots.push(root);
  const home = join(root, 'home');
  const repo = join(root, 'project');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  return { root, home, repo };
}

describe('AgentMemoryImporter', () => {
  it('discovers only provider-relevant project memory and creates a proposal', async () => {
    const { home, repo } = await fixture();
    await writeFile(join(repo, 'CLAUDE.md'), '# Working agreement\n\nUse npm.\n');
    await writeFile(join(repo, 'AGENTS.md'), '# Codex agreement\n');
    const projectMemory = join(home, '.claude-memory');
    const memory = join(projectMemory, 'memory');
    await mkdir(join(memory, 'topics'), { recursive: true });
    await writeFile(
      join(memory, 'MEMORY.md'),
      '# Memory Index\n\n- [Testing](topics/testing.md)\n',
    );
    await writeFile(
      join(memory, 'topics', 'testing.md'),
      '---\ntype:\nname: testing\nsource_identity: attacker\nsource_digest: attacker\nmetadata:\n  type: project\n---\n\nRun Electron tests.\n',
    );

    const importer = new AgentMemoryImporter();
    const discovery = await importer.discover({
      projectId: 'project-1',
      provider: 'claude_code',
      repoPath: repo,
      memoryRoot: memory,
    });

    expect(discovery.sources.map((source) => source.displayPath)).toEqual([
      'CLAUDE.md',
      'Provider memory / MEMORY.md',
      'Provider memory / topics/testing.md',
    ]);
    expect(
      discovery.sources.some((source) => source.displayPath.includes(home)),
    ).toBe(false);

    const persist = vi.fn(async (operations) => ({
      id: 'proposal-1',
      projectId: 'project-1',
      baseWikiCommit: 'abc',
      title: 'Import memory',
      summary: '',
      operations,
      status: 'pending_review' as const,
      createdAt: 1,
    }));
    const result = await importer.createProposal({
      projectId: 'project-1',
      provider: 'claude_code',
      discoveryId: discovery.discoveryId,
      sourceIds: discovery.sources.map((source) => source.id),
      existingPages: [],
      persist,
    });

    expect(result.operationCount).toBe(3);
    expect(result.proposal?.status).toBe('pending_review');
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0][0]).toMatchObject({
      op: 'create',
      path: expect.stringMatching(/^sources\/agent-memory\/claude_code-/),
    });
    expect(persist.mock.calls[0]?.[0][0].content).toContain(
      'Imported from Claude Code memory',
    );
    const bundleOperations = persist.mock.calls[0]?.[0].slice(1);
    expect(
      bundleOperations?.map((operation: WikiOperation) =>
        operation.op === 'move' ? operation.to : operation.path,
      ),
    ).toEqual([
      expect.stringMatching(
        /^sources\/agent-memory\/claude_code\/[a-f0-9]{16}\/MEMORY\.md$/,
      ),
      expect.stringMatching(
        /^sources\/agent-memory\/claude_code\/[a-f0-9]{16}\/topics\/testing\.md$/,
      ),
    ]);
    const memoryIndex = bundleOperations?.[0];
    if (memoryIndex?.op === 'move' || memoryIndex === undefined) {
      throw new Error('expected a bundle page operation');
    }
    expect(memoryIndex.content).toContain('[Testing](topics/testing.md)');
    expect(memoryIndex.content).toContain('type: Document');
    const testingPage = bundleOperations?.[1];
    if (testingPage?.op === 'move' || testingPage === undefined) {
      throw new Error('expected a bundle page operation');
    }
    expect(testingPage.content).toContain('name: testing');
    expect(testingPage.content).toContain('type: Document');
    expect(parseOkfMarkdown(testingPage.content).frontmatter.type).toBe(
      'Document',
    );
    expect(testingPage.content).not.toContain('source_identity: attacker');
    expect(
      testingPage.content.match(/^source_identity:/gm),
    ).toHaveLength(1);
  });

  it('excludes secret-bearing sources without returning their content', async () => {
    const { repo } = await fixture();
    await writeFile(
      join(repo, 'AGENTS.md'),
      '# Instructions\n\nANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv\n',
    );

    const discovery = await new AgentMemoryImporter().discover({
      projectId: 'project-1',
      provider: 'codex',
      repoPath: repo,
    });

    expect(discovery.eligibleCount).toBe(0);
    expect(discovery.sources[0]).toMatchObject({
      displayPath: 'AGENTS.md',
      eligible: false,
      exclusionReason: 'secret_detected',
    });
    expect(discovery.sources[0]?.preview).toBeUndefined();
  });

  it('rescans changed content and blocks an OpenAI token before persistence', async () => {
    const { repo } = await fixture();
    const path = join(repo, 'AGENTS.md');
    await writeFile(path, '# Instructions\n\nSafe content.\n');
    const importer = new AgentMemoryImporter();
    const discovery = await importer.discover({
      projectId: 'project-1',
      provider: 'codex',
      repoPath: repo,
    });
    await writeFile(
      path,
      '# Instructions\n\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv\n',
    );
    const persist = vi.fn();
    const result = await importer.createProposal({
      projectId: 'project-1',
      provider: 'codex',
      discoveryId: discovery.discoveryId,
      sourceIds: [discovery.sources[0]!.id],
      existingPages: [],
      persist,
    });
    expect(result).toMatchObject({
      operationCount: 0,
      excludedCount: 1,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('skips unchanged content using stable provenance', async () => {
    const { repo } = await fixture();
    const content = '# Instructions\n\nUse strict TypeScript.';
    await writeFile(join(repo, 'AGENTS.md'), content);
    const importer = new AgentMemoryImporter();
    const discovery = await importer.discover({
      projectId: 'project-1',
      provider: 'codex',
      repoPath: repo,
    });
    const firstPersist = vi.fn(async (operations) => ({
      id: 'proposal-1',
      projectId: 'project-1',
      baseWikiCommit: 'abc',
      title: 'Import memory',
      summary: '',
      operations,
      status: 'pending_review' as const,
      createdAt: 1,
    }));
    const first = await importer.createProposal({
      projectId: 'project-1',
      provider: 'codex',
      discoveryId: discovery.discoveryId,
      sourceIds: [discovery.sources[0]!.id],
      existingPages: [],
      persist: firstPersist,
    });
    const created = first.proposal!.operations[0];
    if (created?.op === 'move' || created === undefined) {
      throw new Error('expected a create operation');
    }
    const { frontmatter } = parseOkfMarkdown(created.content);
    const rediscovery = await importer.discover({
      projectId: 'project-1',
      provider: 'codex',
      repoPath: repo,
    });
    const persist = vi.fn();
    const result = await importer.createProposal({
      projectId: 'project-1',
      provider: 'codex',
      discoveryId: rediscovery.discoveryId,
      sourceIds: [rediscovery.sources[0]!.id],
      existingPages: [
        {
          id: 'memory',
          path: created.path,
          title: 'Instructions',
          type: 'Imported Agent Memory',
          status: 'canonical',
          tags: [],
          content: created.content,
          body: content,
          frontmatter,
        },
      ],
      persist,
    });
    expect(result).toMatchObject({ operationCount: 0, skippedCount: 1 });
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not cross a nested worktree boundary marked by a .git file', async () => {
    const { repo } = await fixture();
    await writeFile(join(repo, 'AGENTS.md'), '# Root instructions\n');
    const nested = join(repo, 'nested-worktree');
    await mkdir(nested);
    await writeFile(join(nested, '.git'), 'gitdir: ../.git/worktrees/nested\n');
    await writeFile(join(nested, 'AGENTS.md'), '# Other repository\n');

    const discovery = await new AgentMemoryImporter().discover({
      projectId: 'project-1',
      provider: 'codex',
      repoPath: repo,
    });

    expect(discovery.sources.map((source) => source.displayPath)).toEqual([
      'AGENTS.md',
    ]);
  });

  it('rejects concurrent consumption of one discovery', async () => {
    const { repo } = await fixture();
    await writeFile(join(repo, 'AGENTS.md'), '# Instructions\n');
    const importer = new AgentMemoryImporter();
    const discovery = await importer.discover({
      projectId: 'project-1',
      provider: 'codex',
      repoPath: repo,
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persist = vi.fn(async (operations) => {
      await pending;
      return {
        id: 'proposal-1',
        projectId: 'project-1',
        baseWikiCommit: 'abc',
        title: 'Import memory',
        summary: '',
        operations,
        status: 'pending_review' as const,
        createdAt: 1,
      };
    });
    const input = {
      projectId: 'project-1',
      provider: 'codex' as const,
      discoveryId: discovery.discoveryId,
      sourceIds: [discovery.sources[0]!.id],
      existingPages: [],
      persist,
    };
    const first = importer.createProposal(input);
    await expect(importer.createProposal(input)).rejects.toMatchObject({
      code: 'conflict',
    });
    release();
    await expect(first).resolves.toMatchObject({ operationCount: 1 });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('rejects a Claude bundle when a page is added after discovery', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(repo, 'CLAUDE.md'), '# Instructions\n');
    const memory = join(root, 'memory');
    await mkdir(memory);
    await writeFile(join(memory, 'MEMORY.md'), '# Memory Index\n');
    const importer = new AgentMemoryImporter();
    const discovery = await importer.discover({
      projectId: 'project-1',
      provider: 'claude_code',
      repoPath: repo,
      memoryRoot: memory,
    });
    await writeFile(join(memory, 'added.md'), '# Added later\n');
    const persist = vi.fn();
    await expect(
      importer.createProposal({
        projectId: 'project-1',
        provider: 'claude_code',
        discoveryId: discovery.discoveryId,
        sourceIds: discovery.sources
          .filter((source) => source.kind === 'provider_memory')
          .map((source) => source.id),
        existingPages: [],
        persist,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps a 100-page bundle complete and rejects a 101st page', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(repo, 'CLAUDE.md'), '# Instructions\n');
    const memory = join(root, 'large-memory');
    await mkdir(memory);
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(
          join(memory, `page-${String(index).padStart(3, '0')}.md`),
          `# Page ${index}\n`,
        ),
      ),
    );
    const importer = new AgentMemoryImporter();
    const discovery = await importer.discover({
      projectId: 'project-1',
      provider: 'claude_code',
      repoPath: repo,
      memoryRoot: memory,
    });
    expect(
      discovery.sources.filter((source) => source.kind === 'provider_memory'),
    ).toHaveLength(100);
    expect(discovery.sources).toHaveLength(101);

    await writeFile(join(memory, 'page-100.md'), '# Page 100\n');
    await expect(
      importer.discover({
        projectId: 'project-1',
        provider: 'claude_code',
        repoPath: repo,
        memoryRoot: memory,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('normalizes non-string Claude page types to Document', async () => {
    const { root, repo } = await fixture();
    const memory = join(root, 'typed-memory');
    await mkdir(memory);
    await Promise.all(
      ['null', 'true', '123'].map((value) =>
        writeFile(
          join(memory, `type-${value}.md`),
          `---\ntype: ${value}\n---\n\n# ${value}\n`,
        ),
      ),
    );
    const importer = new AgentMemoryImporter();
    const discovery = await importer.discover({
      projectId: 'project-1',
      provider: 'claude_code',
      repoPath: repo,
      memoryRoot: memory,
    });
    const persist = vi.fn(async (operations: WikiOperation[]) => ({
      id: 'proposal-1',
      projectId: 'project-1',
      baseWikiCommit: 'abc',
      title: 'Import memory',
      summary: '',
      operations,
      status: 'pending_review' as const,
      createdAt: 1,
    }));
    const result = await importer.createProposal({
      projectId: 'project-1',
      provider: 'claude_code',
      discoveryId: discovery.discoveryId,
      sourceIds: discovery.sources.map((source) => source.id),
      existingPages: [],
      persist,
    });
    expect(result.operationCount).toBe(3);
    for (const operation of persist.mock.calls[0]![0]) {
      if (operation.op === 'move') throw new Error('unexpected move');
      expect(parseOkfMarkdown(operation.content).frontmatter.type).toBe(
        'Document',
      );
    }
  });
});
