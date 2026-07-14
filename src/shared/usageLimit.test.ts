// parseUsageLimitMessage — conservative usage-limit detection (Phase 12, design doc §5.1).
//
// Proves: the pipe-epoch form (seconds AND millis) resolves a reset time; a textual
// "resets at 5pm" resolves to the next wall-clock instant; a bare match returns
// `{ resetsAt: null }`; and clear non-matches (GitHub "rate limit" wording, generic
// errors, the bare word "usage") return `null`. A fixed injected `now` keeps the
// wall-clock case deterministic.

import { describe, it, expect } from 'vitest';
import { parseUsageLimitMessage } from './usageLimit';

// A fixed reference instant: 2026-07-12T09:00:00 LOCAL time (so "resets at 5pm" is later
// the same day and "resets at 8am" rolls to tomorrow).
const NOW = new Date(2026, 6, 12, 9, 0, 0, 0).getTime();

describe('parseUsageLimitMessage — pipe epoch form', () => {
  it('parses an epoch-SECONDS value and normalizes it to millis', () => {
    const epochSeconds = 1_752_324_000; // < 1e12 → seconds
    const info = parseUsageLimitMessage(
      `Claude AI usage limit reached|${epochSeconds}`,
      NOW,
    );
    expect(info).toEqual({ resetsAt: epochSeconds * 1000 });
  });

  it('parses an epoch-MILLIS value unchanged', () => {
    const epochMillis = 1_752_324_000_000; // >= 1e12 → already millis
    const info = parseUsageLimitMessage(
      `Claude AI usage limit reached|${epochMillis}`,
      NOW,
    );
    expect(info).toEqual({ resetsAt: epochMillis });
  });
});

describe('parseUsageLimitMessage — textual "resets at" form', () => {
  it('resolves "resets at 5pm" to 17:00 local later the same day', () => {
    const info = parseUsageLimitMessage(
      'Claude AI usage limit reached. Your limit resets at 5pm.',
      NOW,
    );
    const expected = new Date(2026, 6, 12, 17, 0, 0, 0).getTime();
    expect(info).toEqual({ resetsAt: expected });
  });

  it('rolls an already-passed wall-clock time to tomorrow', () => {
    const info = parseUsageLimitMessage(
      'usage limit reached — resets at 8am',
      NOW,
    );
    const expected = new Date(2026, 6, 13, 8, 0, 0, 0).getTime();
    expect(info).toEqual({ resetsAt: expected });
  });

  it('supports a 24h "resets 05:30" form', () => {
    const info = parseUsageLimitMessage(
      'usage limit reached; resets 05:30',
      NOW,
    );
    const expected = new Date(2026, 6, 13, 5, 30, 0, 0).getTime();
    expect(info).toEqual({ resetsAt: expected });
  });
});

describe('parseUsageLimitMessage — bare match (limit but no time)', () => {
  it('returns { resetsAt: null } for a bare usage-limit message', () => {
    expect(
      parseUsageLimitMessage('Claude AI usage limit reached', NOW),
    ).toEqual({ resetsAt: null });
  });
});

describe('parseUsageLimitMessage — non-matches return null', () => {
  it('does not match GitHub "rate limit" wording', () => {
    expect(
      parseUsageLimitMessage('API rate limit exceeded for user', NOW),
    ).toBeNull();
  });

  it('does not match a generic error', () => {
    expect(parseUsageLimitMessage('claude exited with code 1', NOW)).toBeNull();
  });

  it('does not match the bare word "usage"', () => {
    expect(parseUsageLimitMessage('usage: claude [options]', NOW)).toBeNull();
  });

  it('returns null for an empty message', () => {
    expect(parseUsageLimitMessage('', NOW)).toBeNull();
  });
});
