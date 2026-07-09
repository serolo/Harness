// Write-to-layer path (Task A3, heightened-scrutiny). Drives `setSetting` against
// temp files and reads the raw TOML back to assert ONLY the target layer's object is
// written (never the merged blob), plus the security guards (traversal / proto
// pollution / project-dir requirement) and the re-merge validation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { AppError } from '@shared/errors';
import { setUserDataRoot } from '../paths';
import { setSetting, resolveLayerFile, layerFiles } from './write';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-write-'));
  // Point `settingsPath()` (the user-layer default) at the temp dir so the re-merge
  // validation never touches Electron / the developer's real settings file.
  setUserDataRoot(tmpDir);
});
afterEach(() => {
  setUserDataRoot(undefined);
  rmSync(tmpDir, { recursive: true, force: true });
});

function userFile(): string {
  return join(tmpDir, 'user-settings.toml');
}
function projectDir(): string {
  const dir = join(tmpDir, 'project');
  mkdirSync(join(dir, '.harness'), { recursive: true });
  return dir;
}
function readToml(file: string): Record<string, unknown> {
  return parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('setSetting — user layer', () => {
  it('creates the file and writes a nested key path', () => {
    setSetting({
      layer: 'user',
      keyPath: 'git.branchPrefix',
      value: 'feat',
      userPath: userFile(),
    });
    expect(readToml(userFile())).toEqual({ git: { branchPrefix: 'feat' } });
  });

  it('merges into an existing file, leaving other keys intact', () => {
    writeFileSync(userFile(), '[git]\nmergeStrategy = "rebase"\n', 'utf8');
    setSetting({
      layer: 'user',
      keyPath: 'git.branchPrefix',
      value: 'feat',
      userPath: userFile(),
    });
    expect(readToml(userFile())).toEqual({
      git: { mergeStrategy: 'rebase', branchPrefix: 'feat' },
    });
  });

  it('writes ONLY the target layer — never the merged blob', () => {
    // A project-local layer sets a different key; writing the user layer must not
    // pull that value down into the user file.
    const dir = projectDir();
    writeFileSync(
      join(dir, '.harness', 'settings.local.toml'),
      '[git]\nmergeStrategy = "merge"\n',
      'utf8',
    );
    setSetting({
      layer: 'user',
      keyPath: 'git.branchPrefix',
      value: 'feat',
      userPath: userFile(),
      projectDir: dir,
    });
    // The user file has ONLY what we set — no mergeStrategy leaked from the local layer.
    expect(readToml(userFile())).toEqual({ git: { branchPrefix: 'feat' } });
  });
});

describe('setSetting — project layers', () => {
  it('writes the shared layer under .harness/settings.toml', () => {
    const dir = projectDir();
    setSetting({
      layer: 'project-shared',
      keyPath: 'agent.mode',
      value: 'plan',
      projectDir: dir,
    });
    const file = join(dir, '.harness', 'settings.toml');
    expect(readToml(file)).toEqual({ agent: { mode: 'plan' } });
  });

  it('rejects a project-layer write with no active project', () => {
    expect(() =>
      setSetting({
        layer: 'project-local',
        keyPath: 'agent.mode',
        value: 'plan',
      }),
    ).toThrow(AppError);
  });
});

describe('setSetting — validation + security guards', () => {
  it('rejects a value that violates the schema, writing nothing', () => {
    expect(() =>
      setSetting({
        layer: 'user',
        keyPath: 'git.mergeStrategy',
        value: 'not-a-strategy',
        userPath: userFile(),
      }),
    ).toThrow(AppError);
    expect(existsSync(userFile())).toBe(false); // nothing written
  });

  it('rejects a prototype-pollution key path', () => {
    expect(() =>
      setSetting({
        layer: 'user',
        keyPath: '__proto__.polluted',
        value: 'x',
        userPath: userFile(),
      }),
    ).toThrow(AppError);
  });

  it('rejects a traversal / empty key-path segment', () => {
    expect(() =>
      setSetting({
        layer: 'user',
        keyPath: 'git..branchPrefix',
        value: 'x',
        userPath: userFile(),
      }),
    ).toThrow(AppError);
  });
});

describe('layer path resolution', () => {
  it('resolves each writable layer to its file', () => {
    const dir = projectDir();
    expect(resolveLayerFile('user', { userPath: userFile() })).toBe(userFile());
    expect(resolveLayerFile('project-shared', { projectDir: dir })).toBe(
      join(dir, '.harness', 'settings.toml'),
    );
    expect(resolveLayerFile('project-local', { projectDir: dir })).toBe(
      join(dir, '.harness', 'settings.local.toml'),
    );
  });

  it('layerFiles lists user only without a projectDir, all three with one', () => {
    expect(layerFiles({ userPath: userFile() }).map((l) => l.tag)).toEqual([
      'user',
    ]);
    expect(
      layerFiles({ userPath: userFile(), projectDir: projectDir() }).map(
        (l) => l.tag,
      ),
    ).toEqual(['user', 'project-shared', 'project-local']);
  });
});
