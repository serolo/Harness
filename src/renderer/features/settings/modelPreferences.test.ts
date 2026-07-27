import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_PREFERENCES,
  readModelPreferences,
} from './modelPreferences';

afterEach(() => window.localStorage.clear());

describe('model preferences migration', () => {
  it('migrates versioned Claude model ids to CLI-supported aliases', () => {
    window.localStorage.setItem(
      'harness:model-preferences',
      JSON.stringify({
        ...DEFAULT_MODEL_PREFERENCES,
        defaultModel: 'claude-opus-4-8-1m',
        reviewModel: 'claude-sonnet-5-1m',
      }),
    );

    expect(readModelPreferences()).toMatchObject({
      defaultModel: 'opus',
      reviewModel: 'sonnet',
    });
  });

  it('migrates provider-qualified Claude model ids to CLI aliases', () => {
    window.localStorage.setItem(
      'harness:model-preferences',
      JSON.stringify({
        ...DEFAULT_MODEL_PREFERENCES,
        defaultModel: 'anthropic/claude-opus-4-8-1m',
        reviewModel: 'anthropic/claude-haiku-4-5',
      }),
    );

    expect(readModelPreferences()).toMatchObject({
      defaultModel: 'opus',
      reviewModel: 'haiku',
    });
  });
});
