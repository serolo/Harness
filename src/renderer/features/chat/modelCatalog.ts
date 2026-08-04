import type { HarnessId } from '@shared/harness';

export interface ProviderModelOption {
  id: string;
  label: string;
  model?: string;
  harness?: HarnessId;
  favorite?: boolean;
  isNew?: boolean;
}

export interface ProviderModelGroup {
  id: string;
  label: string;
  harness?: HarnessId;
  options: ProviderModelOption[];
}

export const PROVIDER_MODEL_GROUPS: ProviderModelGroup[] = [
  {
    id: 'claude_code',
    label: 'Claude Code',
    harness: 'claude_code',
    options: [
      {
        id: 'claude-fable-5',
        label: 'Fable 5',
        model: 'fable',
        harness: 'claude_code',
        favorite: true,
      },
      {
        id: 'claude-opus-5',
        label: 'Opus 5',
        model: 'opus',
        harness: 'claude_code',
        isNew: true,
      },
      {
        id: 'claude-opus-4-8-1m',
        label: 'Opus 4.8 1M',
        model: 'opus',
        harness: 'claude_code',
        favorite: true,
      },
      {
        id: 'claude-opus-4-7-1m',
        label: 'Opus 4.7 1M',
        model: 'opus',
        harness: 'claude_code',
      },
      {
        id: 'claude-opus-4-6-1m',
        label: 'Opus 4.6 1M',
        model: 'opus',
        harness: 'claude_code',
      },
      {
        id: 'claude-sonnet-5-1m',
        label: 'Sonnet 5 1M',
        model: 'sonnet',
        harness: 'claude_code',
      },
      {
        id: 'claude-sonnet-4-6-1m',
        label: 'Sonnet 4.6 1M',
        model: 'sonnet',
        harness: 'claude_code',
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Sonnet 4.6',
        model: 'sonnet',
        harness: 'claude_code',
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Haiku 4.5',
        model: 'haiku',
        harness: 'claude_code',
      },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    harness: 'codex',
    options: [
      { id: 'codex-gpt-5-6-sol', label: 'GPT-5.6 Sol', harness: 'codex' },
      { id: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra', harness: 'codex' },
      { id: 'codex-gpt-5-6-luna', label: 'GPT-5.6 Luna', harness: 'codex' },
      { id: 'codex-gpt-5-5', label: 'GPT-5.5', harness: 'codex' },
      { id: 'codex-gpt-5-4', label: 'GPT-5.4', harness: 'codex' },
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    options: [
      { id: 'opencode-big-pickle', label: 'opencode/big-pickle' },
      {
        id: 'opencode-deepseek-v4-flash',
        label: 'opencode/deepseek-v4-flash-fr...',
      },
      { id: 'opencode-mimo-v2-5-free', label: 'opencode/mimo-v2.5-free' },
      {
        id: 'opencode-nemotron-3-ultra-free',
        label: 'opencode/nemotron-3-ultra-free',
      },
      {
        id: 'opencode-north-mini-code-free',
        label: 'opencode/north-mini-code-free',
      },
    ],
  },
];

const OPENCODE_SETUP_KEY = 'harness:opencode-configured';

export function isOpenCodeConfigured(): boolean {
  return window.localStorage.getItem(OPENCODE_SETUP_KEY) === 'true';
}

export function visibleProviderModelGroups(): ProviderModelGroup[] {
  return PROVIDER_MODEL_GROUPS.filter(
    (group) => group.id !== 'opencode' || isOpenCodeConfigured(),
  );
}

export function resolveProviderModelId(value: string): string {
  return (
    PROVIDER_MODEL_GROUPS.flatMap((group) => group.options).find(
      (option) => option.id === value || option.model === value,
    )?.id ?? value
  );
}

/**
 * Convert a catalogue selection to the identifier accepted by the harness CLI.
 * Claude's family aliases (for example `opus`) float to the newest release, so a
 * versioned catalogue choice must keep its exact identifier. The catalogue represents
 * extended context with a `-1m` suffix; Claude Code expects that as `[1m]`.
 */
export function runtimeProviderModel(option: ProviderModelOption): string {
  if (option.harness === 'claude_code' && option.id.startsWith('claude-')) {
    return option.id.endsWith('-1m')
      ? `${option.id.slice(0, -3)}[1m]`
      : option.id;
  }
  return option.model ?? option.id;
}
