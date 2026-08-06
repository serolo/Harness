import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { AgentRegistry } from './registry';
import { MAX_AGENT_FILE_BYTES } from './config';

let root: string;
let builtins: string;
let projects: string;
let registry: AgentRegistry;
const emitChanged = vi.fn();
const trashItem = vi.fn(async (path: string) => {
  await rm(path, { recursive: true });
});

function config(name: string, harness = 'claude_code'): string {
  return `version: 1
name: ${name}
description: Safe test agent
prompt: Coordinate the work.
executor:
  harness: ${harness}
  mode: plan
requires:
  providers: [${harness}]
`;
}

async function addBundle(
  parent: string,
  slug: string,
  name: string,
): Promise<string> {
  const dir = join(parent, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.yaml'), config(name));
  return dir;
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'harness-agent-registry-'));
  builtins = join(root, 'builtins');
  projects = join(root, 'projects');
  await addBundle(builtins, 'builtin-one', 'Built in');
  registry = new AgentRegistry({
    builtinsRoot: builtins,
    projectRoot: (projectId) => join(projects, projectId),
    detectProviders: async () => [
      { id: 'claude_code', installed: true, authenticated: true },
      { id: 'codex', installed: false, authenticated: false },
      { id: 'cursor', installed: false, authenticated: false },
    ],
    emitChanged,
    trashItem,
  });
});

afterEach(async () => {
  await registry.stop();
  await rm(root, { recursive: true });
});

describe('AgentRegistry lifecycle', () => {
  it('lists stable built-in and project IDs without leaking managed paths', async () => {
    await addBundle(join(projects, 'project-a'), 'custom-one', 'Custom');

    const agents = await registry.list('project-a');

    expect(agents.map((agent) => agent.id)).toEqual([
      'builtin:builtin-one',
      'project:project-a:custom-one',
    ]);
    expect(agents[0]).toMatchObject({
      origin: 'builtin',
      editable: false,
      available: true,
    });
    expect(JSON.stringify(agents)).not.toContain(root);
  });

  it('reports provider availability and refuses to resolve unavailable agents', async () => {
    const dir = await addBundle(
      join(projects, 'project-a'),
      'codex-only',
      'Codex',
    );
    await writeFile(join(dir, 'config.yaml'), config('Codex', 'codex'));

    const [agent] = (await registry.list('project-a')).filter(
      (item) => item.slug === 'codex-only',
    );
    expect(agent).toMatchObject({
      available: false,
      requiredProviders: ['codex'],
    });
    expect(agent?.unavailableReasons.join(' ')).toMatch(/codex/);
    await expect(
      registry.resolveSnapshot('project-a', 'project:project-a:codex-only'),
    ).rejects.toMatchObject({ code: 'harness' });
  });

  it('creates, duplicates, edits atomically, and reads only allowed files', async () => {
    const created = await registry.create(
      'project-a',
      'new-agent',
      'New agent',
    );
    expect(created).toMatchObject({
      id: 'project:project-a:new-agent',
      editable: true,
      valid: true,
    });
    const duplicate = await registry.duplicate(
      'project-a',
      created.id,
      'new-agent-copy',
    );
    expect(duplicate).not.toHaveProperty('snapshot');
    expect(
      (await registry.resolveSnapshot('project-a', duplicate.id)).name,
    ).toBe('New agent');

    const updated = await registry.saveFile(
      'project-a',
      created.id,
      'config.yaml',
      config('Renamed agent'),
    );
    expect(updated).not.toHaveProperty('snapshot');
    expect((await registry.resolveSnapshot('project-a', created.id)).name).toBe(
      'Renamed agent',
    );
    expect(
      await readFile(
        join(projects, 'project-a', 'new-agent', 'config.yaml'),
        'utf8',
      ),
    ).toBe(config('Renamed agent'));
    expect(
      (await registry.readFile('project-a', created.id, 'config.yaml')).content,
    ).toBe(config('Renamed agent'));
    await expect(
      registry.readFile('project-a', created.id, '../config.yaml'),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('preserves closed protocol identity when a built-in is duplicated', async () => {
    await writeFile(
      join(builtins, 'builtin-one', 'config.yaml'),
      config('Debby template').replace(
        'description:',
        'protocol: debby\ndescription:',
      ),
    );
    const source = (await registry.list('project-a')).find(
      (agent) => agent.slug === 'builtin-one',
    );
    expect(source?.protocol).toBe('debby');

    const duplicate = await registry.duplicate(
      'project-a',
      source!.id,
      'debby-copy',
    );
    expect(duplicate.protocol).toBe('debby');
    await expect(
      registry.resolveSnapshot('project-a', duplicate.id),
    ).resolves.toMatchObject({ protocol: 'debby', slug: 'debby-copy' });
  });

  it('creates and removes referenced bundle files in one atomic validation', async () => {
    const created = await registry.create('project-a', 'composed', 'Composed');
    const rootWithChild = `${config('Composed')}tools:\n  agents: [reviewer]\n`;
    const child = `version: 1\nname: Reviewer\nprompt: Review the change.\nexecutor:\n  harness: claude_code\n  mode: plan\ntools:\n  purposes: [review]\n`;

    const composed = await registry.saveBundleFiles('project-a', created.id, [
      { path: 'config.yaml', content: rootWithChild },
      { path: 'agents/reviewer/config.yaml', content: child },
    ]);
    expect(composed.files).toEqual([
      'agents/reviewer/config.yaml',
      'config.yaml',
    ]);
    await expect(
      registry.resolveSnapshot('project-a', created.id),
    ).resolves.toMatchObject({ roles: [{ slug: 'reviewer' }] });

    const simplified = await registry.saveBundleFiles('project-a', created.id, [
      { path: 'config.yaml', content: config('Composed') },
      { path: 'agents/reviewer/config.yaml', content: null },
    ]);
    expect(simplified.files).toEqual(['config.yaml']);
    expect(
      (await registry.resolveSnapshot('project-a', created.id)).roles,
    ).toEqual([]);
  });

  it('does not replace the last valid snapshot when a complete edit becomes invalid', async () => {
    const created = await registry.create('project-a', 'recoverable', 'Stable');
    const revision = created.revision;
    const invalidBundle = `${config('Broken')}tools:\n  agents: [missing-role]\n`;

    // The file is valid YAML but makes the complete bundle invalid. The editor path
    // must expose diagnostics while retaining the prior runnable snapshot.
    await expect(
      registry.saveFile('project-a', created.id, 'config.yaml', invalidBundle),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const retained = await registry.get('project-a', created.id);
    expect(retained.revision).toBe(revision);
    expect(retained.valid).toBe(true);
    expect(retained.diagnostics).toEqual([]);
    expect(
      await readFile(
        join(projects, 'project-a', 'recoverable', 'config.yaml'),
        'utf8',
      ),
    ).toContain('name: Stable');
  });

  it('imports by copy, allocates a collision-free slug, and rejects symlinks', async () => {
    const source = await addBundle(root, 'portable', 'Portable');
    await registry.create('project-a', 'portable', 'Existing');

    const imported = await registry.importBundle('project-a', source);
    expect(imported.id).toBe('project:project-a:portable-2');
    await writeFile(join(source, 'config.yaml'), config('Source changed'));
    expect(await registry.get('project-a', imported.id)).not.toHaveProperty(
      'snapshot',
    );
    expect(
      (await registry.resolveSnapshot('project-a', imported.id)).name,
    ).toBe('Portable');

    const linked = await addBundle(root, 'linked-import', 'Linked');
    await symlink(join(linked, 'config.yaml'), join(linked, 'linked.yaml'));
    await expect(
      registry.importBundle('project-a', linked),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(
      (await registry.list('project-a')).some(
        (agent) => agent.slug === 'linked-import',
      ),
    ).toBe(false);
  });

  it('rejects unexpected and oversized imports before publishing a managed bundle', async () => {
    const unexpected = await addBundle(root, 'unexpected', 'Unexpected');
    await writeFile(join(unexpected, 'payload.bin'), 'not allowed');
    await expect(
      registry.importBundle('project-a', unexpected),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    const oversized = await addBundle(root, 'oversized', 'Oversized');
    await writeFile(
      join(oversized, 'config.yaml'),
      `${config('Oversized')}#${'x'.repeat(MAX_AGENT_FILE_BYTES)}`,
    );
    await expect(
      registry.importBundle('project-a', oversized),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(
      (await registry.list('project-a')).map((agent) => agent.slug),
    ).not.toEqual(expect.arrayContaining(['unexpected', 'oversized']));
  });

  it('rejects oversized saves without changing the last-valid runnable revision', async () => {
    const created = await registry.create('project-a', 'bounded', 'Bounded');
    await expect(
      registry.saveFile(
        'project-a',
        created.id,
        'config.yaml',
        'x'.repeat(MAX_AGENT_FILE_BYTES + 1),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(
      (await registry.resolveSnapshot('project-a', created.id)).revision,
    ).toBe(created.revision);
  });

  it('reloads external changes and deletes while retaining the last valid runnable snapshot', async () => {
    const projectRoot = join(projects, 'project-a');
    const bundle = await addBundle(projectRoot, 'watched', 'Initial');
    const id = 'project:project-a:watched';
    await registry.list('project-a');
    const watcher = (
      registry as unknown as {
        watchers: Map<string, { getWatched: () => Record<string, string[]> }>;
      }
    ).watchers.get('project-a');
    await vi.waitFor(
      () =>
        expect(Object.keys(watcher?.getWatched() ?? {})).not.toHaveLength(0),
      { timeout: 3_000 },
    );

    await writeFile(join(bundle, 'config.yaml'), config('External change'));
    await vi.waitFor(
      async () =>
        expect((await registry.get('project-a', id)).name).toBe(
          'External change',
        ),
      { timeout: 3_000 },
    );
    const lastValid = await registry.resolveSnapshot('project-a', id);

    await writeFile(
      join(bundle, 'config.yaml'),
      `${config('Broken draft')}tools:\n  agents: [missing-role]\n`,
    );
    await vi.waitFor(
      async () =>
        expect(
          (await registry.get('project-a', id)).diagnostics.length,
        ).toBeGreaterThan(0),
      { timeout: 3_000 },
    );
    await expect(registry.resolveSnapshot('project-a', id)).resolves.toEqual(
      lastValid,
    );

    await rm(bundle, { recursive: true });
    await vi.waitFor(
      async () =>
        expect(
          (await registry.list('project-a')).some((item) => item.id === id),
        ).toBe(false),
      { timeout: 3_000 },
    );
    expect(emitChanged).toHaveBeenCalledWith('project-a', undefined, 'changed');
  });

  it('enforces project ownership and built-in immutability', async () => {
    await expect(
      registry.saveFile(
        'project-a',
        'builtin:builtin-one',
        'config.yaml',
        config('Changed'),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      registry.delete('project-a', 'builtin:builtin-one'),
    ).rejects.toMatchObject({ code: 'conflict' });

    const custom = await registry.create('project-a', 'private', 'Private');
    await expect(registry.get('project-b', custom.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('blocks referenced deletes and otherwise delegates deletion to recoverable trash', async () => {
    await registry.stop();
    const referenced = vi.fn(async () => true);
    registry = new AgentRegistry({
      builtinsRoot: builtins,
      projectRoot: (projectId) => join(projects, projectId),
      detectProviders: async () => [],
      trashItem,
      isAgentReferenced: referenced,
    });
    const custom = await registry.create('project-a', 'scheduled', 'Scheduled');
    await expect(registry.delete('project-a', custom.id)).rejects.toMatchObject(
      {
        code: 'conflict',
      },
    );
    expect(trashItem).not.toHaveBeenCalled();

    referenced.mockResolvedValue(false);
    await registry.delete('project-a', custom.id);
    expect(trashItem).toHaveBeenCalledWith(
      join(projects, 'project-a', 'scheduled'),
    );
  });
});
