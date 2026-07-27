// Pure billing helpers shared by main and renderer. Monetary values are stored as
// integer micro-dollars (USD × 1,000,000), avoiding floating-point accumulation.

import type { HarnessId, Usage } from './harness';

export const PRICING_VERSION = '2026-07-27';

export interface TurnBilling {
  harness: HarnessId;
  model: string;
  pricingKey: string;
  costMicros: number;
}

export interface MonthlyUsageModel {
  harness: HarnessId;
  model: string;
  costMicros: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface MonthlyUsage {
  month: string;
  totalCostMicros: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  turns: number;
  unpricedTurns: number;
  models: MonthlyUsageModel[];
}

interface PricingRate {
  key: string;
  matches: (model: string) => boolean;
  input: number;
  cachedInput: number;
  cacheWrite?: number;
  output: number;
}

const compact = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');
const includes =
  (...needles: string[]) =>
  (model: string): boolean => {
    const normalized = compact(model);
    return needles.some((needle) => normalized.includes(compact(needle)));
  };

// USD per million tokens. Effective-date changes belong in a new catalogue version;
// completed turns persist both the resulting cost and the key used.
const RATES: Record<HarnessId, readonly PricingRate[]> = {
  claude_code: [
    {
      key: 'claude-fable-5',
      matches: includes('fable-5'),
      input: 10,
      cachedInput: 1,
      output: 50,
    },
    {
      key: 'claude-opus-5',
      matches: includes('opus-5'),
      input: 5,
      cachedInput: 0.5,
      output: 25,
    },
    {
      key: 'claude-sonnet-5-intro',
      matches: includes('sonnet-5'),
      input: 2,
      cachedInput: 0.2,
      output: 10,
    },
    {
      key: 'claude-haiku-4.5',
      matches: includes('haiku-4-5', 'haiku-4.5'),
      input: 1,
      cachedInput: 0.1,
      output: 5,
    },
    {
      key: 'claude-opus-4.8',
      matches: includes('opus-4-8', 'opus-4.8'),
      input: 5,
      cachedInput: 0.5,
      output: 25,
    },
    {
      key: 'claude-opus-4.7',
      matches: includes('opus-4-7', 'opus-4.7'),
      input: 5,
      cachedInput: 0.5,
      output: 25,
    },
    {
      key: 'claude-opus-4.6',
      matches: includes('opus-4-6', 'opus-4.6'),
      input: 5,
      cachedInput: 0.5,
      output: 25,
    },
    {
      key: 'claude-sonnet-4.6',
      matches: includes('sonnet-4-6', 'sonnet-4.6'),
      input: 3,
      cachedInput: 0.3,
      output: 15,
    },
    {
      key: 'claude-sonnet-4.5',
      matches: includes('sonnet-4-5', 'sonnet-4.5'),
      input: 3,
      cachedInput: 0.3,
      output: 15,
    },
    {
      key: 'claude-opus-4.5',
      matches: includes('opus-4-5', 'opus-4.5'),
      input: 5,
      cachedInput: 0.5,
      output: 25,
    },
    {
      key: 'claude-opus-4.1',
      matches: includes('opus-4-1', 'opus-4.1'),
      input: 15,
      cachedInput: 1.5,
      output: 75,
    },
    {
      key: 'claude-sonnet-4',
      matches: includes('sonnet-4'),
      input: 3,
      cachedInput: 0.3,
      output: 15,
    },
    {
      key: 'claude-opus-4',
      matches: includes('opus-4'),
      input: 15,
      cachedInput: 1.5,
      output: 75,
    },
  ],
  codex: [
    {
      key: 'openai-gpt-5.6-sol',
      matches: includes('gpt-5.6-sol'),
      input: 2.5,
      cachedInput: 0.25,
      output: 15,
    },
    {
      key: 'openai-gpt-5.6-terra',
      matches: includes('gpt-5.6-terra'),
      input: 1.25,
      cachedInput: 0.125,
      output: 7.5,
    },
    {
      key: 'openai-gpt-5.6-luna',
      matches: includes('gpt-5.6-luna'),
      input: 0.5,
      cachedInput: 0.05,
      output: 3,
    },
    {
      key: 'openai-gpt-5.5-pro',
      matches: includes('gpt-5.5-pro'),
      input: 15,
      cachedInput: 15,
      output: 90,
    },
    {
      key: 'openai-gpt-5.5',
      matches: includes('gpt-5.5'),
      input: 2.5,
      cachedInput: 0.25,
      output: 15,
    },
    {
      key: 'openai-gpt-5.4-mini',
      matches: includes('gpt-5.4-mini'),
      input: 0.375,
      cachedInput: 0.0375,
      output: 2.25,
    },
    {
      key: 'openai-gpt-5.4-nano',
      matches: includes('gpt-5.4-nano'),
      input: 0.1,
      cachedInput: 0.01,
      output: 0.625,
    },
    {
      key: 'openai-gpt-5.4-pro',
      matches: includes('gpt-5.4-pro'),
      input: 15,
      cachedInput: 15,
      output: 90,
    },
    {
      key: 'openai-gpt-5.4',
      matches: includes('gpt-5.4'),
      input: 1.25,
      cachedInput: 0.13,
      output: 7.5,
    },
  ],
  cursor: [],
};

export function calculateTurnBilling(
  harness: HarnessId,
  model: string | undefined,
  usage: Usage | undefined,
): TurnBilling | null {
  if (!model || !usage) return null;
  const rate = RATES[harness].find((candidate) => candidate.matches(model));
  if (!rate) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const totalInput = usage.inputTokens ?? 0;
  const uncachedInput = Math.max(0, totalInput - cached - cacheWrite);
  const costMicros = Math.round(
    uncachedInput * rate.input +
      cached * rate.cachedInput +
      cacheWrite * (rate.cacheWrite ?? rate.input * 1.25) +
      (usage.outputTokens ?? 0) * rate.output,
  );
  return {
    harness,
    model,
    pricingKey: `${PRICING_VERSION}:${rate.key}`,
    costMicros,
  };
}

export function formatUsdMicros(costMicros: number): string {
  const dollars = costMicros / 1_000_000;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: dollars < 1 ? 4 : 2,
    maximumFractionDigits: dollars < 1 ? 4 : 2,
  }).format(dollars);
}
