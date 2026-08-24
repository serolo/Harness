import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import type { HarnessId } from '@shared/harness';
import type { SlashCommand } from '@shared/slash';

interface DiscoverOpts {
  harness?: HarnessId;
  workspaceDir?: string | null;
  homeDir?: string;
  adminDir?: string | null;
}

const MAX_FILES = 300;

type NativeProvider = Extract<HarnessId, 'claude_code' | 'codex'>;
type NativeProvenance = NonNullable<SlashCommand['provenance']>;

interface NativeRoot {
  path: string;
  kind: 'command' | 'skill';
  provider: NativeProvider;
  provenance: NativeProvenance;
}

export async function discoverNativeSlashCommands(
  opts: DiscoverOpts = {},
): Promise<SlashCommand[]> {
  const home = opts.homeDir ?? homedir();
  const roots = await nativeRoots(
    home,
    opts.workspaceDir ?? undefined,
    opts.harness,
    opts.adminDir === undefined ? '/etc/codex' : opts.adminDir,
  );
  const commands: SlashCommand[] = [];

  for (const root of roots) {
    const files = await collectFiles(root.path, root.kind);
    for (const file of files) {
      const cmd =
        root.kind === 'command'
          ? await commandFromMarkdown(file, root.provider, root.provenance)
          : await skillFromMarkdown(file, root.provider, root.provenance);
      if (cmd !== null) commands.push(cmd);
      if (commands.length >= MAX_FILES) return commands;
    }
  }

  return commands;
}

async function nativeRoots(
  home: string,
  workspaceDir: string | undefined,
  harness: HarnessId | undefined,
  adminDir: string | null,
): Promise<NativeRoot[]> {
  const roots: NativeRoot[] = [];

  if (harness === undefined || harness === 'claude_code') {
    if (workspaceDir !== undefined) {
      roots.push(
        {
          path: join(workspaceDir, '.claude'),
          kind: 'command',
          provider: 'claude_code',
          provenance: 'workspace',
        },
        {
          path: join(workspaceDir, '.claude'),
          kind: 'skill',
          provider: 'claude_code',
          provenance: 'workspace',
        },
      );
    }
    roots.push(
      {
        path: join(home, '.claude'),
        kind: 'command',
        provider: 'claude_code',
        provenance: 'user',
      },
      {
        path: join(home, '.claude'),
        kind: 'skill',
        provider: 'claude_code',
        provenance: 'user',
      },
    );
  }

  if (harness === undefined || harness === 'codex') {
    if (workspaceDir !== undefined) {
      const directories = await codexRepositoryDirectories(workspaceDir);
      directories.forEach((directory, index) => {
        roots.push({
          path: join(directory, '.agents', 'skills'),
          kind: 'skill',
          provider: 'codex',
          provenance: index === 0 ? 'workspace' : 'repository',
        });
      });
    }
    roots.push({
      path: join(home, '.agents', 'skills'),
      kind: 'skill',
      provider: 'codex',
      provenance: 'user',
    });
    if (adminDir !== null) {
      roots.push({
        path: join(adminDir, 'skills'),
        kind: 'skill',
        provider: 'codex',
        provenance: 'admin',
      });
    }
  }

  return roots;
}

async function codexRepositoryDirectories(
  workspaceDir: string,
): Promise<string[]> {
  const start = resolve(workspaceDir);
  let current = start;
  let repositoryRoot: string | undefined;
  for (;;) {
    try {
      await stat(join(current, '.git'));
      repositoryRoot = current;
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (repositoryRoot === undefined) return [start];
  const directories: string[] = [];
  current = start;
  for (;;) {
    directories.push(current);
    if (current === repositoryRoot) break;
    current = dirname(current);
  }
  return directories;
}

async function collectFiles(
  root: string,
  kind: 'command' | 'skill',
): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 9 || files.length >= MAX_FILES) return;
    try {
      const actual = await realpath(dir);
      if (visited.has(actual)) return;
      visited.add(actual);
    } catch {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const path = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(path)).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(path, depth + 1);
      } else if (entry.isFile()) {
        const parts = relative(root, path).split(/[\\/]/);
        if (
          kind === 'command' &&
          entry.name.endsWith('.md') &&
          parts.includes('commands')
        ) {
          files.push(path);
        } else if (kind === 'skill' && entry.name === 'SKILL.md') {
          files.push(path);
        }
      }
    }
  }

  await walk(root, 0);
  return files.sort((a, b) => a.localeCompare(b));
}

async function commandFromMarkdown(
  path: string,
  provider: NativeProvider,
  provenance: NativeProvenance,
): Promise<SlashCommand | null> {
  const raw = await readMarkdown(path);
  if (raw === null) return null;
  const parsed = parseMarkdownMeta(raw);
  const name = slashNameFromFile(path);
  if (name === null) return null;
  return {
    name,
    template:
      parsed.body.trim() === '' ? `Run /${name}.\n\n$ARGS` : parsed.body,
    description:
      parsed.description ??
      `${provider === 'codex' ? 'Codex' : 'Claude'} command`,
    source: 'native_command',
    provider,
    provenance,
    invocation: 'slash',
  };
}

async function skillFromMarkdown(
  path: string,
  provider: NativeProvider,
  provenance: NativeProvenance,
): Promise<SlashCommand | null> {
  const raw = await readMarkdown(path);
  if (raw === null) return null;
  const parsed = parseMarkdownMeta(raw);
  if (provider === 'codex' && parsed.name === undefined) return null;
  const name =
    parsed.name === undefined
      ? slashNameFromFile(dirname(path))
      : nativeSkillName(parsed.name);
  if (name === null) return null;
  return {
    name,
    template: `${provider === 'codex' ? '$' : '/'}${name} $ARGS`,
    description:
      parsed.description ??
      firstSentence(parsed.body) ??
      `${provider === 'codex' ? 'Codex' : 'Claude'} skill`,
    source: 'native_skill',
    provider,
    provenance,
    invocation: provider === 'codex' ? 'dollar' : 'slash',
  };
}

async function readMarkdown(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function parseMarkdownMeta(raw: string): {
  body: string;
  description?: string;
  name?: string;
} {
  if (!raw.startsWith('---\n')) return { body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { body: raw };
  const frontmatter = raw.slice(4, end);
  const body = raw.slice(end + 4).trimStart();
  try {
    const document = parseDocument(frontmatter);
    if (document.errors.length > 0) return { body };
    const rawDescription = document.get('description');
    const rawName = document.get('name');
    const description =
      typeof rawDescription === 'string' ? rawDescription.trim() : undefined;
    const name = typeof rawName === 'string' ? rawName.trim() : undefined;
    return { body, description, name };
  } catch {
    return { body };
  }
}

function slashNameFromFile(path: string): string | null {
  return slashName(basename(path, '.md'));
}

function slashName(value: string): string | null {
  const raw = value.replace(/\s+/g, '-').toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  return /^[a-z0-9][\w-]*$/.test(cleaned) ? cleaned : null;
}

function nativeSkillName(value: string): string | null {
  const name = value.trim();
  return /^[a-z0-9][a-z0-9_-]*$/.test(name) ? name : null;
}

function firstSentence(markdown: string): string | undefined {
  const text = markdown
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line !== '' && !line.startsWith('---'));
  if (text === undefined) return undefined;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
