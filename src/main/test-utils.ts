import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Best-effort cleanup for integration-test directories.
 *
 * Windows can retain Git and SQLite file handles until after the test process
 * exits. A locked OS temp directory must not turn an otherwise successful test
 * into a failure; CI runners are ephemeral and the OS owns this temp location.
 */
export function removeTestDirectory(path: string): void {
  const relativeToTemp = relative(resolve(tmpdir()), resolve(path));
  if (
    relativeToTemp === '' ||
    relativeToTemp === '..' ||
    relativeToTemp.startsWith(`..${sep}`) ||
    isAbsolute(relativeToTemp)
  ) {
    throw new Error('test cleanup path must be inside the OS temp directory');
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
    ) {
      return;
    }
    throw error;
  }
}
