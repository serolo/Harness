import type { HarnessId } from '@shared/harness';
import type { MonthlyUsage, MonthlyUsageModel } from '@shared/billing';
import type { AppDatabase } from '../index';

const HARNESS_IDS: readonly HarnessId[] = ['claude_code', 'codex', 'cursor'];

function isHarnessId(value: string | null): value is HarnessId {
  return value !== null && HARNESS_IDS.includes(value as HarnessId);
}

export class UsageRepo {
  constructor(private readonly db: AppDatabase) {}

  async monthly(
    month: string,
    startAt: number,
    endAt: number,
  ): Promise<MonthlyUsage> {
    const rows = await this.db
      .selectFrom('turns')
      .select([
        'harness',
        'model',
        'cost_micros',
        'input_tokens',
        'cached_input_tokens',
        'output_tokens',
      ])
      .where('started_at', '>=', startAt)
      .where('started_at', '<', endAt)
      .where('reverted_at', 'is', null)
      .where('status', '!=', 'streaming')
      .execute();

    const groups = new Map<string, MonthlyUsageModel>();
    let unpricedTurns = 0;
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    for (const row of rows) {
      // Token telemetry remains useful even when an older turn lacks enough model
      // metadata to calculate a price.
      inputTokens += row.input_tokens ?? 0;
      cachedInputTokens += row.cached_input_tokens ?? 0;
      outputTokens += row.output_tokens ?? 0;
      if (
        row.cost_micros === null ||
        row.model === null ||
        !isHarnessId(row.harness)
      ) {
        unpricedTurns += 1;
        continue;
      }
      const key = `${row.harness}:${row.model}`;
      const group = groups.get(key) ?? {
        harness: row.harness,
        model: row.model,
        costMicros: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        turns: 0,
      };
      group.costMicros += row.cost_micros;
      group.inputTokens += row.input_tokens ?? 0;
      group.cachedInputTokens += row.cached_input_tokens ?? 0;
      group.outputTokens += row.output_tokens ?? 0;
      group.turns += 1;
      groups.set(key, group);
    }
    const models = [...groups.values()].sort(
      (left, right) => right.costMicros - left.costMicros,
    );
    return {
      month,
      totalCostMicros: models.reduce((sum, row) => sum + row.costMicros, 0),
      inputTokens,
      cachedInputTokens,
      outputTokens,
      turns: rows.length,
      unpricedTurns,
      models,
    };
  }
}
