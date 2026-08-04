import { describe, expect, it } from 'vitest';
import { runtimeProviderModel } from './modelCatalog';

describe('runtimeProviderModel', () => {
  it('keeps the exact Claude version with its 1M context suffix', () => {
    expect(
      runtimeProviderModel({
        id: 'claude-opus-4-8-1m',
        label: 'Opus 4.8 1M',
        model: 'opus',
        harness: 'claude_code',
      }),
    ).toBe('claude-opus-4-8[1m]');
  });

  it('keeps the exact Claude version for standard-context models', () => {
    expect(
      runtimeProviderModel({
        id: 'claude-sonnet-4-6',
        label: 'Sonnet 4.6',
        model: 'sonnet',
        harness: 'claude_code',
      }),
    ).toBe('claude-sonnet-4-6');
  });

  it('leaves non-Claude model identifiers unchanged', () => {
    expect(
      runtimeProviderModel({
        id: 'codex-gpt-5-6-terra',
        label: 'GPT-5.6 Terra',
        harness: 'codex',
      }),
    ).toBe('codex-gpt-5-6-terra');
  });
});
