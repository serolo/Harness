import {
  lstat,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import type {
  AgentMemoryDiscovery,
  AgentMemoryExclusionReason,
  AgentMemoryProvider,
  AgentMemoryProposalResult,
  AgentMemorySource,
  WikiOperation,
  WikiPage,
  WikiProposal,
} from '@shared/knowledge';
import { AppError } from '@shared/errors';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_DISCOVERED = 100;
const MAX_SELECTED = MAX_DISCOVERED * 2;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const MAX_DISCOVERIES = 20;
const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
]);

interface SourceDescriptor {
  id: string;
  path: string;
  confinementRoot: string;
  label: string;
  displayPath: string;
  kind: AgentMemorySource['kind'];
  identityKey: string;
  bundleRelativePath?: string;
  bundleId?: string;
}

interface DiscoveryState {
  projectId: string;
  provider: AgentMemoryProvider;
  createdAt: number;
  sources: Map<string, SourceDescriptor>;
  blockedBundleIds: Set<string>;
  bundleManifests: Map<
    string,
    { root: string; relativePaths: string[] }
  >;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function providerLabel(provider: AgentMemoryProvider): string {
  return provider === 'claude_code' ? 'Claude Code' : 'Codex';
}

export function hasSecret(content: string): boolean {
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/,
    /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[^\s"'`]{12,}/i,
  ].some((pattern) => pattern.test(content));
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\.md$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'memory'
  );
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function titleFor(content: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || fallback;
}

async function markdownFiles(
  root: string,
  mode: 'instructions' | 'memory',
): Promise<string[]> {
  const result: string[] = [];
  const rootReal = await realpath(root).catch(() => null);
  if (rootReal === null) return result;

  const visit = async (dir: string, isRoot: boolean): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (
      !isRoot &&
      entries.some((entry) => entry.name === '.git')
    ) {
      return;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await visit(path, false);
        continue;
      }
      if (!entry.isFile()) continue;
      const matches =
        mode === 'instructions'
          ? entry.name === 'CLAUDE.md' || entry.name === 'AGENTS.md'
          : entry.name.toLowerCase().endsWith('.md');
      if (!matches) continue;
      if (result.length >= MAX_DISCOVERED) {
        throw new AppError(
          'invalid_input',
          `agent memory folder exceeds ${MAX_DISCOVERED} Markdown files`,
        );
      }
      const fileReal = await realpath(path).catch(() => null);
      if (fileReal !== null && inside(rootReal, fileReal)) result.push(fileReal);
    }
  };
  await visit(rootReal, true);
  return result.sort();
}

function normalizeBundlePage(input: {
  content: string;
  identity: string;
  contentDigest: string;
  timestamp: string;
}): string {
  const metadata = [
    `source_provider: claude_code`,
    `source_identity: ${input.identity}`,
    `source_digest: ${input.contentDigest}`,
  ].join('\n');
  if (!input.content.startsWith('---\n')) {
    return `---
type: Document
status: canonical
timestamp: ${yamlString(input.timestamp)}
tags: [agent-memory, imported, claude_code]
${metadata}
---

${input.content}`;
  }
  const end = input.content.indexOf('\n---', 4);
  if (end < 0) {
    throw new AppError(
      'invalid_input',
      'Claude memory page has malformed frontmatter',
    );
  }
  const lines = input.content.slice(4, end).split('\n');
  const preserved: string[] = [];
  let validType: string | undefined;
  let skipping = false;
  for (const line of lines) {
    const key = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (key !== null) {
      skipping = [
        'status',
        'source_provider',
        'source_identity',
        'source_digest',
      ].includes(key[1]);
      if (key[1] === 'type') {
        const value = key[2].trim();
        const quoted =
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"));
        const unquoted = quoted ? value.slice(1, -1).trim() : value;
        if (
          unquoted !== '' &&
          (quoted ||
            (!['true', 'false', 'null'].includes(unquoted) &&
              !/^-?\d+(?:\.\d+)?$/.test(unquoted) &&
              !unquoted.startsWith('[') &&
              !unquoted.startsWith('{')))
        ) {
          validType = line;
        }
        skipping = true;
      }
      if (!skipping) preserved.push(line);
      continue;
    }
    if (skipping && /^\s+\S/.test(line)) continue;
    skipping = false;
    preserved.push(line);
  }
  const additions = [
    validType ?? 'type: Document',
    'status: canonical',
    metadata,
  ].filter(Boolean);
  return `---
${additions.join('\n')}
${preserved.join('\n')}
${input.content.slice(end)}`;
}

function exclusionFor(
  content: Buffer,
): AgentMemoryExclusionReason | undefined {
  if (content.byteLength > MAX_SOURCE_BYTES) return 'too_large';
  if (content.includes(0)) return 'binary';
  if (hasSecret(content.toString('utf8'))) return 'secret_detected';
  return undefined;
}

async function readConfinedRegularFile(
  root: string,
  path: string,
  maxBytes = MAX_SOURCE_BYTES,
): Promise<
  { bytes: Buffer } | { reason: 'unreadable' | 'too_large' }
> {
  const rootReal = await realpath(root).catch(() => null);
  if (rootReal === null) return { reason: 'unreadable' };
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (handle === null) return { reason: 'unreadable' };
  try {
    const [openedStat, pathStat, fileReal] = await Promise.all([
      handle.stat(),
      lstat(path).catch(() => null),
      realpath(path).catch(() => null),
    ]);
    if (
      pathStat === null ||
      fileReal === null ||
      !openedStat.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      !inside(rootReal, fileReal)
    ) {
      return { reason: 'unreadable' };
    }
    if (openedStat.size > maxBytes) return { reason: 'too_large' };
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return { reason: 'too_large' };
    return { bytes: buffer.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

export class AgentMemoryImporter {
  private readonly discoveries = new Map<string, DiscoveryState>();
  private readonly consuming = new Set<string>();

  async discover(input: {
    projectId: string;
    provider: AgentMemoryProvider;
    repoPath: string;
    memoryRoot?: string;
  }): Promise<AgentMemoryDiscovery> {
    const now = Date.now();
    for (const [id, state] of this.discoveries) {
      if (now - state.createdAt > DISCOVERY_TTL_MS) this.discoveries.delete(id);
    }
    const repoRoot = await realpath(input.repoPath);
    const instructionName =
      input.provider === 'claude_code' ? 'CLAUDE.md' : 'AGENTS.md';
    const repositoryFiles = (
      await markdownFiles(repoRoot, 'instructions')
    ).filter((path) => basename(path) === instructionName);

    const external: { path: string; root: string }[] = [];
    for (const candidateRoot of input.memoryRoot ? [input.memoryRoot] : []) {
      const root = await realpath(candidateRoot).catch(() => null);
      if (root === null) continue;
      for (const path of await markdownFiles(root, 'memory')) {
        external.push({ path, root });
      }
    }

    const discoveryId = randomUUID();
    const descriptors = new Map<string, SourceDescriptor>();
    const blockedBundleIds = new Set<string>();
    const bundleManifests = new Map<
      string,
      { root: string; relativePaths: string[] }
    >();
    if (input.provider === 'claude_code') {
      for (const { root } of external) {
        const bundleId = digest(root).slice(0, 16);
        if (bundleManifests.has(bundleId)) continue;
        bundleManifests.set(bundleId, {
          root,
          relativePaths: external
            .filter((item) => item.root === root)
            .map((item) => relative(root, item.path).split(sep).join('/'))
            .sort(),
        });
      }
    }
    const sources: AgentMemorySource[] = [];
    const seen = new Set<string>();
    const candidates = [
      ...repositoryFiles.map((path) => ({
        path,
        root: repoRoot,
        kind: 'project_instruction' as const,
        displayPath: relative(repoRoot, path).split(sep).join('/'),
      })),
      ...external.map(({ path, root }) => ({
        path,
        root,
        kind: 'provider_memory' as const,
        displayPath: `Provider memory / ${relative(root, path)
          .split(sep)
          .join('/')}`,
      })),
    ];
    for (const candidate of candidates) {
      if (seen.has(candidate.path)) continue;
      seen.add(candidate.path);
      const read = await readConfinedRegularFile(
        candidate.root,
        candidate.path,
      );
      const id = randomUUID();
      const reason =
        'reason' in read ? read.reason : exclusionFor(read.bytes);
      const bytes = 'bytes' in read ? read.bytes : null;
      const label = basename(candidate.path).replace(/\.md$/i, '');
      const source: AgentMemorySource = {
        id,
        provider: input.provider,
        label,
        displayPath: candidate.displayPath,
        size: bytes?.byteLength ?? 0,
        kind: candidate.kind,
        eligible: reason === undefined,
        ...(reason === undefined
          ? { preview: bytes!.toString('utf8').replace(/\s+/g, ' ').slice(0, 400) }
          : { exclusionReason: reason }),
      };
      sources.push(source);
      if (source.eligible) {
        const bundleId =
          candidate.kind === 'provider_memory' &&
          input.provider === 'claude_code'
            ? digest(candidate.root).slice(0, 16)
            : undefined;
        descriptors.set(id, {
          id,
          path: candidate.path,
          confinementRoot: candidate.root,
          label,
          displayPath: candidate.displayPath,
          kind: candidate.kind,
          identityKey: `${candidate.kind}:${digest(candidate.root).slice(
            0,
            16,
          )}:${relative(candidate.root, candidate.path)
            .split(sep)
            .join('/')}`,
          ...(bundleId
            ? {
                bundleId,
                bundleRelativePath: relative(
                  candidate.root,
                  candidate.path,
                )
                  .split(sep)
                  .join('/'),
              }
            : {}),
        });
      } else if (
        candidate.kind === 'provider_memory' &&
        input.provider === 'claude_code'
      ) {
        blockedBundleIds.add(digest(candidate.root).slice(0, 16));
      }
    }

    if (blockedBundleIds.size > 0) {
      for (const source of sources) {
        const descriptor = descriptors.get(source.id);
        if (
          descriptor?.bundleId !== undefined &&
          blockedBundleIds.has(descriptor.bundleId)
        ) {
          source.eligible = false;
          source.exclusionReason = 'unsupported';
          delete source.preview;
          descriptors.delete(source.id);
        }
      }
    }

    this.discoveries.set(discoveryId, {
      projectId: input.projectId,
      provider: input.provider,
      createdAt: Date.now(),
      sources: descriptors,
      blockedBundleIds,
      bundleManifests,
    });
    while (this.discoveries.size > MAX_DISCOVERIES) {
      const oldest = [...this.discoveries.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      )[0];
      if (oldest === undefined) break;
      this.discoveries.delete(oldest[0]);
    }
    return {
      discoveryId,
      provider: input.provider,
      sources,
      eligibleCount: sources.filter((source) => source.eligible).length,
      excludedCount: sources.filter((source) => !source.eligible).length,
    };
  }

  async createProposal(input: {
    projectId: string;
    provider: AgentMemoryProvider;
    discoveryId: string;
    sourceIds: string[];
    existingPages: WikiPage[];
    persist: (operations: WikiOperation[]) => Promise<WikiProposal>;
  }): Promise<AgentMemoryProposalResult> {
    const state = this.discoveries.get(input.discoveryId);
    if (state === undefined) {
      throw new AppError('not_found', 'agent memory discovery not found');
    }
    if (this.consuming.has(input.discoveryId)) {
      throw new AppError('conflict', 'agent memory discovery is already in use');
    }
    if (Date.now() - state.createdAt > DISCOVERY_TTL_MS) {
      this.discoveries.delete(input.discoveryId);
      throw new AppError('conflict', 'agent memory discovery expired');
    }
    if (
      state.projectId !== input.projectId ||
      state.provider !== input.provider
    ) {
      throw new AppError('invalid_input', 'agent memory discovery does not match');
    }
    if (
      input.sourceIds.length === 0 ||
      input.sourceIds.length > MAX_SELECTED ||
      new Set(input.sourceIds).size !== input.sourceIds.length
    ) {
      throw new AppError('invalid_input', 'invalid agent memory selection');
    }
    if (input.sourceIds.some((sourceId) => !state.sources.has(sourceId))) {
      throw new AppError('invalid_input', 'unknown agent memory source');
    }
    const selected = input.sourceIds.map((sourceId) => state.sources.get(sourceId)!);
    const selectedBundleIds = new Set(
      selected.flatMap((source) =>
        source.bundleId === undefined ? [] : [source.bundleId],
      ),
    );
    for (const bundleId of selectedBundleIds) {
      if (state.blockedBundleIds.has(bundleId)) {
        throw new AppError(
          'invalid_input',
          'Claude memory bundle contains an excluded file',
        );
      }
      const bundleSourceIds = [...state.sources.values()]
        .filter((source) => source.bundleId === bundleId)
        .map((source) => source.id);
      if (bundleSourceIds.some((sourceId) => !input.sourceIds.includes(sourceId))) {
        throw new AppError(
          'invalid_input',
          'Claude memory bundle must be imported as a whole',
        );
      }
    }

    this.consuming.add(input.discoveryId);
    try {
      for (const bundleId of selectedBundleIds) {
        const manifest = state.bundleManifests.get(bundleId);
        if (manifest === undefined) {
          throw new AppError(
            'conflict',
            'Claude memory bundle manifest is missing',
          );
        }
        const currentPaths = (await markdownFiles(manifest.root, 'memory')).map(
          (path) => relative(manifest.root, path).split(sep).join('/'),
        );
        if (
          currentPaths.length !== manifest.relativePaths.length ||
          currentPaths.some(
            (path, index) => path !== manifest.relativePaths[index],
          )
        ) {
          throw new AppError(
            'conflict',
            'Claude memory bundle changed after discovery',
          );
        }
      }
      const existingByIdentity = new Map<string, WikiPage>();
      for (const page of input.existingPages) {
        const identity = page.frontmatter.source_identity;
        if (typeof identity === 'string') existingByIdentity.set(identity, page);
      }

      let totalBytes = 0;
      let skippedCount = 0;
      let excludedCount = 0;
      const operations: WikiOperation[] = [];
      for (const sourceId of input.sourceIds) {
        const source = state.sources.get(sourceId)!;
        const read = await readConfinedRegularFile(
          source.confinementRoot,
          source.path,
        );
        if ('reason' in read || exclusionFor(read.bytes) !== undefined) {
          if (source.bundleId !== undefined) {
            throw new AppError(
              'invalid_input',
              'Claude memory bundle changed or contains an unsafe file',
            );
          }
          excludedCount += 1;
          continue;
        }
        const { bytes } = read;
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new AppError('invalid_input', 'selected agent memory exceeds 5 MB');
        }
        const body = bytes.toString('utf8').trim();
        const identity = `${input.provider}:${digest(
          source.identityKey,
        ).slice(0, 24)}`;
        const contentDigest = digest(body);
        const existing = existingByIdentity.get(identity);
        if (existing?.frontmatter.source_digest === contentDigest) {
          skippedCount += 1;
          continue;
        }
        const title = titleFor(body, source.label);
        const suffix = identity.slice(-8);
        const path =
          existing?.path ??
          (source.bundleId !== undefined &&
          source.bundleRelativePath !== undefined
            ? `sources/agent-memory/claude_code/${source.bundleId}/${source.bundleRelativePath}`
            : `sources/agent-memory/${input.provider}-${slug(source.label)}-${suffix}.md`);
        const content =
          source.bundleId !== undefined
            ? normalizeBundlePage({
                content: bytes.toString('utf8'),
                identity,
                contentDigest,
                timestamp: new Date().toISOString(),
              })
            : `---
type: Imported Agent Memory
title: ${yamlString(title)}
status: canonical
timestamp: ${yamlString(new Date().toISOString())}
tags: [agent-memory, imported, ${input.provider}]
source_provider: ${input.provider}
source_identity: ${identity}
source_digest: ${contentDigest}
---

# ${title}

> Imported from ${providerLabel(input.provider)} memory. Treat this material as unverified until this proposal is reviewed.

${body}
`;
        operations.push({
          op: existing === undefined ? 'create' : 'update',
          path,
          content,
        });
      }

      if (operations.length === 0) {
        this.discoveries.delete(input.discoveryId);
        return {
          selectedCount: input.sourceIds.length,
          operationCount: 0,
          skippedCount,
          excludedCount,
        };
      }
      const proposal = await input.persist(operations);
      this.discoveries.delete(input.discoveryId);
      return {
        proposal,
        selectedCount: input.sourceIds.length,
        operationCount: operations.length,
        skippedCount,
        excludedCount,
      };
    } finally {
      this.consuming.delete(input.discoveryId);
    }
  }
}
