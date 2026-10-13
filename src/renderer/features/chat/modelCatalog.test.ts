import { describe, expect, it } from 'vitest';
import { PROVIDER_MODEL_GROUPS, runtimeProviderModel } from './modelCatalog';

describe('PROVIDER_MODEL_GROUPS', () => {
  it('lists the supported Claude models in provider order', () => {
    expect(
      PROVIDER_MODEL_GROUPS.find(
        (group) => group.id === 'claude_code',
      )?.options.map(({ id, label }) => ({ id, label })),
    ).toEqual([
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    ]);
  });

  it('lists the supported Codex models in provider order', () => {
    expect(
      PROVIDER_MODEL_GROUPS.find((group) => group.id === 'codex')?.options.map(
        ({ label, model }) => ({ label, model }),
      ),
    ).toEqual([
      { label: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' },
      { label: 'GPT-6 Astra', model: 'gpt-6-astra' },
      { label: 'GPT-6 Sol', model: 'gpt-6-sol' },
      { label: 'GPT-6 Luna', model: 'gpt-6-luna' },
      { label: 'GPT-5.6 Sol', model: 'gpt-5.6-sol' },
      { label: 'GPT-5.6 Terra', model: 'gpt-5.6-terra' },
      { label: 'GPT-5.6 Luna', model: 'gpt-5.6-luna' },
    ]);
  });
});

describe('runtimeProviderModel', () => {
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

  it('maps Codex display identifiers to provider model identifiers', () => {
    expect(
      runtimeProviderModel({
        id: 'codex-gpt-6-astra',
        label: 'GPT-6 Astra',
        model: 'gpt-6-astra',
        harness: 'codex',
      }),
    ).toBe('gpt-6-astra');
  });
});
