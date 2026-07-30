import { describe, expect, it } from 'vitest';
import { readZipMarkdown } from './zip';
import { storedZip } from './zipFixture';

describe('knowledge ZIP reader', () => {
  it('reads Markdown and strips a common archive folder', async () => {
    const files = await readZipMarkdown(
      storedZip([
        {
          path: 'project-wiki/components/worker.md',
          content: '---\ntype: Component\n---\n# Worker',
        },
        {
          path: 'project-wiki/index.md',
          content: '# Knowledge',
        },
      ]),
    );

    expect(files).toEqual([
      {
        path: 'components/worker.md',
        content: '---\ntype: Component\n---\n# Worker',
      },
      { path: 'index.md', content: '# Knowledge' },
    ]);
  });

  it('rejects traversal and version-control metadata', async () => {
    await expect(
      readZipMarkdown(storedZip([{ path: '../escape.md', content: 'x' }])),
    ).rejects.toThrow('escapes its bundle');
    await expect(
      readZipMarkdown(storedZip([{ path: '.git/config.md', content: 'x' }])),
    ).rejects.toThrow('version-control metadata');
  });

  it('rejects duplicate normalized Markdown paths', async () => {
    await expect(
      readZipMarkdown(
        storedZip([
          { path: 'bundle/decisions/example.md', content: '# First' },
          { path: 'bundle/decisions/example.md', content: '# Second' },
        ]),
      ),
    ).rejects.toThrow('duplicate');
  });

  it('ignores macOS and hidden metadata while importing visible Markdown', async () => {
    await expect(
      readZipMarkdown(
        storedZip([
          { path: '__MACOSX/._overview.md', content: 'metadata' },
          { path: '.DS_Store', content: 'metadata' },
          { path: '._overview.md', content: 'metadata' },
          { path: '.private/notes.md', content: 'hidden notes' },
          {
            path: 'overview.md',
            content: '---\ntype: Project Overview\n---\n# Overview',
          },
        ]),
      ),
    ).resolves.toEqual([
      {
        path: 'overview.md',
        content: '---\ntype: Project Overview\n---\n# Overview',
      },
    ]);
  });
});
