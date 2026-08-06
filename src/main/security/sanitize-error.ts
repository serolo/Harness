const BEARER_AUTHORIZATION =
  /\b(authorization\s*:\s*bearer\s+)[^\s,;'")\]}]+/gi;
const SECRET_ASSIGNMENT =
  /\b(?:token|api[_-]?key|authorization|password|secret)=([^\s,;]+)/gi;
const ABSOLUTE_PATH =
  /(?:file:\/\/)?(?:\/(?:Users|home|tmp|private|var|Volumes|opt)\/[^\s'";,)]*|[A-Za-z]:\\[^\s'";,)]*)/g;

/** Keep operational errors actionable without persisting credentials or local paths. */
export function sanitizeErrorMessage(
  error: unknown,
  fallback = 'operation failed',
): string {
  const raw = error instanceof Error ? error.message : error;
  const message = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
  return sanitizeSensitiveText(message, 2_048);
}

/** Redact secrets and managed absolute paths from retained provider-authored text. */
export function sanitizeSensitiveText(
  value: string,
  maxChars = 131_072,
): string {
  return value
    .replace(BEARER_AUTHORIZATION, '$1[redacted]')
    .replace(SECRET_ASSIGNMENT, (entry) => `${entry.split('=')[0]}=[redacted]`)
    .replace(ABSOLUTE_PATH, '[private path]')
    .slice(0, maxChars);
}
