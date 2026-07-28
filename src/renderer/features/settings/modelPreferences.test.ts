import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_PREFERENCES,
  readModelPreferences,
} from './modelPreferences';

afterEach(() => window.localStorage.clear());

describe('model preferences migration', () => {
  it('preserves exact versioned Claude model ids', () => {
    window.localStorage.setItem(
      'harness:model-preferences',
      JSON.stringify({
        ...DEFAULT_MODEL_PREFERENCES,
        defaultModel: 'claude-opus-4-8-1m',
        reviewModel: 'claude-sonnet-5-1m',
      }),
    );

    expect(readModelPreferences()).toMatchObject({
      defaultModel: 'claude-opus-4-8-1m',
      reviewModel: 'claude-sonnet-5-1m',
    });
  });

  it('removes provider qualification without losing the exact model', () => {
    window.localStorage.setItem(
      'harness:model-preferences',
      JSON.stringify({
        ...DEFAULT_MODEL_PREFERENCES,
        defaultModel: 'anthropic/claude-opus-4-8-1m',
        reviewModel: 'anthropic/claude-haiku-4-5',
      }),
    );

    expect(readModelPreferences()).toMatchObject({
      defaultModel: 'claude-opus-4-8-1m',
      reviewModel: 'claude-haiku-4-5',
    });
  });
});
