import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUserDataRoot } from '../paths';
import { QmdSearchProvider, type QmdRunner } from './qmd';

afterEach(() => {
  setUserDataRoot(undefined);
});

describe('QmdSearchProvider', () => {
  it('creates, indexes, embeds, and queries an isolated project collection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-qmd-'));
    setUserDataRoot(root);
    const run = vi.fn<QmdRunner>(async (args) => {
      if (args[0] === 'collection' && args[1] === 'show') {
        throw new Error('collection not found');
      }
      if (args[0] === 'query') {
        return {
          stdout: JSON.stringify([
            {
              file: 'qmd://harness-project-1/components/api.md',
              title: 'API',
              snippet: 'Authentication context',
              score: 0.91,
            },
          ]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const provider = new QmdSearchProvider(run);

    const results = await provider.search({
      projectId: 'project-1',
      root: '/knowledge',
      commit: 'abc',
      query: 'authentication',
      limit: 4,
      rerank: false,
      stateRoot: root,
    });

    expect(results).toEqual([
      {
        path: 'components/api.md',
        title: 'API',
        snippet: 'Authentication context',
        score: 0.91,
      },
    ]);
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['collection', 'show', 'harness-project-1'],
      [
        'collection',
        'add',
        '/knowledge',
        '--name',
        'harness-project-1',
        '--mask',
        '**/*.md',
      ],
      ['update'],
      ['embed', '-c', 'harness-project-1'],
      [
        'query',
        'authentication',
        '--json',
        '-n',
        '4',
        '-c',
        'harness-project-1',
        '--no-rerank',
      ],
    ]);
    expect(run.mock.calls[0][1]).toMatchObject({
      NO_COLOR: '1',
      XDG_CONFIG_HOME: expect.stringContaining('qmd-config'),
      XDG_CACHE_HOME: expect.stringContaining('qmd-cache'),
    });
  });

  it('does not re-index an unchanged knowledge commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-qmd-'));
    setUserDataRoot(root);
    const run = vi.fn<QmdRunner>(async (args) => ({
      stdout: args[0] === 'query' ? '[]' : '',
      stderr: '',
    }));
    const provider = new QmdSearchProvider(run);
    const options = {
      projectId: 'project-1',
      root: '/knowledge',
      commit: 'abc',
      query: 'api',
      limit: 4,
      rerank: true,
      stateRoot: root,
    };

    await provider.search(options);
    await provider.search(options);

    expect(
      run.mock.calls.filter(([args]) => args[0] === 'update'),
    ).toHaveLength(1);
    expect(run.mock.calls.filter(([args]) => args[0] === 'embed')).toHaveLength(
      1,
    );
    expect(run.mock.calls.filter(([args]) => args[0] === 'query')).toHaveLength(
      2,
    );
  });
});
