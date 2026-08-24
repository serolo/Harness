import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { executableCandidates, resolveExecutable } from './executable';

describe('resolveExecutable', () => {
  it('resolves native executable suffixes on Windows', () => {
    expect(executableCandidates('claude', 'win32')).toEqual([
      'claude.exe',
      'claude',
    ]);
    expect(executableCandidates('claude.exe', 'win32')).toEqual(['claude.exe']);
    expect(executableCandidates('claude', 'linux')).toEqual(['claude']);
  });

  it('honors Windows Path casing and executable suffixes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-exe-win-'));
    try {
      const bin = join(dir, 'tool.exe');
      writeFileSync(bin, 'fixture');
      chmodSync(bin, 0o755);
      expect(
        resolveExecutable('tool', {
          platform: 'win32',
          env: { Path: dir },
          homeDirectory: dir,
        }),
      ).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a PATH command to an executable absolute path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-exe-'));
    const bin = join(dir, 'tool');
    const previousPath = process.env.PATH;
    try {
      writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      chmodSync(bin, 0o755);
      process.env.PATH = [dir, previousPath ?? ''].join(delimiter);

      expect(resolveExecutable('tool')).toBe(bin);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the original command when PATH lookup fails', () => {
    expect(resolveExecutable('definitely-not-installed-harness-tool')).toBe(
      'definitely-not-installed-harness-tool',
    );
  });

  it('finds user-local executables when a packaged macOS app has a minimal PATH', () => {
    if (process.platform !== 'darwin') return;

    const home = mkdtempSync(join(tmpdir(), 'harness-exe-home-'));
    const command = `harness-user-local-${process.pid}`;
    const binDir = join(home, '.local', 'bin');
    const bin = join(binDir, command);
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      chmodSync(bin, 0o755);
      process.env.HOME = home;
      process.env.PATH = '/usr/bin:/bin';

      expect(resolveExecutable(command)).toBe(bin);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
