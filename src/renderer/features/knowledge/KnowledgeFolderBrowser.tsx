import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import type { WikiPageSummary } from '@shared/knowledge';

export interface KnowledgeFolder {
  kind: 'folder';
  name: string;
  path: string;
  folders: KnowledgeFolder[];
  pages: WikiPageSummary[];
  pageCount: number;
}

export interface KnowledgeTree {
  folders: KnowledgeFolder[];
  pages: WikiPageSummary[];
}

interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  pages: WikiPageSummary[];
}

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function comparePages(
  left: WikiPageSummary,
  right: WikiPageSummary,
): number {
  return (
    naturalCollator.compare(left.title, right.title) ||
    naturalCollator.compare(left.path, right.path)
  );
}

function finishFolder(folder: MutableFolder): KnowledgeFolder {
  const folders = [...folder.folders.values()]
    .sort(
      (left, right) =>
        naturalCollator.compare(left.name, right.name) ||
        left.path.localeCompare(right.path),
    )
    .map(finishFolder);
  const pages = [...folder.pages].sort(comparePages);

  return {
    kind: 'folder',
    name: folder.name,
    path: folder.path,
    folders,
    pages,
    pageCount:
      pages.length +
      folders.reduce((total, child) => total + child.pageCount, 0),
  };
}

/** Builds the display tree without changing or normalising the canonical page paths. */
export function buildKnowledgeTree(pages: WikiPageSummary[]): KnowledgeTree {
  const root: MutableFolder = {
    name: '',
    path: '',
    folders: new Map(),
    pages: [],
  };

  for (const page of pages) {
    const segments = page.path.split('/');
    const folderSegments = segments.slice(0, -1).filter(Boolean);
    let parent = root;

    for (const segment of folderSegments) {
      const path = parent.path ? `${parent.path}/${segment}` : segment;
      let folder = parent.folders.get(segment);
      if (!folder) {
        folder = { name: segment, path, folders: new Map(), pages: [] };
        parent.folders.set(segment, folder);
      }
      parent = folder;
    }

    parent.pages.push(page);
  }

  const finished = finishFolder(root);
  return { folders: finished.folders, pages: finished.pages };
}

interface KnowledgeFolderBrowserBaseProps {
  pages: WikiPageSummary[];
  onOpenPage: (path: string) => void;
  compact?: boolean;
}

export type KnowledgeFolderBrowserProps = KnowledgeFolderBrowserBaseProps &
  (
    | {
        expandedFolders: ReadonlySet<string>;
        onExpandedFoldersChange: (folders: Set<string>) => void;
      }
    | {
        expandedFolders?: never;
        onExpandedFoldersChange?: never;
      }
  );

export function KnowledgeFolderBrowser({
  pages,
  onOpenPage,
  compact = false,
  expandedFolders,
  onExpandedFoldersChange,
}: KnowledgeFolderBrowserProps): React.JSX.Element {
  const [localExpandedFolders, setLocalExpandedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const tree = useMemo(() => buildKnowledgeTree(pages), [pages]);
  const controlled = expandedFolders !== undefined;
  const openFolders = controlled ? expandedFolders : localExpandedFolders;

  const toggleFolder = (path: string): void => {
    const next = new Set(openFolders);
    if (next.has(path)) next.delete(path);
    else next.add(path);

    if (controlled) onExpandedFoldersChange(next);
    else setLocalExpandedFolders(next);
  };

  const renderPage = (
    page: WikiPageSummary,
    _level: number,
  ): React.JSX.Element => (
    <li key={page.path}>
      <button
        type="button"
        title={page.path}
        onClick={() => onOpenPage(page.path)}
        className="flex w-full items-start gap-2 rounded-2 px-2 py-1.5 text-left outline-none transition-colors duration-fast hover:bg-bg-3 focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <FileText
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-3"
          aria-hidden
        />
        <span className="min-w-0">
          <span
            className={`block truncate text-fg-1 ${compact ? 'text-xs' : 'text-sm'}`}
          >
            {page.title}
          </span>
          <span className="block truncate text-2xs text-fg-3">
            {page.path.split('/').at(-1)}
          </span>
        </span>
      </button>
    </li>
  );

  const renderFolder = (
    folder: KnowledgeFolder,
    level: number,
  ): React.JSX.Element => {
    const open = openFolders.has(folder.path);
    return (
      <li key={folder.path}>
        <button
          type="button"
          aria-expanded={open}
          title={folder.path}
          onClick={() => toggleFolder(folder.path)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' && !open) {
              event.preventDefault();
              toggleFolder(folder.path);
            } else if (event.key === 'ArrowLeft' && open) {
              event.preventDefault();
              toggleFolder(folder.path);
            }
          }}
          className="flex w-full items-center gap-1.5 rounded-2 px-2 py-1.5 text-left text-xs font-semibold text-fg-2 outline-none transition-colors duration-fast hover:bg-bg-3 hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          <span
            className="text-2xs font-normal tabular-nums text-fg-3"
            aria-label={`${folder.pageCount} ${folder.pageCount === 1 ? 'page' : 'pages'}`}
          >
            {folder.pageCount}
          </span>
        </button>
        {open ? (
          <ul
            className="ml-3 border-l border-border-1 pl-1"
          >
            {folder.folders.map((child) =>
              renderFolder(child, level + 1),
            )}
            {folder.pages.map((page) => renderPage(page, level + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  if (pages.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-fg-3">
        No knowledge pages yet.
      </div>
    );
  }

  return (
    <nav aria-label="Knowledge pages">
      <ul className="space-y-0.5">
        {tree.folders.map((folder) => renderFolder(folder, 1))}
        {tree.pages.map((page) => renderPage(page, 1))}
      </ul>
    </nav>
  );
}
