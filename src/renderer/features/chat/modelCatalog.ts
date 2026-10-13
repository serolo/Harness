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
        id: 'claude-haiku-4-5',
        label: 'Haiku 4.5',
        model: 'haiku',
        harness: 'claude_code',
      },
      {
        id: 'claude-sonnet-5',
        label: 'Sonnet 5',
        model: 'sonnet',
        harness: 'claude_code',
      },
      {
        id: 'claude-opus-5',
        label: 'Opus 5',
        model: 'opus',
        harness: 'claude_code',
      },
      {
        id: 'claude-fable-5',
        label: 'Fable 5',
        model: 'fable',
        harness: 'claude_code',
        favorite: true,
      },
      {
        id: 'claude-opus-4-8',
        label: 'Opus 4.8',
        model: 'opus',
        harness: 'claude_code',
        favorite: true,
      },
      {
        id: 'claude-opus-4-7',
        label: 'Opus 4.7',
        model: 'opus',
        harness: 'claude_code',
      },
      {
        id: 'claude-opus-4-6',
        label: 'Opus 4.6',
        model: 'opus',
        harness: 'claude_code',
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Sonnet 4.6',
        model: 'sonnet',
        harness: 'claude_code',
      },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    harness: 'codex',
    options: [
      {
        id: 'codex-gpt-6-1-sol',
        label: 'GPT-6.1 Sol',
        model: 'gpt-6.1-sol',
        harness: 'codex',
      },
      {
        id: 'codex-gpt-6-astra',
        label: 'GPT-6 Astra',
        model: 'gpt-6-astra',
        harness: 'codex',
      },
      {
        id: 'codex-gpt-6-sol',
        label: 'GPT-6 Sol',
        model: 'gpt-6-sol',
        harness: 'codex',
      },
      {
        id: 'codex-gpt-6-luna',
        label: 'GPT-6 Luna',
        model: 'gpt-6-luna',
        harness: 'codex',
      },
      {
        id: 'codex-gpt-5-6-sol',
        label: 'GPT-5.6 Sol',
        model: 'gpt-5.6-sol',
        harness: 'codex',
      },
      {
        id: 'codex-gpt-5-6-terra',
        label: 'GPT-5.6 Terra',
        model: 'gpt-5.6-terra',
        harness: 'codex',
      },
      {
        id: 'codex-gpt-5-6-luna',
        label: 'GPT-5.6 Luna',
        model: 'gpt-5.6-luna',
        harness: 'codex',
      },
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
 * versioned catalogue choice must keep its exact identifier. Legacy extended-context
 * choices still use a `-1m` suffix, which Claude Code expects as `[1m]`.
 */
export function runtimeProviderModel(option: ProviderModelOption): string {
  if (option.harness === 'claude_code' && option.id.startsWith('claude-')) {
    return option.id.endsWith('-1m')
      ? `${option.id.slice(0, -3)}[1m]`
      : option.id;
  }
  return option.model ?? option.id;
}
