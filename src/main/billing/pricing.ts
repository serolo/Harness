// Startup pricing refresh. Provider model-list APIs expose availability/capabilities,
// but not token prices, so Harness consumes LiteLLM's maintained public JSON catalogue.
// Only an allowlist of models already supported by Harness is extracted. The compact,
// validated result is cached as last-known-good data; bundled rates remain the fallback.

import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  installPricingCatalog,
  type PricingCatalogRate,
  type PricingCatalogSnapshot,
} from '@shared/billing';
import type { HarnessId } from '@shared/harness';

export const PRICING_CATALOG_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_CHARS = 20 * 1024 * 1024;
const MAX_USD_PER_MILLION_TOKENS = 1_000;

interface ModelMapping {
  harness: HarnessId;
  key: string;
  model: string;
}

const MODEL_MAPPINGS: readonly ModelMapping[] = [
  { harness: 'claude_code', key: 'claude-fable-5', model: 'claude-fable-5' },
  { harness: 'claude_code', key: 'claude-opus-5', model: 'claude-opus-5' },
  {
    harness: 'claude_code',
    key: 'claude-sonnet-5-intro',
    model: 'claude-sonnet-5',
  },
  {
    harness: 'claude_code',
    key: 'claude-haiku-4.5',
    model: 'claude-haiku-4-5',
  },
  {
    harness: 'claude_code',
    key: 'claude-opus-4.8',
    model: 'claude-opus-4-8',
  },
  {
    harness: 'claude_code',
    key: 'claude-opus-4.7',
    model: 'claude-opus-4-7',
  },
  {
    harness: 'claude_code',
    key: 'claude-opus-4.6',
    model: 'claude-opus-4-6',
  },
  {
    harness: 'claude_code',
    key: 'claude-sonnet-4.6',
    model: 'claude-sonnet-4-6',
  },
  {
    harness: 'claude_code',
    key: 'claude-sonnet-4.5',
    model: 'claude-sonnet-4-5',
  },
  {
    harness: 'claude_code',
    key: 'claude-opus-4.5',
    model: 'claude-opus-4-5',
  },
  {
    harness: 'claude_code',
    key: 'claude-opus-4.1',
    model: 'claude-opus-4-1-20250805',
  },
  {
    harness: 'claude_code',
    key: 'claude-sonnet-4',
    model: 'claude-sonnet-4-20250514',
  },
  {
    harness: 'claude_code',
    key: 'claude-opus-4',
    model: 'claude-opus-4-20250514',
  },
  { harness: 'codex', key: 'openai-gpt-5.6-sol', model: 'gpt-5.6-sol' },
  { harness: 'codex', key: 'openai-gpt-5.6-terra', model: 'gpt-5.6-terra' },
  { harness: 'codex', key: 'openai-gpt-5.6-luna', model: 'gpt-5.6-luna' },
  { harness: 'codex', key: 'openai-gpt-5.5-pro', model: 'gpt-5.5-pro' },
  { harness: 'codex', key: 'openai-gpt-5.5', model: 'gpt-5.5' },
  { harness: 'codex', key: 'openai-gpt-5.4-mini', model: 'gpt-5.4-mini' },
  { harness: 'codex', key: 'openai-gpt-5.4-nano', model: 'gpt-5.4-nano' },
  { harness: 'codex', key: 'openai-gpt-5.4-pro', model: 'gpt-5.4-pro' },
  { harness: 'codex', key: 'openai-gpt-5.4', model: 'gpt-5.4' },
];

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchPricing = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<FetchResponse>;

export interface PricingServiceOptions {
  cachePath: string;
  fetch?: FetchPricing;
  log?: (message: string) => void;
}

export class PricingService {
  private readonly cachePath: string;
  private readonly fetchPricing: FetchPricing;
  private readonly log: (message: string) => void;
  private current: PricingCatalogSnapshot | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(options: PricingServiceOptions) {
    this.cachePath = options.cachePath;
    this.fetchPricing =
      options.fetch ??
      ((url, init) => globalThis.fetch(url, init) as Promise<FetchResponse>);
    this.log = options.log ?? (() => undefined);
  }

  /** Load cached rates immediately, then attempt one bounded network refresh. */
  start(): Promise<void> {
    if (this.startPromise === null) {
      this.startPromise = this.loadCache()
        .then(() => this.refresh())
        .catch((error: unknown) => {
          this.log(`pricing refresh failed: ${errorMessage(error)}`);
        });
    }
    return this.startPromise;
  }

  /** Await the startup attempt and return cached/refreshed rates, if available. */
  async ready(): Promise<PricingCatalogSnapshot | null> {
    await this.start();
    return this.current;
  }

  private async loadCache(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.cachePath, 'utf8'),
      ) as unknown;
      const snapshot = validateSnapshot(parsed);
      if (snapshot !== null) {
        this.install(snapshot);
        this.log(`pricing cache loaded (${snapshot.rates.length} models)`);
      }
    } catch {
      // Missing or malformed cache is equivalent to a first launch.
    }
  }

  private async refresh(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchPricing(PRICING_CATALOG_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`catalog returned HTTP ${response.status}`);
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARS) {
        throw new Error('catalog response exceeded size limit');
      }
      const rates = extractRates(JSON.parse(text) as unknown);
      if (rates.length === 0) {
        throw new Error('catalog contained no supported model prices');
      }
      const snapshot: PricingCatalogSnapshot = {
        version: `litellm-${Date.now()}`,
        source: PRICING_CATALOG_URL,
        fetchedAt: Date.now(),
        rates,
      };
      this.install(snapshot);
      await this.writeCache(snapshot);
      this.log(`pricing refreshed (${rates.length} models)`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private install(snapshot: PricingCatalogSnapshot): void {
    this.current = snapshot;
    installPricingCatalog(snapshot);
  }

  private async writeCache(snapshot: PricingCatalogSnapshot): Promise<void> {
    const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, this.cachePath);
  }
}

function extractRates(value: unknown): PricingCatalogRate[] {
  if (!isRecord(value)) return [];
  const rates: PricingCatalogRate[] = [];
  for (const mapping of MODEL_MAPPINGS) {
    const entry = value[mapping.model];
    if (!isRecord(entry)) continue;
    const input = perMillion(entry['input_cost_per_token']);
    const cachedInput = perMillion(entry['cache_read_input_token_cost']);
    const output = perMillion(entry['output_cost_per_token']);
    // OpenAI does not report cache writes as a separate billed usage category, so
    // older catalogue entries omit this field. Falling back to base input keeps the
    // snapshot usable and is inert unless a harness actually reports write tokens.
    const cacheWrite =
      perMillion(entry['cache_creation_input_token_cost']) ?? input;
    if (
      input === null ||
      cachedInput === null ||
      cacheWrite === null ||
      output === null
    ) {
      continue;
    }
    rates.push({
      harness: mapping.harness,
      key: mapping.key,
      input,
      cachedInput,
      cacheWrite,
      output,
    });
  }
  return rates;
}

function validateSnapshot(value: unknown): PricingCatalogSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value['version'] !== 'string' ||
    value['version'].length === 0 ||
    value['source'] !== PRICING_CATALOG_URL ||
    !isPositiveFinite(value['fetchedAt']) ||
    !Array.isArray(value['rates'])
  ) {
    return null;
  }
  const allowed = new Set(
    MODEL_MAPPINGS.map((mapping) => `${mapping.harness}:${mapping.key}`),
  );
  const seen = new Set<string>();
  const rates: PricingCatalogRate[] = [];
  for (const candidate of value['rates']) {
    if (
      !isRecord(candidate) ||
      (candidate['harness'] !== 'claude_code' &&
        candidate['harness'] !== 'codex' &&
        candidate['harness'] !== 'cursor') ||
      typeof candidate['key'] !== 'string'
    ) {
      return null;
    }
    const id = `${candidate['harness']}:${candidate['key']}`;
    if (!allowed.has(id) || seen.has(id)) return null;
    const input = boundedRate(candidate['input']);
    const cachedInput = boundedRate(candidate['cachedInput']);
    const cacheWrite = boundedRate(candidate['cacheWrite']);
    const output = boundedRate(candidate['output']);
    if (
      input === null ||
      cachedInput === null ||
      cacheWrite === null ||
      output === null
    ) {
      return null;
    }
    seen.add(id);
    rates.push({
      harness: candidate['harness'],
      key: candidate['key'],
      input,
      cachedInput,
      cacheWrite,
      output,
    });
  }
  if (rates.length === 0) return null;
  return {
    version: value['version'],
    source: value['source'],
    fetchedAt: value['fetchedAt'],
    rates,
  };
}

function perMillion(value: unknown): number | null {
  if (!isPositiveFinite(value)) return null;
  return boundedRate(value * 1_000_000);
}

function boundedRate(value: unknown): number | null {
  return isPositiveFinite(value) && value <= MAX_USD_PER_MILLION_TOKENS
    ? value
    : null;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
