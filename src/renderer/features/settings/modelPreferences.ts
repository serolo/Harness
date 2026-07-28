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
  // Older builds stored provider-qualified IDs. Keep the exact model/version while
  // removing only the provider prefix understood by the UI catalogue.
  return model.replace(/^anthropic\/(?=claude-)/i, '');
}

export function writeModelPreferences(preferences: ModelPreferences): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
