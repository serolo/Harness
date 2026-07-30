import { describe, expect, it } from 'vitest';
import {
  calculateTurnBilling,
  formatTokenCount,
  formatUsdMicros,
} from './billing';

describe('calculateTurnBilling', () => {
  it('prices uncached, cache-read, cache-write, and output tokens separately', () => {
    expect(
      calculateTurnBilling('claude_code', 'claude-sonnet-5-1m', {
        inputTokens: 1_000_000,
        cachedInputTokens: 100_000,
        cacheWriteInputTokens: 100_000,
        outputTokens: 100_000,
      }),
    ).toMatchObject({
      model: 'claude-sonnet-5-1m',
      costMicros: 2_870_000,
      pricingKey: '2026-07-27:claude-sonnet-5-intro',
    });
  });

  it('normalizes punctuation in provider model ids', () => {
    expect(
      calculateTurnBilling('codex', 'codex-gpt-5-6-terra', {
        inputTokens: 1_000,
        cachedInputTokens: 500,
        outputTokens: 100,
      })?.costMicros,
    ).toBe(1_438);
  });

  it('leaves unknown and unsupported models unpriced', () => {
    expect(
      calculateTurnBilling('cursor', 'cursor-default', {
        inputTokens: 100,
      }),
    ).toBeNull();
    expect(
      calculateTurnBilling('codex', undefined, { inputTokens: 100 }),
    ).toBeNull();
  });

  it('formats token counts for compact transcript labels', () => {
    expect(formatTokenCount(317_297)).toBe('317k');
    expect(formatTokenCount(1_297)).toBe('1.3k');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
  });

  it('formats an exact zero cost without decimal places', () => {
    expect(formatUsdMicros(0)).toBe('$0');
    expect(formatUsdMicros(123_400)).toBe('$0.1234');
  });
});
