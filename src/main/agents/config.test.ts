import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isAllowedAgentFile,
  loadAgentBundle,
  MAX_AGENT_BUNDLE_ENTRIES,
  MAX_AGENT_FILE_BYTES,
  parseAgentYaml,
  readBundleFile,
} from './config';

const roots: string[] = [];

async function tempBundle(slug = 'test-agent'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-agent-config-'));
  roots.push(root);
  const bundle = join(root, slug);
  await mkdir(bundle, { recursive: true });
  return bundle;
}

async function writeValidBundle(
  bundle: string,
  executor = 'harness: claude_code',
): Promise<void> {
  await mkdir(join(bundle, 'agents', 'worker'), { recursive: true });
  await mkdir(join(bundle, 'skills', 'review'), { recursive: true });
  await writeFile(
    join(bundle, 'config.yaml'),
    `version: 1
name: Test agent
description: Test coordinator
prompt: Coordinate the requested work.
executor:
  ${executor}
  mode: plan
tools:
  agents: [worker]
  skills: [review]
requires:
  providers: [claude_code, codex]
policy:
  max_dispatches: 2
  max_parallel: 1
`,
  );
  await writeFile(
    join(bundle, 'agents', 'worker', 'config.yaml'),
    `version: 1
name: Worker
prompt: Complete the bounded assignment.
executor:
  harness: codex
  mode: default
tools:
  purposes: [implement, review]
  independent_provider: true
`,
  );
  await writeFile(join(bundle, 'skills', 'review', 'SKILL.md'), '# Review\n');
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('parseAgentYaml', () => {
  it('rejects malformed YAML and duplicate keys', () => {
    expect(() => parseAgentYaml('name: [', 'config.yaml')).toThrow();
    expect(() =>
      parseAgentYaml('name: one\nname: two\n', 'config.yaml'),
    ).toThrow(/map keys must be unique|unique/i);
  });

  it('rejects aliases and executable or unknown root fields', () => {
    expect(() =>
      parseAgentYaml('name: &name x\nprompt: *name\n', 'config.yaml'),
    ).toThrow();
    for (const field of ['mcp_servers', 'python', 'environment', 'shell']) {
      expect(() =>
        parseAgentYaml(`name: Test\nprompt: Do work\n${field}: true\n`),
      ).toThrow(/unsupported root field/);
    }
  });

  it('rejects non-mapping roots, excessive depth, and oversized files', () => {
    expect(() => parseAgentYaml('- list')).toThrow(/root must be a mapping/);
    const nested = `${Array.from({ length: 22 }, (_, index) => `${'  '.repeat(index)}a:`).join('\n')}\n${'  '.repeat(22)}value: true`;
    expect(() => parseAgentYaml(nested)).toThrow(/maximum depth/);
    expect(() =>
      parseAgentYaml(`name: ${'x'.repeat(MAX_AGENT_FILE_BYTES)}`),
    ).toThrow(/too large/);
  });
});

describe('loadAgentBundle', () => {
  it('resolves root and child instructions relative to their own config files', async () => {
    const bundle = await tempBundle('instructions');
    await writeValidBundle(bundle);
    await writeFile(join(bundle, 'ROOT.md'), 'Root-only guidance.\n');
    await writeFile(
      join(bundle, 'agents', 'worker', 'WORKER.md'),
      'Child-only guidance.\n',
    );
    await writeFile(
      join(bundle, 'config.yaml'),
      (await readFile(join(bundle, 'config.yaml'), 'utf8')).replace(
        'description: Test coordinator',
        'description: Test coordinator\ninstructions: ROOT.md',
      ),
    );
    await writeFile(
      join(bundle, 'agents', 'worker', 'config.yaml'),
      (
        await readFile(join(bundle, 'agents', 'worker', 'config.yaml'), 'utf8')
      ).replace(
        'prompt: Complete',
        'instructions: WORKER.md\nprompt: Complete',
      ),
    );

    const result = await loadAgentBundle(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot?.instructions).toBe('Root-only guidance.\n');
    expect(result.snapshot?.roles[0]?.instructions).toBe(
      'Child-only guidance.\n',
    );
  });

  it('normalizes roles, skills, provider requirements, policy, and both executor shapes', async () => {
    for (const [slug, executor] of [
      ['direct', 'harness: claude_code'],
      ['nested', 'config:\n    harness: claude_code'],
    ] as const) {
      const bundle = await tempBundle(slug);
      await writeValidBundle(bundle, executor);
      const result = await loadAgentBundle(bundle);

      expect(result.diagnostics).toEqual([]);
      expect(result.snapshot).toMatchObject({
        slug,
        name: 'Test agent',
        coordinator: { harness: 'claude_code', mode: 'plan' },
        requiredProviders: ['claude_code', 'codex'],
        policy: { maxDispatches: 2, maxParallel: 1, maxDepth: 1 },
        roles: [
          {
            slug: 'worker',
            executor: { harness: 'codex', mode: 'default' },
            purposes: ['implement', 'review'],
            independentProvider: true,
          },
        ],
        skills: [{ slug: 'review', content: '# Review\n' }],
      });
      expect(result.snapshot?.revision).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('returns a diagnostic for missing references and unsupported executor values', async () => {
    const missing = await tempBundle('missing');
    await writeFile(
      join(missing, 'config.yaml'),
      'name: Missing\nprompt: Work\nexecutor:\n  harness: claude_code\ntools:\n  agents: [ghost]\n',
    );
    expect((await loadAgentBundle(missing)).diagnostics[0]?.message).toMatch(
      /missing referenced child config/,
    );

    const unsupported = await tempBundle('unsupported');
    await writeFile(
      join(unsupported, 'config.yaml'),
      'name: Unsafe\nprompt: Work\nexecutor:\n  harness: bash\n',
    );
    expect(
      (await loadAgentBundle(unsupported)).diagnostics[0]?.message,
    ).toMatch(/executor harness is unsupported/);
  });

  it('attributes malformed child YAML to its file and line', async () => {
    const bundle = await tempBundle('child-diagnostic');
    await writeValidBundle(bundle);
    await writeFile(
      join(bundle, 'agents', 'worker', 'config.yaml'),
      'name: Worker\nprompt: [\n',
    );

    const [diagnostic] = (await loadAgentBundle(bundle)).diagnostics;
    expect(diagnostic).toMatchObject({
      file: 'agents/worker/config.yaml',
      line: expect.any(Number),
      column: expect.any(Number),
    });
    expect(diagnostic?.message).not.toMatch(/^agents\/worker\/config\.yaml:/);
  });

  it('stops streamed discovery at the explicit bundle entry limit', async () => {
    const bundle = await tempBundle('entry-limit');
    await writeFile(join(bundle, 'config.yaml'), 'name: Limited\n');
    await Promise.all(
      Array.from({ length: MAX_AGENT_BUNDLE_ENTRIES }, (_, index) =>
        writeFile(join(bundle, `file-${index}.md`), '# bounded\n'),
      ),
    );

    expect((await loadAgentBundle(bundle)).diagnostics[0]?.message).toMatch(
      /exceeds 128 entries/,
    );
  });

  it('rejects nested surprises and symlinked files', async () => {
    const nested = await tempBundle('nested-files');
    await writeValidBundle(nested);
    await writeFile(join(nested, 'agents', 'worker', 'extra.txt'), 'surprise');
    expect((await loadAgentBundle(nested)).diagnostics[0]?.message).toMatch(
      /unexpected files/,
    );

    const linked = await tempBundle('linked');
    const outside = join(linked, '..', 'outside.yaml');
    await writeFile(outside, 'name: Outside');
    await symlink(outside, join(linked, 'config.yaml'));
    expect((await loadAgentBundle(linked)).diagnostics[0]?.message).toMatch(
      /not a regular file/,
    );
  });
});

describe('bundle file confinement', () => {
  it('accepts only the three supported relative path shapes', () => {
    expect(isAllowedAgentFile('config.yaml')).toBe(true);
    expect(isAllowedAgentFile('agents/worker/config.yaml')).toBe(true);
    expect(isAllowedAgentFile('skills/review/SKILL.md')).toBe(true);
    expect(isAllowedAgentFile('../config.yaml')).toBe(false);
    expect(isAllowedAgentFile('/tmp/config.yaml')).toBe(false);
    expect(isAllowedAgentFile('agents/worker/secret.txt')).toBe(false);
  });

  it('rejects traversal before touching the filesystem', async () => {
    const bundle = await tempBundle('confined');
    await expect(
      readBundleFile(bundle, '../config.yaml'),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
