import { describe, expect, it } from 'vitest';
import { sanitizeErrorMessage, sanitizeSensitiveText } from './sanitize-error';

describe('sensitive error sanitization', () => {
  it('redacts a standard Bearer authorization header with assignments and paths', () => {
    expect(
      sanitizeErrorMessage(
        'Authorization: Bearer super-secret; api_key=abc123; worked in /tmp/private-run/control.sock',
      ),
    ).toBe(
      'Authorization: Bearer [redacted]; api_key=[redacted]; worked in [private path]',
    );
  });

  it('matches Bearer authorization headers case-insensitively without consuming punctuation', () => {
    expect(
      sanitizeSensitiveText(
        'authorization : bearer eyJhbGciOi.test-value, request rejected',
      ),
    ).toBe('authorization : bearer [redacted], request rejected');
  });

  it('retains existing assignment, absolute-path, fallback, and length behavior', () => {
    expect(
      sanitizeErrorMessage(
        'token=one password=two secret=three at C:\\Users\\person\\secret.txt',
      ),
    ).toBe(
      'token=[redacted] password=[redacted] secret=[redacted] at [private path]',
    );
    expect(sanitizeErrorMessage(undefined, 'safe fallback')).toBe(
      'safe fallback',
    );
    expect(sanitizeSensitiveText('abcdef', 3)).toBe('abc');
  });
});
