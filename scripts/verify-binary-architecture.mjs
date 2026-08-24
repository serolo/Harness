import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ARCHITECTURES = new Map([
  [0x8664, 'x64'],
  [0xaa64, 'arm64'],
  [0x3e, 'x64'],
  [0xb7, 'arm64'],
  [0x01000007, 'x64'],
  [0x0100000c, 'arm64'],
]);

export function binaryArchitecture(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20) return undefined;

  // Windows PE/COFF: DOS header points to the PE signature and machine field.
  if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 64) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (
      peOffset + 6 <= bytes.length &&
      bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from('PE\0\0'))
    ) {
      return ARCHITECTURES.get(bytes.readUInt16LE(peOffset + 4));
    }
  }

  // Linux ELF: e_machine follows the 16-byte identity and e_type fields.
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine =
      bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18);
    return ARCHITECTURES.get(machine);
  }

  // Thin Mach-O binaries. Universal macOS binaries continue to use lipo in CI.
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xbebafeca) return 'universal';
  if (magic === 0xfeedfacf) return ARCHITECTURES.get(bytes.readUInt32BE(4));
  if (magic === 0xcffaedfe) return ARCHITECTURES.get(bytes.readUInt32LE(4));
  return undefined;
}

async function main() {
  const [, , expected, ...paths] = process.argv;
  if (!['x64', 'arm64'].includes(expected) || paths.length === 0) {
    throw new Error(
      'Usage: verify-binary-architecture.mjs <x64|arm64> <binary> [binary...]',
    );
  }
  for (const path of paths) {
    const architecture = binaryArchitecture(await readFile(path));
    if (architecture !== expected) {
      throw new Error(
        `${path}: expected ${expected}, found ${architecture ?? 'unknown format'}`,
      );
    }
    console.log(`${path}: ${architecture}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
