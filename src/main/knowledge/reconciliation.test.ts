import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { GitService } from '../git';
import { hasEligibleRepositoryChanges } from './reconciliation';

describe('hasEligibleRepositoryChanges', () => {
  it('accepts a net change to an implementation, test, config, or docs path', () => {
    for (const path of [
      'src/app.ts',
      'src/app.test.ts',
      'package.json',
      'docs/architecture.md',
    ]) {
      expect(hasEligibleRepositoryChanges('default', [path])).toBe(true);
    }
  });

  it('rejects plan mode even when its tree changed', () => {
    expect(hasEligibleRepositoryChanges('plan', ['src/app.ts'])).toBe(false);
  });

  it('rejects an unchanged tree and plan-only artifacts', () => {
    expect(hasEligibleRepositoryChanges('default', [])).toBe(false);
    expect(
      hasEligibleRepositoryChanges('default', [
        'plans/feature-plan.md',
        'plans/nested/research.md',
      ]),
    ).toBe(false);
  });

  it('allows reconciliation when a plan and eligible file both changed', () => {
    expect(
      hasEligibleRepositoryChanges('default', [
        'plans/feature-plan.md',
        'src/app.ts',
      ]),
    ).toBe(true);
  });
});

describe('repository change evidence', () => {
  let root: string;
  let repo: string;
  const git = new GitService();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-reconcile-'));
    repo = join(root, 'repo');
    await execa('git', ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'existing.ts'), 'before\n');
    await execa(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', '.'],
      { cwd: repo },
    );
    await execa(
      'git',
      [
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=test',
        'commit',
        '-m',
        'initial',
      ],
      { cwd: repo },
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function changedPaths(
    baseline: string,
    current: string,
  ): Promise<string[]> {
    return (await git.diffBetween(repo, baseline, current)).files.flatMap(
      (file) =>
        [file.oldPath, file.path].filter(
          (path): path is string => typeof path === 'string',
        ),
    );
  }

  it('ignores pre-existing dirtiness, no-op writes, and reverted edits', async () => {
    writeFileSync(join(repo, 'existing.ts'), 'already dirty\n');
    const baseline = await git.commitTree(repo, 'baseline');

    writeFileSync(join(repo, 'existing.ts'), 'temporary edit\n');
    writeFileSync(join(repo, 'existing.ts'), 'already dirty\n');
    const current = await git.commitTree(repo, 'current');

    expect(await changedPaths(baseline, current)).toEqual([]);
  });

  it('separates plan-only output from a real repository change', async () => {
    const baseline = await git.commitTree(repo, 'baseline');
    mkdirSync(join(repo, 'plans'));
    writeFileSync(join(repo, 'plans', 'feature-plan.md'), '# Plan\n');
    const planOnly = await git.commitTree(repo, 'plan only');
    const planPaths = await changedPaths(baseline, planOnly);
    expect(hasEligibleRepositoryChanges('default', planPaths)).toBe(false);

    writeFileSync(join(repo, 'existing.ts'), 'implemented\n');
    const implemented = await git.commitTree(repo, 'implemented');
    const implementationPaths = await changedPaths(baseline, implemented);
    expect(hasEligibleRepositoryChanges('default', implementationPaths)).toBe(
      true,
    );
  });
});
