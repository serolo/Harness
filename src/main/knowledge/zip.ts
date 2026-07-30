import { inflateRaw } from 'node:zlib';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '@shared/errors';

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_FILES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const inflateRawAsync = promisify(inflateRaw);

export interface ZipMarkdownFile {
  path: string;
  content: string;
}

function invalid(message: string): never {
  throw new AppError('invalid_input', `Invalid knowledge ZIP: ${message}`);
}

function safeEntryPath(raw: string): string | null {
  const path = raw.replaceAll('\\', '/');
  if (
    path === '' ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    path.includes('\0')
  ) {
    return invalid('archive contains an unsafe path');
  }
  const normalized = posix.normalize(path);
  if (normalized === '..' || normalized.startsWith('../')) {
    return invalid('archive path escapes its bundle');
  }
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '.git' || segment === '.hg' || segment === '.svn',
    )
  ) {
    return invalid('version-control metadata is unsupported');
  }
  if (
    segments[0] === '__MACOSX' ||
    segments.some(
      (segment) =>
        segment === '.DS_Store' ||
        segment.startsWith('._') ||
        segment.startsWith('.'),
    )
  ) {
    return null;
  }
  return normalized.replace(/^\.\//, '');
}

function findEndRecord(zip: Buffer): number {
  const floor = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= floor; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  return invalid('end-of-directory record is missing');
}

/**
 * Read Markdown from an ordinary ZIP without writing archive-controlled paths to disk.
 * Stored and deflated entries are supported; ZIP64, encryption and symlinks are rejected.
 */
export async function readZipMarkdown(zip: Buffer): Promise<ZipMarkdownFile[]> {
  const end = findEndRecord(zip);
  const disk = zip.readUInt16LE(end + 4);
  const centralDisk = zip.readUInt16LE(end + 6);
  const entryCount = zip.readUInt16LE(end + 10);
  const centralOffset = zip.readUInt32LE(end + 16);
  if (disk !== 0 || centralDisk !== 0)
    invalid('multi-disk archives are unsupported');
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    invalid('ZIP64 archives are unsupported');
  }
  if (entryCount > MAX_FILES) invalid(`archive exceeds ${MAX_FILES} entries`);

  const files: ZipMarkdownFile[] = [];
  let totalBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > zip.length ||
      zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE
    ) {
      invalid('central directory is corrupt');
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const externalAttributes = zip.readUInt32LE(cursor + 38);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > zip.length) invalid('entry name is truncated');
    const name = safeEntryPath(
      zip.subarray(cursor + 46, nameEnd).toString('utf8'),
    );
    cursor = nameEnd + extraLength + commentLength;

    if (name === null) continue;
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000)
      invalid('symbolic links are unsupported');
    if (name.endsWith('/')) continue;
    if ((flags & 1) !== 0) invalid('encrypted entries are unsupported');
    if (method !== 0 && method !== 8)
      invalid(`compression method ${method} is unsupported`);
    if (!name.toLowerCase().endsWith('.md')) continue;
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      invalid('uncompressed Markdown exceeds 100 MB');
    }
    if (
      localOffset + 30 > zip.length ||
      zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
    ) {
      invalid('local entry header is corrupt');
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) invalid('entry data is truncated');
    const compressed = zip.subarray(dataStart, dataEnd);
    let data: Buffer;
    try {
      data =
        method === 0
          ? compressed
          : await inflateRawAsync(compressed, {
              // Never let forged ZIP metadata turn a small archive into an
              // unbounded allocation in Electron's privileged main process.
              maxOutputLength: Math.min(
                uncompressedSize + 1,
                MAX_UNCOMPRESSED_BYTES + 1,
              ),
            });
    } catch {
      invalid('entry decompression exceeded its declared size or failed');
    }
    if (data.length !== uncompressedSize)
      invalid('entry size does not match metadata');
    files.push({ path: name, content: data.toString('utf8') });
  }
  if (files.length === 0) invalid('archive contains no Markdown files');

  // ZIP tools commonly wrap a bundle in one directory. Strip it only when every file
  // shares the same non-file first segment.
  const firstSegments = new Set(files.map((file) => file.path.split('/')[0]));
  if (
    firstSegments.size === 1 &&
    files.every((file) => file.path.includes('/'))
  ) {
    const prefix = `${files[0].path.split('/')[0]}/`;
    const unwrapped = files.map((file) => ({
      ...file,
      path: file.path.slice(prefix.length),
    }));
    assertUniquePaths(unwrapped);
    return unwrapped;
  }
  assertUniquePaths(files);
  return files;
}

function assertUniquePaths(files: ZipMarkdownFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      invalid(`archive contains duplicate Markdown path: ${file.path}`);
    }
    seen.add(file.path);
  }
}
