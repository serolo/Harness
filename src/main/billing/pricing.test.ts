import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  calculateTurnBilling,
  installPricingCatalog,
  type PricingCatalogSnapshot,
} from '@shared/billing';
import { PRICING_CATALOG_URL, PricingService } from './pricing';

let directory: string;
let cachePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-pricing-'));
  cachePath = join(directory, 'pricing-catalog.json');
  installPricingCatalog(null);
});

afterEach(async () => {
  installPricingCatalog(null);
  await rm(directory, { recursive: true, force: true });
});

describe('PricingService', () => {
  it('refreshes supported prices, installs them, and caches a compact snapshot', async () => {
    const fetchPricing = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          'gpt-5.6-terra': {
            input_cost_per_token: 0.0000025,
            cache_read_input_token_cost: 0.00000025,
            cache_creation_input_token_cost: 0.000003125,
            output_cost_per_token: 0.000015,
          },
        }),
    }));
    const service = new PricingService({
      cachePath,
      fetch: fetchPricing,
    });

    const snapshot = await service.ready();

    expect(fetchPricing).toHaveBeenCalledWith(
      PRICING_CATALOG_URL,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json' },
      }),
    );
    expect(snapshot?.rates).toEqual([
      {
        harness: 'codex',
        key: 'openai-gpt-5.6-terra',
        input: 2.5,
        cachedInput: 0.25,
        cacheWrite: 3.125,
        output: 15,
      },
    ]);
    expect(
      calculateTurnBilling('codex', 'codex-gpt-5-6-terra', {
        inputTokens: 1_000,
      })?.costMicros,
    ).toBe(2_500);
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toMatchObject({
      source: PRICING_CATALOG_URL,
      rates: snapshot?.rates,
    });
  });

  it('uses the last-known-good cache when the startup request fails', async () => {
    const cached: PricingCatalogSnapshot = {
      version: 'litellm-cached',
      source: PRICING_CATALOG_URL,
      fetchedAt: 1,
      rates: [
        {
          harness: 'claude_code',
          key: 'claude-opus-4.8',
          input: 5,
          cachedInput: 0.5,
          cacheWrite: 6.25,
          output: 25,
        },
      ],
    };
    await writeFile(cachePath, JSON.stringify(cached));
    const service = new PricingService({
      cachePath,
      fetch: vi.fn(async () => {
        throw new Error('offline');
      }),
    });

    await expect(service.ready()).resolves.toEqual(cached);
    expect(
      calculateTurnBilling('claude_code', 'claude-opus-4-8[1m]', {
        inputTokens: 1_000,
      })?.pricingKey,
    ).toBe('litellm-cached:claude-opus-4.8');
  });

  it('rejects unsupported or incomplete remote entries', async () => {
    const service = new PricingService({
      cachePath,
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            'unknown-model': {
              input_cost_per_token: 0.000001,
              output_cost_per_token: 0.000001,
            },
          }),
      })),
    });

    await expect(service.ready()).resolves.toBeNull();
    await expect(readFile(cachePath, 'utf8')).rejects.toThrow();
  });
});
