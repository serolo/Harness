import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { loadAgentBundle } from './config';
import { builtinAgentsDir } from '../paths';

const packagedResources = join(process.cwd(), 'resources');
const builtinRoot = builtinAgentsDir({
  packaged: true,
  resourcesPath: packagedResources,
});

describe('packaged built-in agents', () => {
  it('resolves the same extraResources layout used by the packaged app', () => {
    expect(builtinRoot).toBe(join(packagedResources, 'builtin-agents'));
  });
  it.each([
    ['polly', ['implementer', 'investigator', 'reviewer'], 0],
    [
      'debby',
      ['claude-critic', 'claude-partner', 'codex-critic', 'codex-partner'],
      1,
    ],
    ['harness', ['analyst', 'coder', 'reviewer', 'test-author', 'verifier'], 0],
  ] as const)(
    'loads %s through the public import schema with its exact role graph',
    async (slug, roles, critiqueRounds) => {
      const result = await loadAgentBundle(join(builtinRoot, slug));

      expect(result.diagnostics).toEqual([]);
      expect(result.snapshot).toBeDefined();
      expect(result.snapshot?.roles.map((role) => role.slug).sort()).toEqual(
        [...roles].sort(),
      );
      expect(result.snapshot?.policy.critiqueRounds).toBe(critiqueRounds);
      expect(result.snapshot?.requiredProviders).toEqual([
        'claude_code',
        'codex',
      ]);
      expect(result.snapshot?.capabilities).not.toContain('merge');
      expect(result.snapshot?.prompt.toLowerCase()).not.toContain('auto-merge');
    },
  );

  it('enforces independent-provider review for Polly and Harness', async () => {
    const polly = await loadAgentBundle(join(builtinRoot, 'polly'));
    const harness = await loadAgentBundle(join(builtinRoot, 'harness'));

    expect(
      polly.snapshot?.roles.find((role) => role.slug === 'reviewer'),
    ).toMatchObject({
      executor: { harness: 'codex' },
      independentProvider: true,
    });
    expect(
      harness.snapshot?.roles
        .filter((role) =>
          ['reviewer', 'test-author', 'verifier'].includes(role.slug),
        )
        .every((role) => role.independentProvider),
    ).toBe(true);
  });

  it('keeps Debby partner providers and critique roles explicit', async () => {
    const debby = await loadAgentBundle(join(builtinRoot, 'debby'));
    const bySlug = new Map(
      debby.snapshot?.roles.map((role) => [role.slug, role]),
    );

    expect(debby.snapshot?.protocol).toBe('debby');
    expect(bySlug.get('claude-partner')).toMatchObject({
      executor: {
        harness: 'claude_code',
        mode: 'plan',
        readOnlyMode: true,
      },
      purposes: ['research', 'plan'],
    });
    expect(bySlug.get('codex-partner')).toMatchObject({
      executor: {
        harness: 'codex',
        mode: 'default',
        readOnlyMode: true,
      },
      purposes: ['research', 'plan'],
    });
    expect(bySlug.get('claude-critic')).toMatchObject({
      executor: {
        harness: 'claude_code',
        mode: 'plan',
        readOnlyMode: true,
      },
      purposes: ['critique'],
    });
    expect(bySlug.get('codex-critic')).toMatchObject({
      executor: {
        harness: 'codex',
        mode: 'default',
        readOnlyMode: true,
      },
      purposes: ['critique'],
    });
    expect(debby.snapshot?.policy.critiqueRounds).toBe(1);
    expect(debby.snapshot?.coordinator).toMatchObject({
      harness: 'claude_code',
      mode: 'plan',
      readOnlyMode: true,
    });
    expect(
      debby.snapshot?.roles.every((role) => role.executor.readOnlyMode),
    ).toBe(true);
  });

  it('never assigns Codex a fake plan mode in any built-in role', async () => {
    for (const slug of ['polly', 'debby', 'harness']) {
      const result = await loadAgentBundle(join(builtinRoot, slug));
      const codexRoles =
        result.snapshot?.roles.filter(
          (role) => role.executor.harness === 'codex',
        ) ?? [];

      expect(codexRoles.length).toBeGreaterThan(0);
      expect(codexRoles.every((role) => role.executor.mode === 'default')).toBe(
        true,
      );
    }
  });
});
