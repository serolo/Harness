import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveExecutable } from './executable';

describe('resolveExecutable', () => {
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

    const command = `harness-user-local-${process.pid}`;
    const bin = join(process.env.HOME!, '.local', 'bin', command);
    const previousPath = process.env.PATH;
    try {
      writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      chmodSync(bin, 0o755);
      process.env.PATH = '/usr/bin:/bin';

      expect(resolveExecutable(command)).toBe(bin);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(bin, { force: true });
    }
  });
});
