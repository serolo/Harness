import type { AgentMode } from '@shared/harness';

function isPlanningArtifact(path: string): boolean {
  return path === 'plans' || path.startsWith('plans/');
}

/**
 * Decide from an actual pre-turn/post-turn Git tree diff. Provider file-edit events
 * are deliberately not used: some adapters emit them before an edit succeeds.
 */
export function hasEligibleRepositoryChanges(
  mode: AgentMode | null,
  changedPaths: readonly string[],
): boolean {
  if (mode === 'plan') return false;
  return changedPaths.some((path) => !isPlanningArtifact(path));
}
