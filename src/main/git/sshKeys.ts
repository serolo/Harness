// Local SSH identity discovery for the Settings > Git panel.
//
// Security: this scanner never reads private key contents. It discovers candidate
// identity paths from ~/.ssh, ~/.gitconfig sshCommand entries, and ~/.ssh/config
// IdentityFile entries, then reads only matching public .pub files for metadata.

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

import type { GitSshKey } from '@shared/git';

const DEFAULT_IDENTITY_NAMES = [
  'id_ed25519',
  'id_ecdsa',
  'id_rsa',
  'id_dsa',
];

type Source = GitSshKey['source'];

interface Candidate {
  path: string;
  source: Source;
}

/** Discover local SSH identity files and public-key metadata. */
export async function discoverGitSshKeys(): Promise<GitSshKey[]> {
  const candidates = new Map<string, Candidate>();

  const add = (path: string, source: Source): void => {
    const normalized = expandHome(path.trim());
    if (normalized === '') return;
    if (normalized.endsWith('.pub')) return;
    candidates.set(normalized, { path: normalized, source });
  };

  for (const path of await discoverDefaultSshKeys()) add(path, 'ssh-dir');
  for (const path of await discoverGitConfigKeys()) add(path, 'gitconfig');
  for (const path of await discoverSshConfigKeys()) add(path, 'ssh-config');

  const rows: Array<GitSshKey | null> = await Promise.all(
    [...candidates.values()].map(async (candidate) => {
      const exists = await fileExists(candidate.path);
      if (!exists) return null;
      return enrichCandidate(candidate);
    }),
  );

  return rows
    .filter((row): row is GitSshKey => row !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function discoverDefaultSshKeys(): Promise<string[]> {
  const sshDir = join(homedir(), '.ssh');
  try {
    const entries = await readdir(sshDir);
    return entries
      .filter((entry) => !entry.endsWith('.pub'))
      .filter((entry) => DEFAULT_IDENTITY_NAMES.includes(entry))
      .map((entry) => join(sshDir, entry));
  } catch {
    return [];
  }
}

async function discoverGitConfigKeys(): Promise<string[]> {
  const config = await readText(join(homedir(), '.gitconfig'));
  if (config === null) return [];

  const paths: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*sshCommand\s*=\s*(.+)$/i.exec(line);
    if (!match) continue;
    paths.push(...extractIdentityArgs(match[1]));
  }
  return paths;
}

async function discoverSshConfigKeys(): Promise<string[]> {
  const config = await readText(join(homedir(), '.ssh', 'config'));
  if (config === null) return [];

  const paths: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*IdentityFile\s+(.+)$/i.exec(line);
    if (!match) continue;
    paths.push(stripQuotes(match[1].trim()));
  }
  return paths;
}

function extractIdentityArgs(command: string): string[] {
  const args = splitShellWords(command);
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-i' && args[i + 1]) {
      paths.push(args[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith('-i') && arg.length > 2) {
      paths.push(arg.slice(2));
    }
  }
  return paths;
}

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') words.push(current);
  return words;
}

async function enrichCandidate(candidate: Candidate): Promise<GitSshKey> {
  const publicKeyPath = `${candidate.path}.pub`;
  const publicText = await readText(publicKeyPath);
  const publicKey = publicText ? parsePublicKey(publicText) : null;

  return {
    path: candidate.path,
    publicKeyPath: publicText ? publicKeyPath : undefined,
    type: publicKey?.type,
    fingerprint: publicKey?.fingerprint,
    comment: publicKey?.comment,
    source: candidate.source,
  };
}

function parsePublicKey(text: string): {
  type: string;
  fingerprint: string;
  comment?: string;
} | null {
  const [type, blob, ...comment] = text.trim().split(/\s+/);
  if (!type || !blob) return null;

  try {
    const digest = createHash('sha256')
      .update(Buffer.from(blob, 'base64'))
      .digest('base64')
      .replace(/=+$/, '');
    return {
      type,
      fingerprint: `SHA256:${digest}`,
      comment: comment.length > 0 ? comment.join(' ') : undefined,
    };
  } catch {
    return null;
  }
}

function expandHome(path: string): string {
  const stripped = stripQuotes(path);
  if (stripped === '~') return homedir();
  if (stripped.startsWith('~/')) return join(homedir(), stripped.slice(2));
  return resolve(stripped);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
