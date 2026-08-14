import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  builtinAgentsDir,
  allocateProjectDirectoryName,
  defaultRootDirectory,
  projectDir,
  projectDirectoryBaseName,
  rootDirectory,
  setRootDirectory,
  setUserDataRoot,
} from './paths';

afterEach(() => setUserDataRoot(undefined));

describe('managed root directory', () => {
  it('defaults to harness below the isolated user-data root', () => {
    const data = mkdtempSync(join(tmpdir(), 'harness-paths-'));
    setUserDataRoot(data);

    expect(defaultRootDirectory()).toBe(join(data, 'harness'));
    expect(rootDirectory()).toBe(join(data, 'harness'));
    expect(projectDir('p1')).toBe(join(data, 'harness', 'projects', 'p1'));
  });

  it('persists an absolute custom root', () => {
    const data = mkdtempSync(join(tmpdir(), 'harness-paths-'));
    const custom = join(data, 'custom-root');
    setUserDataRoot(data);

    expect(setRootDirectory(custom)).toBe(custom);
    expect(rootDirectory()).toBe(custom);
    expect(
      JSON.parse(readFileSync(join(data, 'root-directory.json'), 'utf8')),
    ).toEqual({ path: custom });
  });

  it('rejects relative roots', () => {
    const data = mkdtempSync(join(tmpdir(), 'harness-paths-'));
    setUserDataRoot(data);
    expect(() => setRootDirectory('relative/path')).toThrow(
      'must be an absolute path',
    );
  });

  it('resolves explicit development and packaged built-in resource layouts', () => {
    expect(builtinAgentsDir({ packaged: false, appPath: '/checkout' })).toBe(
      join('/checkout', 'resources', 'builtin-agents'),
    );
    expect(
      builtinAgentsDir({ packaged: true, resourcesPath: '/app/resources' }),
    ).toBe(join('/app/resources', 'builtin-agents'));
  });
});

describe('project directory names', () => {
  it('normalizes project names into readable filesystem-safe slugs', () => {
    expect(projectDirectoryBaseName(' W2 Platform / Café ')).toBe(
      'w2-platform-cafe',
    );
    expect(projectDirectoryBaseName('🛠️')).toBe('project');
  });

  it('allocates case-insensitive collision suffixes within the length limit', () => {
    expect(
      allocateProjectDirectoryName('Harness', ['harness', 'HARNESS-2']),
    ).toBe('harness-3');
    expect(allocateProjectDirectoryName('x'.repeat(80), ['x'.repeat(63)])).toBe(
      `${'x'.repeat(61)}-2`,
    );
  });
});
