import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

import type { WikiPage, WikiSearchResult } from '@shared/knowledge';
import { QmdSearchProvider } from './qmd';
import { parseGatewayOkf } from './okf';

const RESERVED_PATHS = new Set(['index.md', 'log.md']);
const TOKEN_CHARACTERS = 4;
const MAX_QUERY_CHARACTERS = 2_000;
const MAX_LINE_RANGE = 500;

export type KnowledgeSearchProvider = 'qmd' | 'basic' | 'none';
export interface KnowledgeToolResult {
  content: [{ type: 'text'; text: string }];
  isError?: boolean;
}
export type KnowledgeRetrievalTraceEntry =
  | {
      operation: 'search';
      provider: KnowledgeSearchProvider;
      resultCount: number;
      contextTokens: number;
      query: string;
    }
  | {
      operation: 'read';
      provider: KnowledgeSearchProvider;
      path: string;
      contextTokens: number;
      truncated: boolean;
    }
  | {
      status: 'fallback' | 'failed';
      provider: KnowledgeSearchProvider;
      reason: 'gateway';
    };
export interface ProjectKnowledgeGatewayOptions {
  projectId: string;
  root: string;
  searchEnabled: boolean;
  provider: KnowledgeSearchProvider;
  maxResults: number;
  maxContextTokens: number;
  rerank: boolean;
  qmd?: Pick<QmdSearchProvider, 'search'>;
  commit?: string;
  qmdStateRoot?: string;
}
interface SearchRecord {
  page: WikiPage;
  haystack: string;
}

function toolResult(payload: unknown): KnowledgeToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function errorResult(message: string): KnowledgeToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function serializedTokens(result: KnowledgeToolResult): number {
  return Math.ceil(JSON.stringify(result).length / TOKEN_CHARACTERS);
}
function normalizeRelativePath(path: string): string | null {
  if (path.includes('\0') || path.trim() === '' || extname(path) !== '.md')
    return null;
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..'))
    return null;
  const name = normalized.split('/').at(-1)?.toLowerCase();
  return name && RESERVED_PATHS.has(name) ? null : normalized;
}
function pageFromContent(path: string, content: string): WikiPage | null {
  try {
    const parsed = parseGatewayOkf(content);
    if (parsed.frontmatter.status !== 'canonical') return null;
    const title =
      typeof parsed.frontmatter.title === 'string'
        ? parsed.frontmatter.title
        : path;
    const tags = Array.isArray(parsed.frontmatter.tags)
      ? parsed.frontmatter.tags.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    return {
      id:
        typeof parsed.frontmatter.id === 'string'
          ? parsed.frontmatter.id
          : path,
      path,
      title,
      type:
        typeof parsed.frontmatter.type === 'string'
          ? parsed.frontmatter.type
          : 'Knowledge',
      status: 'canonical',
      tags,
      content,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      ...(typeof parsed.frontmatter.description === 'string'
        ? { description: parsed.frontmatter.description }
        : {}),
    };
  } catch {
    return null;
  }
}
async function markdownPaths(root: string, current = ''): Promise<string[]> {
  const entries = await readdir(resolve(root, current), {
    withFileTypes: true,
  });
  const paths: string[] = [];
  for (const entry of entries) {
    const child = current === '' ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await markdownPaths(root, child)));
    else if (entry.isFile() && extname(entry.name) === '.md') paths.push(child);
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

/** Read-only per-turn gateway with search-before-read and one cumulative response budget. */
export class ProjectKnowledgeGateway {
  private readonly searchedProviders = new Map<
    string,
    KnowledgeSearchProvider
  >();
  private readonly entries: KnowledgeRetrievalTraceEntry[] = [];
  private readonly qmd: Pick<QmdSearchProvider, 'search'>;
  private usedContextTokens = 0;
  private canonicalRoot?: string;

  constructor(private readonly options: ProjectKnowledgeGatewayOptions) {
    this.qmd = options.qmd ?? new QmdSearchProvider();
  }
  trace(): readonly KnowledgeRetrievalTraceEntry[] {
    return this.entries;
  }

  recordFailure(provider: KnowledgeSearchProvider = 'none'): void {
    this.entries.push({ status: 'failed', provider, reason: 'gateway' });
  }

  private failure(
    message: string,
    provider: KnowledgeSearchProvider = this.options.provider,
  ): KnowledgeToolResult {
    this.recordFailure(provider);
    return errorResult(message);
  }

  async searchProjectKnowledge(query: string): Promise<KnowledgeToolResult> {
    if (!this.options.searchEnabled) {
      return this.failure('Project knowledge search is disabled.', 'none');
    }
    const normalizedQuery = query.trim().slice(0, MAX_QUERY_CHARACTERS);
    if (!normalizedQuery) return this.failure('A search query is required.');
    let pages: SearchRecord[];
    try {
      pages = await this.canonicalPages();
    } catch {
      return this.failure('Project knowledge search is unavailable.');
    }
    const byPath = new Map(pages.map((record) => [record.page.path, record]));
    let provider: KnowledgeSearchProvider =
      this.options.provider === 'none' ? 'none' : 'basic';
    let results: WikiSearchResult[] = [];
    if (this.options.provider === 'qmd') {
      try {
        const found = await this.qmd.search({
          projectId: this.options.projectId,
          root: await this.root(),
          commit: this.options.commit ?? 'working-tree',
          query: normalizedQuery,
          limit: this.options.maxResults,
          rerank: this.options.rerank,
          ...(this.options.qmdStateRoot
            ? { stateRoot: this.options.qmdStateRoot }
            : {}),
        });
        provider = 'qmd';
        results = found.flatMap((result): WikiSearchResult[] => {
          const record = byPath.get(result.path);
          return record
            ? [
                {
                  pageId: record.page.id,
                  path: record.page.path,
                  title: record.page.title,
                  snippet:
                    result.snippet ??
                    this.snippet(record.page.body, normalizedQuery),
                  score: result.score,
                  status: 'canonical',
                },
              ]
            : [];
        });
      } catch {
        this.entries.push({
          status: 'fallback',
          provider: 'basic',
          reason: 'gateway',
        });
        results = this.basicSearch(pages, normalizedQuery);
      }
    } else if (this.options.provider === 'basic') {
      results = this.basicSearch(pages, normalizedQuery);
    }
    const remaining = this.remainingTokens();
    const selected: Array<{
      path: string;
      title: string;
      snippet: string;
      score?: number;
    }> = [];
    for (const result of results.slice(
      0,
      Math.max(1, this.options.maxResults),
    )) {
      const candidate = {
        path: result.path,
        title: result.title,
        snippet: result.snippet.slice(0, 240),
        score: result.score,
      };
      if (
        serializedTokens(
          toolResult({ provider, results: [...selected, candidate] }),
        ) > remaining
      )
        break;
      selected.push(candidate);
    }
    const response = toolResult({ provider, results: selected });
    const contextTokens = serializedTokens(response);
    if (contextTokens > remaining)
      return this.failure(
        'The project knowledge context budget is exhausted.',
        provider,
      );
    this.usedContextTokens += contextTokens;
    for (const result of selected)
      this.searchedProviders.set(result.path, provider);
    this.entries.push({
      operation: 'search',
      provider,
      resultCount: selected.length,
      contextTokens,
      query: normalizedQuery,
    });
    return response;
  }

  async readProjectKnowledge(
    path: string,
    startLine?: number,
    endLine?: number,
  ): Promise<KnowledgeToolResult> {
    const normalized = normalizeRelativePath(path);
    if (!normalized) return this.failure('Knowledge path is invalid.');
    const provider = this.searchedProviders.get(normalized);
    if (!provider)
      return this.failure(
        'Search project knowledge first, then read one of the returned paths.',
      );
    let page: WikiPage | null;
    try {
      page = await this.readCanonicalPage(normalized);
    } catch {
      return this.failure('Project knowledge read is unavailable.', provider);
    }
    if (!page)
      return this.failure('Canonical knowledge page not found.', provider);
    if (
      (startLine !== undefined &&
        (!Number.isInteger(startLine) || startLine < 1)) ||
      (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1))
    ) {
      return this.failure(
        'Line ranges use positive, one-based integers.',
        provider,
      );
    }
    const firstLine = startLine ?? 1;
    const lastLine = Math.min(
      endLine ?? firstLine + MAX_LINE_RANGE - 1,
      firstLine + MAX_LINE_RANGE - 1,
    );
    if (lastLine < firstLine)
      return this.failure('endLine must not precede startLine.', provider);
    const lines = page.body.trim().split('\n');
    const selected = lines.slice(firstLine - 1, lastLine).join('\n');
    const make = (content: string, truncated: boolean): KnowledgeToolResult =>
      toolResult({
        path: page.path,
        title: page.title,
        startLine: firstLine,
        endLine: Math.min(lastLine, lines.length),
        content,
        truncated,
      });
    const remaining = this.remainingTokens();
    let result = make(selected, false);
    let tokens = serializedTokens(result);
    let truncated = false;
    if (tokens > remaining) {
      truncated = true;
      let low = 0;
      let high = selected.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (
          serializedTokens(make(selected.slice(0, middle), true)) <= remaining
        )
          low = middle;
        else high = middle - 1;
      }
      result = make(selected.slice(0, low), true);
      tokens = serializedTokens(result);
      if (tokens > remaining)
        return this.failure(
          'The project knowledge context budget is exhausted.',
          provider,
        );
    }
    this.usedContextTokens += tokens;
    this.entries.push({
      operation: 'read',
      provider,
      path: page.path,
      contextTokens: tokens,
      truncated,
    });
    return result;
  }

  private remainingTokens(): number {
    return Math.max(0, this.options.maxContextTokens - this.usedContextTokens);
  }
  private async root(): Promise<string> {
    this.canonicalRoot ??= await realpath(this.options.root);
    return this.canonicalRoot;
  }
  private async readCanonicalPage(path: string): Promise<WikiPage | null> {
    const root = await this.root();
    let actual: string;
    try {
      actual = await realpath(resolve(root, path));
      if (!(await stat(actual)).isFile()) return null;
    } catch {
      return null;
    }
    const rel = relative(root, actual);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
    return pageFromContent(path, await readFile(actual, 'utf8'));
  }
  private async canonicalPages(): Promise<SearchRecord[]> {
    const root = await this.root();
    const records: SearchRecord[] = [];
    for (const raw of await markdownPaths(root)) {
      const path = normalizeRelativePath(raw);
      if (!path) continue;
      const page = await this.readCanonicalPage(path);
      if (!page) continue;
      records.push({
        page,
        haystack: [
          page.title,
          page.path,
          page.description ?? '',
          page.tags.join(' '),
          page.body,
        ]
          .join('\n')
          .toLowerCase(),
      });
    }
    return records;
  }
  private basicSearch(
    pages: SearchRecord[],
    query: string,
  ): WikiSearchResult[] {
    const words = query
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 1);
    return pages
      .flatMap(({ page, haystack }): WikiSearchResult[] => {
        const score = words.reduce(
          (total, word) => total + (haystack.includes(word) ? 1 : 0),
          0,
        );
        return score
          ? [
              {
                pageId: page.id,
                path: page.path,
                title: page.title,
                snippet: this.snippet(page.body, query),
                score,
                status: 'canonical',
              },
            ]
          : [];
      })
      .sort(
        (a, b) =>
          (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path),
      );
  }
  private snippet(body: string, query: string): string {
    const compact = body.replace(/\s+/g, ' ').trim();
    const lower = compact.toLowerCase();
    const index =
      query
        .toLowerCase()
        .split(/\W+/)
        .map((word) => lower.indexOf(word))
        .find((value) => value >= 0) ?? 0;
    return compact.slice(Math.max(0, index - 60), index + 180);
  }
}
