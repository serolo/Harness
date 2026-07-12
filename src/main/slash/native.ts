import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import type { HarnessId } from '@shared/harness';
import type { SlashCommand } from '@shared/slash';

interface DiscoverOpts {
  harness?: HarnessId;
  workspaceDir?: string | null;
  homeDir?: string;
}

const MAX_FILES = 300;

export async function discoverNativeSlashCommands(
  opts: DiscoverOpts = {},
): Promise<SlashCommand[]> {
  const home = opts.homeDir ?? homedir();
  const roots = nativeRoots(home, opts.workspaceDir ?? undefined, opts.harness);
  const commands: SlashCommand[] = [];

  for (const root of roots) {
    const files = await collectFiles(root.path, root.kind);
    for (const file of files) {
      const cmd =
        root.kind === 'command'
          ? await commandFromMarkdown(file, root.provider)
          : await skillFromMarkdown(file, root.provider);
      if (cmd !== null) commands.push(cmd);
      if (commands.length >= MAX_FILES) return dedupe(commands);
    }
  }

  return dedupe(commands);
}

function nativeRoots(
  home: string,
  workspaceDir: string | undefined,
  harness: HarnessId | undefined,
): { path: string; kind: 'command' | 'skill'; provider: string }[] {
  const roots: { path: string; kind: 'command' | 'skill'; provider: string }[] = [];

  if (harness === undefined || harness === 'claude_code') {
    if (workspaceDir !== undefined) {
      roots.push(
        { path: join(workspaceDir, '.claude'), kind: 'command', provider: 'Claude' },
        { path: join(workspaceDir, '.claude'), kind: 'skill', provider: 'Claude' },
      );
    }
    roots.push(
      { path: join(home, '.claude'), kind: 'command', provider: 'Claude' },
      { path: join(home, '.claude'), kind: 'skill', provider: 'Claude' },
    );
  }

  if (harness === undefined || harness === 'codex') {
    if (workspaceDir !== undefined) {
      roots.push({ path: join(workspaceDir, '.codex'), kind: 'skill', provider: 'Codex' });
    }
    roots.push({ path: join(home, '.codex'), kind: 'skill', provider: 'Codex' });
  }

  return roots;
}

async function collectFiles(
  root: string,
  kind: 'command' | 'skill',
): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 9 || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(path, depth + 1);
      } else if (entry.isFile()) {
        const parts = relative(root, path).split(sep);
        if (kind === 'command' && entry.name.endsWith('.md') && parts.includes('commands')) {
          files.push(path);
        } else if (kind === 'skill' && entry.name === 'SKILL.md' && parts.includes('skills')) {
          files.push(path);
        }
      }
    }
  }

  await walk(root, 0);
  return files;
}

async function commandFromMarkdown(
  path: string,
  provider: string,
): Promise<SlashCommand | null> {
  const raw = await readMarkdown(path);
  if (raw === null) return null;
  const parsed = parseMarkdownMeta(raw);
  const name = slashNameFromFile(path);
  if (name === null) return null;
  return {
    name,
    template: parsed.body.trim() === '' ? `Run /${name}.\n\n$ARGS` : parsed.body,
    description: parsed.description ?? `${provider} command`,
  };
}

async function skillFromMarkdown(
  path: string,
  provider: string,
): Promise<SlashCommand | null> {
  const raw = await readMarkdown(path);
  if (raw === null) return null;
  const parsed = parseMarkdownMeta(raw);
  const name = slashNameFromFile(dirname(path));
  if (name === null) return null;
  return {
    name,
    template: `Use the ${name} skill.\n\n$ARGS`,
    description: parsed.description ?? firstSentence(parsed.body) ?? `${provider} skill`,
  };
}

async function readMarkdown(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function parseMarkdownMeta(raw: string): { body: string; description?: string } {
  if (!raw.startsWith('---\n')) return { body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { body: raw };
  const frontmatter = raw.slice(4, end);
  const description = /^description:\s*['"]?(.+?)['"]?\s*$/m.exec(frontmatter)?.[1];
  return { body: raw.slice(end + 4).trimStart(), description };
}

function slashNameFromFile(path: string): string | null {
  const raw = basename(path, '.md').replace(/\s+/g, '-').toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  return /^[a-z0-9][\w-]*$/.test(cleaned) ? cleaned : null;
}

function firstSentence(markdown: string): string | undefined {
  const text = markdown
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line !== '' && !line.startsWith('---'));
  if (text === undefined) return undefined;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function dedupe(commands: SlashCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  return commands.filter((cmd) => {
    if (seen.has(cmd.name)) return false;
    seen.add(cmd.name);
    return true;
  });
}
