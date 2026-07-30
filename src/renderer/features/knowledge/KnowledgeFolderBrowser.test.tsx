import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WikiPageSummary } from '@shared/knowledge';
import {
  buildKnowledgeTree,
  KnowledgeFolderBrowser,
} from './KnowledgeFolderBrowser';

function page(path: string, title: string): WikiPageSummary {
  return {
    id: path,
    path,
    title,
    type: 'Document',
    status: 'canonical',
    tags: [],
  };
}

describe('buildKnowledgeTree', () => {
  it('builds arbitrary-depth folders and naturally sorts folders before pages', () => {
    const tree = buildKnowledgeTree([
      page('components/zeta.md', 'Zeta'),
      page('overview.md', 'Overview'),
      page('sources/claude/team10.md', 'Team 10'),
      page('sources/claude/team2.md', 'Team 2'),
      page('architecture/system.md', 'System'),
      page('components/alpha.md', 'Alpha'),
    ]);

    expect(tree.folders.map((folder) => folder.name)).toEqual([
      'architecture',
      'components',
      'sources',
    ]);
    expect(tree.pages.map((entry) => entry.title)).toEqual(['Overview']);

    const sources = tree.folders[2];
    expect(sources.pageCount).toBe(2);
    expect(sources.folders[0].pages.map((entry) => entry.title)).toEqual([
      'Team 2',
      'Team 10',
    ]);
  });
});

describe('KnowledgeFolderBrowser', () => {
  it('renders a collapsed accessible tree, root pages, counts, and nested groups', () => {
    render(
      <KnowledgeFolderBrowser
        pages={[
          page('sources/claude/notes.md', 'Notes'),
          page('sources/index.md', 'Sources index'),
          page('welcome.md', 'Welcome'),
        ]}
        onOpenPage={vi.fn()}
      />,
    );

    const tree = screen.getByRole('navigation', { name: 'Knowledge pages' });
    expect(within(tree).getByRole('button', { name: /sources 2 pages/i }))
      .toHaveAttribute('aria-expanded', 'false');
    expect(within(tree).getByRole('button', { name: /Welcome/i }))
      .toHaveAttribute('title', 'welcome.md');
    expect(screen.queryByRole('button', { name: /claude/i }))
      .not.toBeInTheDocument();

    fireEvent.click(
      within(tree).getByRole('button', { name: /sources 2 pages/i }),
    );
    const nestedFolder = screen.getByRole('button', {
      name: /claude 1 page/i,
    });
    expect(nestedFolder).toHaveAttribute('title', 'sources/claude');
  });

  it('opens a page with its unchanged canonical path', () => {
    const onOpenPage = vi.fn();
    render(
      <KnowledgeFolderBrowser
        pages={[page('sources/claude/notes.md', 'Notes')]}
        onOpenPage={onOpenPage}
        expandedFolders={new Set(['sources', 'sources/claude'])}
        onExpandedFoldersChange={vi.fn()}
      />,
    );

    const notes = screen.getByRole('button', { name: /Notes/i });
    expect(notes).toHaveAttribute('title', 'sources/claude/notes.md');
    fireEvent.click(notes);
    expect(onOpenPage).toHaveBeenCalledWith('sources/claude/notes.md');
  });

  it('reveals each imported wiki subfolder with keyboard expansion', () => {
    render(
      <KnowledgeFolderBrowser
        pages={[
          page(
            'sources/agent-memory/claude_code/bundle/guides/setup.md',
            'Setup',
          ),
        ]}
        onOpenPage={vi.fn()}
      />,
    );

    for (const name of [
      'sources',
      'agent-memory',
      'claude_code',
      'bundle',
      'guides',
    ]) {
      const folder = screen.getByRole('button', {
        name: new RegExp(`${name} 1 page`, 'i'),
      });
      fireEvent.keyDown(folder, { key: 'ArrowRight' });
      expect(folder).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.getByRole('button', { name: /Setup/i })).toHaveAttribute(
      'title',
      'sources/agent-memory/claude_code/bundle/guides/setup.md',
    );
  });

  it('shows an empty state', () => {
    render(<KnowledgeFolderBrowser pages={[]} onOpenPage={vi.fn()} />);
    expect(screen.getByText('No knowledge pages yet.')).toBeInTheDocument();
  });
});
