export interface ModelPreferences {
  defaultModel: string;
  defaultEffort: string;
  reviewModel: string;
  reviewEffort: string;
  planMode: boolean;
  fastMode: boolean;
}

const STORAGE_KEY = 'harness:model-preferences';

export const DEFAULT_MODEL_PREFERENCES: ModelPreferences = {
  defaultModel: 'opus',
  defaultEffort: 'high',
  reviewModel: 'opus',
  reviewEffort: 'high',
  planMode: false,
  fastMode: false,
};

export function readModelPreferences(): ModelPreferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return DEFAULT_MODEL_PREFERENCES;
    const preferences = {
      ...DEFAULT_MODEL_PREFERENCES,
      ...JSON.parse(stored),
    } as ModelPreferences;
    return {
      ...preferences,
      defaultModel: migrateClaudeModel(preferences.defaultModel),
      reviewModel: migrateClaudeModel(preferences.reviewModel),
    };
  } catch {
    return DEFAULT_MODEL_PREFERENCES;
  }
}

function migrateClaudeModel(model: string): string {
  if (/^(?:anthropic\/)?claude-.*opus/i.test(model)) return 'opus';
  if (/^(?:anthropic\/)?claude-.*sonnet/i.test(model)) return 'sonnet';
  if (/^(?:anthropic\/)?claude-.*haiku/i.test(model)) return 'haiku';
  if (/^(?:anthropic\/)?claude-.*fable/i.test(model)) return 'fable';
  return model;
}

export function writeModelPreferences(preferences: ModelPreferences): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
