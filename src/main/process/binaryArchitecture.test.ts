import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

describe('packaged binary architecture verification', () => {
  const script = resolve('scripts/verify-binary-architecture.mjs');
  const pe = (machine: number): Buffer => {
    const bytes = Buffer.alloc(128);
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 0x3c);
    bytes.write('PE\0\0', 64, 'binary');
    bytes.writeUInt16LE(machine, 68);
    return bytes;
  };
  const elf = (machine: number): Buffer => {
    const bytes = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes);
    bytes[5] = 1;
    bytes.writeUInt16LE(machine, 18);
    return bytes;
  };

  it('accepts matching PE and ELF binaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-binary-arch-'));
    try {
      const pePath = join(directory, 'app.exe');
      const elfPath = join(directory, 'app');
      await writeFile(pePath, pe(0x8664));
      await writeFile(elfPath, elf(0x3e));

      const result = await execa(process.execPath, [
        script,
        'x64',
        pePath,
        elfPath,
      ]);
      expect(result.stdout).toContain(`${pePath}: x64`);
      expect(result.stdout).toContain(`${elfPath}: x64`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects mismatched architectures and unknown formats', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-binary-arch-'));
    try {
      const armPath = join(directory, 'arm.exe');
      const unknownPath = join(directory, 'unknown');
      await writeFile(armPath, pe(0xaa64));
      await writeFile(unknownPath, Buffer.alloc(64));

      await expect(
        execa(process.execPath, [script, 'x64', armPath]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('found arm64'),
      });
      await expect(
        execa(process.execPath, [script, 'x64', unknownPath]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('found unknown format'),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
