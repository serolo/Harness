import type { HarnessId, ReasoningEffort } from '@shared/harness';

export interface EffortOption {
  id: ReasoningEffort;
  label: string;
}

export const CLAUDE_EFFORT_OPTIONS: readonly EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
];

export const CODEX_EFFORT_OPTIONS: readonly EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
];

export function effortOptionsForHarness(
  harness: HarnessId | null | undefined,
): readonly EffortOption[] {
  return harness === 'codex' ? CODEX_EFFORT_OPTIONS : CLAUDE_EFFORT_OPTIONS;
}
