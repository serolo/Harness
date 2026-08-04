import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import { AppError } from '../error';

export async function downloadVerified(options: {
  url: string;
  destination: string;
  algorithm: 'sha256' | 'sha512';
  expectedDigest: string;
  digestEncoding: 'hex' | 'base64';
  maxBytes: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || response.body === null) {
    throw new AppError(
      'integration',
      `Provider CLI download failed with HTTP ${response.status}`,
    );
  }
  const declaredSize = Number(response.headers.get('content-length') ?? '0');
  if (declaredSize > options.maxBytes) {
    throw new AppError(
      'integration',
      'Provider CLI download is unexpectedly large',
    );
  }

  const hash = createHash(options.algorithm);
  const file = await open(options.destination, 'w', 0o600);
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > options.maxBytes) {
        throw new AppError(
          'integration',
          'Provider CLI download is unexpectedly large',
        );
      }
      hash.update(chunk.value);
      await file.write(chunk.value);
      chunk = await reader.read();
    }
  } finally {
    reader.releaseLock();
    await file.close();
  }

  if (bytes === 0) {
    throw new AppError('integration', 'Provider CLI download is empty');
  }
  const digest = hash.digest(options.digestEncoding);
  if (digest !== options.expectedDigest) {
    throw new AppError(
      'integration',
      'Provider CLI download failed integrity verification',
    );
  }
}
