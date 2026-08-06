import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

import {
  ProjectKnowledgeGateway,
  type KnowledgeToolResult,
} from './gateway';

let tempRoot: string;
let projectRoot: string;

beforeEach(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'harness-knowledge-gateway-'));
  projectRoot = join(tempRoot, 'project-a');
  await mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function markdown(
  title: string,
  body: string,
  status = 'canonical',
): string {
  return `---\ntype: Component\ntitle: ${title}\nstatus: ${status}\n---\n\n# ${title}\n\n${body}\n`;
}

async function page(
  root: string,
  path: string,
  title: string,
  body: string,
  status = 'canonical',
): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, markdown(title, body, status), 'utf8');
}

function payload(result: KnowledgeToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function gateway(
  overrides: Partial<ConstructorParameters<typeof ProjectKnowledgeGateway>[0]> = {},
): ProjectKnowledgeGateway {
  return new ProjectKnowledgeGateway({
    projectId: 'project-a',
    root: projectRoot,
    provider: 'basic',
    maxResults: 10,
    maxContextTokens: 4_000,
    rerank: false,
    ...overrides,
  });
}

describe('ProjectKnowledgeGateway search and confinement', () => {
  it('returns only relevant canonical pages and excludes reserved catalog/log files', async () => {
    await page(
      projectRoot,
      'components/payments.md',
      'Payments',
      'Failed invoices retry through the payment worker.',
    );
    await page(
      projectRoot,
      'components/search.md',
      'Search',
      'Product indexing uses a background worker.',
    );
    await page(
      projectRoot,
      'research/payment-draft.md',
      'Payment draft',
      'Failed invoices might retry someday.',
      'research',
    );
    await page(projectRoot, 'index.md', 'Catalog', 'Failed invoice catalog.');
    await page(projectRoot, 'nested/log.md', 'Log', 'Failed invoice log.');

    const result = await gateway().searchProjectKnowledge('failed invoice');
    const body = payload(result);

    expect(result.isError).not.toBe(true);
    expect(body.provider).toBe('basic');
    expect(body.results).toEqual([
      expect.objectContaining({
        path: 'components/payments.md',
        title: 'Payments',
      }),
    ]);
  });

  it('confines QMD results to canonical files inside this project root', async () => {
    const otherRoot = join(tempRoot, 'project-b');
    await mkdir(otherRoot, { recursive: true });
    await page(
      projectRoot,
      'components/local.md',
      'Local',
      'Project-local deployment details.',
    );
    await page(
      otherRoot,
      'components/secret.md',
      'Other project secret',
      'Must never cross the project boundary.',
    );
    const outside = join(tempRoot, 'outside.md');
    await writeFile(
      outside,
      markdown('Outside', 'Must never escape through a symlink.'),
      'utf8',
    );
    await symlink(outside, join(projectRoot, 'components', 'linked.md'));

    const search = vi.fn(async () => [
      { path: 'components/local.md', title: 'Local', score: 1 },
      {
        path: '../project-b/components/secret.md',
        title: 'Other project secret',
        score: 0.99,
      },
      { path: 'components/linked.md', title: 'Outside', score: 0.98 },
      { path: 'index.md', title: 'Catalog', score: 0.97 },
    ]);
    const result = await gateway({ provider: 'qmd', qmd: { search } })
      .searchProjectKnowledge('deployment');

    expect(payload(result).results).toEqual([
      expect.objectContaining({ path: 'components/local.md' }),
    ]);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        root: await realpath(projectRoot),
      }),
    );
  });

  it('requires search before read and rejects reserved, absolute, and traversal paths', async () => {
    await page(
      projectRoot,
      'components/payments.md',
      'Payments',
      'Retry invoices safely.',
    );
    await page(projectRoot, 'index.md', 'Catalog', 'Catalog content.');
    const subject = gateway();

    const beforeSearch = await subject.readProjectKnowledge(
      'components/payments.md',
    );
    expect(beforeSearch).toMatchObject({ isError: true });
    expect(beforeSearch.content[0].text).toMatch(/search project knowledge first/i);

    await subject.searchProjectKnowledge('retry invoices');
    const allowed = await subject.readProjectKnowledge(
      'components/payments.md',
    );
    expect(allowed.isError).not.toBe(true);

    for (const unsafe of [
      'index.md',
      'nested/log.md',
      '../outside.md',
      '/tmp/outside.md',
      'components/../../outside.md',
      'components/payments.txt',
    ]) {
      const result = await subject.readProjectKnowledge(unsafe);
      expect(result.isError, unsafe).toBe(true);
    }
  });

  it('re-checks canonical status when reading a previously returned path', async () => {
    await page(
      projectRoot,
      'components/payments.md',
      'Payments',
      'Retry invoices safely.',
    );
    const subject = gateway();
    await subject.searchProjectKnowledge('retry invoices');

    await page(
      projectRoot,
      'components/payments.md',
      'Payments',
      'Unreviewed replacement content.',
      'research',
    );

    const result = await subject.readProjectKnowledge(
      'components/payments.md',
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toMatch(/canonical.*not found/i);
  });
});

describe('ProjectKnowledgeGateway bounded reads and fallback', () => {
  it('returns one-based line ranges and clamps each read to 500 lines', async () => {
    const lines = Array.from(
      { length: 600 },
      (_, index) => `line-${String(index + 1).padStart(3, '0')}`,
    );
    await mkdir(join(projectRoot, 'operations'), { recursive: true });
    await writeFile(
      join(projectRoot, 'operations', 'runbook.md'),
      `---\ntype: Operations\ntitle: Runbook\nstatus: canonical\n---\n\n${lines.join('\n')}\n`,
      'utf8',
    );
    const subject = gateway({ maxContextTokens: 10_000 });
    await subject.searchProjectKnowledge('line-001');

    const precise = payload(
      await subject.readProjectKnowledge('operations/runbook.md', 3, 5),
    );
    const bounded = payload(
      await subject.readProjectKnowledge('operations/runbook.md', 1, 1_000),
    );

    expect(precise).toMatchObject({
      path: 'operations/runbook.md',
      startLine: 3,
      endLine: 5,
      content: 'line-003\nline-004\nline-005',
    });
    expect(bounded).toMatchObject({ startLine: 1, endLine: 500 });
    expect(bounded.content).toContain('line-500');
    expect(bounded.content).not.toContain('line-501');
  });

  it('rejects invalid line ranges without adding read trace entries', async () => {
    await page(
      projectRoot,
      'operations/runbook.md',
      'Runbook',
      'deployment line one\ndeployment line two',
    );
    const subject = gateway();
    await subject.searchProjectKnowledge('deployment');

    for (const [startLine, endLine] of [
      [0, 1],
      [-1, 1],
      [1.5, 2],
      [1, 2.5],
      [5, 4],
    ]) {
      const result = await subject.readProjectKnowledge(
        'operations/runbook.md',
        startLine,
        endLine,
      );
      expect(result.isError, `${startLine}-${endLine}`).toBe(true);
    }
    expect(subject.trace().filter((entry) => entry.operation === 'read')).toEqual(
      [],
    );
  });

  it('enforces one cumulative 4000-token budget and truncates the final readable page', async () => {
    await page(
      projectRoot,
      'components/alpha.md',
      'Alpha',
      `alpha ${'A'.repeat(10_000)}`,
    );
    await page(
      projectRoot,
      'components/beta.md',
      'Beta',
      `beta ${'B'.repeat(10_000)}`,
    );
    const subject = gateway({ maxContextTokens: 4_000 });
    const searchResult = await subject.searchProjectKnowledge('alpha beta');

    const first = await subject.readProjectKnowledge('components/alpha.md');
    const second = await subject.readProjectKnowledge('components/beta.md');
    const exhausted = await subject.readProjectKnowledge('components/alpha.md');
    const trace = subject.trace();
    const reads = trace.filter((entry) => entry.operation === 'read');
    const expectedSearchTokens = Math.ceil(
      JSON.stringify(searchResult).length / 4,
    );

    expect(trace[0]).toMatchObject({
      operation: 'search',
      contextTokens: expectedSearchTokens,
    });
    expect(first.isError).not.toBe(true);
    expect(payload(first).truncated).toBe(false);
    expect(second.isError).not.toBe(true);
    expect(payload(second).truncated).toBe(true);
    expect(reads).toHaveLength(2);
    expect(trace.reduce((total, entry) => total + entry.contextTokens, 0))
      .toBeLessThanOrEqual(4_000);
    expect(reads[1]).toMatchObject({
      path: 'components/beta.md',
      truncated: true,
    });
    expect(exhausted).toMatchObject({ isError: true });
    expect(exhausted.content[0].text).toMatch(/budget is exhausted/i);
  });

  it('falls back from unavailable QMD to basic search and traces the provider actually used', async () => {
    await page(
      projectRoot,
      'operations/deploy.md',
      'Deploy',
      'Canary deployment uses the release workflow.',
    );
    const subject = gateway({
      provider: 'qmd',
      qmd: {
        search: vi.fn(async () => {
          throw new Error('qmd unavailable');
        }),
      },
    });

    const found = await subject.searchProjectKnowledge('canary deployment');
    const read = await subject.readProjectKnowledge('operations/deploy.md');

    expect(payload(found)).toMatchObject({
      provider: 'basic',
      results: [expect.objectContaining({ path: 'operations/deploy.md' })],
    });
    expect(read.isError).not.toBe(true);
    const trace = subject.trace();
    expect(trace[0]).toMatchObject({
      operation: 'search',
      provider: 'basic',
      resultCount: 1,
    });
    expect(trace[0]?.contextTokens).toBeGreaterThan(0);
    expect(trace[1]).toMatchObject({
      operation: 'read',
      provider: 'basic',
      path: 'operations/deploy.md',
    });
  });
});
