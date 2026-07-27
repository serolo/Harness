import { describe, expect, it } from 'vitest';
import { MODEL_PATTERN } from './tasks';

describe('MODEL_PATTERN', () => {
  it('accepts a provider-qualified model as one inert argument', () => {
    expect(MODEL_PATTERN.test('anthropic/claude-opus-4-8-1m')).toBe(true);
  });

  it('rejects paths and shell syntax', () => {
    expect(MODEL_PATTERN.test('../claude-opus')).toBe(false);
    expect(MODEL_PATTERN.test('anthropic/claude;rm')).toBe(false);
    expect(MODEL_PATTERN.test('anthropic//claude')).toBe(false);
  });
});
