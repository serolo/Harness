// useCommands — the ⌘K command palette's action registry (Phase 6, Track H2).
//
// ONE registry, two surfaces: the palette renders + runs these commands, and AppLayout's
// `menu:action` dispatcher looks the FIXED ids up in the same registry (`byId`) so a
// keyboard accelerator and a palette entry can never drift. The action implementations
// (reveal pane, open settings, new workspace, open PR, select workspace) are injected by
// AppLayout so this hook stays presentational-adjacent — no direct IPC here.
//
// Workspace-switch commands are generated per live workspace (id `selectWorkspace:<wsId>`);
// the menu's POSITIONAL `selectWorkspace:<n>` (⌘1…⌘9) stays handled by AppLayout since it
// binds to list position, not a specific id.

import { useMemo } from 'react';

import { useWorkspacesStore } from '@renderer/stores/workspaces';

/** The fixed workspace views the palette can reveal. */
export type CenterPane = 'chat' | 'terminal' | 'diff';

/** One palette command: a stable id, display text, optional keywords, and its effect. */
export interface Command {
  /** Stable id. Fixed-action ids match `shortcuts.ts` (e.g. `openSettings`, `showDiff`). */
  id: string;
  /** Primary label shown in the palette. */
  title: string;
  /** Optional secondary text (e.g. a group name or the workspace's project). */
  subtitle?: string;
  /** Extra text folded into fuzzy matching but not shown (e.g. synonyms). */
  keywords?: string;
  /** Run the command's effect. */
  run: () => void;
}

/** The action callbacks the registry binds commands to (owned by AppLayout). */
export interface CommandActions {
  /** Reveal a fixed workspace pane (chat / terminal / diff). */
  showPane: (pane: CenterPane) => void;
  /** Open the global settings overlay. */
  openSettings: () => void;
  /** Open the New Workspace dialog. */
  newWorkspace: () => void;
  /** Open (or publish + open) the pull request for the selected workspace. */
  openPr: () => void;
  /** Focus a workspace by id. */
  selectWorkspace: (id: string) => void;
}

/**
 * Build the command registry for the current workspace list + injected actions. Returns
 * the ordered list (for display) and a by-id map (for the menu dispatcher). Memoized on
 * the inputs so identity is stable across renders that don't change them.
 */
export function useCommands(actions: CommandActions): {
  commands: Command[];
  byId: Map<string, Command>;
} {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const selectedProjectId = useWorkspacesStore((s) => s.selectedProjectId);

  return useMemo(() => {
    const fixed: Command[] = [
      {
        id: 'newWorkspace',
        title: 'New Workspace',
        subtitle: 'Workspace',
        keywords: 'create add',
        run: actions.newWorkspace,
      },
      {
        id: 'openPr',
        title: 'Open Pull Request',
        subtitle: 'Workspace',
        keywords: 'pr github publish push',
        run: actions.openPr,
      },
      {
        id: 'showChat',
        title: 'Show Chat',
        subtitle: 'View',
        run: () => actions.showPane('chat'),
      },
      {
        id: 'showTerminal',
        title: 'Show Terminal',
        subtitle: 'View',
        run: () => actions.showPane('terminal'),
      },
      {
        id: 'showDiff',
        title: 'Show Diff',
        subtitle: 'View',
        run: () => actions.showPane('diff'),
      },
      {
        id: 'openSettings',
        title: 'Settings',
        subtitle: 'View',
        keywords: 'preferences config',
        run: actions.openSettings,
      },
    ];

    // Per-workspace switch commands, scoped to the active project (all when none pinned)
    // and excluding archived rows — mirrors AppLayout's positional selectWorkspace filter.
    const switchCommands: Command[] = workspaces
      .filter(
        (w) =>
          (selectedProjectId === null || w.projectId === selectedProjectId) &&
          w.status !== 'archived',
      )
      .map((w) => ({
        id: `selectWorkspace:${w.id}`,
        title: `Switch to ${w.name}`,
        subtitle: 'Workspace',
        keywords: 'go focus open',
        run: () => actions.selectWorkspace(w.id),
      }));

    const commands = [...fixed, ...switchCommands];
    const byId = new Map(commands.map((c) => [c.id, c]));
    return { commands, byId };
  }, [workspaces, selectedProjectId, actions]);
}

/**
 * Case-insensitive SUBSEQUENCE fuzzy match of `query` against `text`. Returns a score
 * (higher = better; contiguous + early matches score more) or `null` when `query` is not
 * a subsequence of `text`. An empty query matches everything with a neutral score.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === '') return 1;

  let score = 0;
  let ti = 0;
  let lastMatch = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    // Reward contiguous runs (found === lastMatch+1) and early matches.
    if (found === lastMatch + 1) score += 3;
    score += Math.max(0, 5 - found + ti);
    lastMatch = found;
    ti = found + 1;
  }
  return score;
}

/**
 * Filter + rank commands by a fuzzy query over their title + keywords. Non-matching
 * commands are dropped; the rest are sorted best-first (stable within equal scores).
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  if (query.trim() === '') return commands;
  const scored: { command: Command; score: number }[] = [];
  for (const command of commands) {
    const haystack = `${command.title} ${command.keywords ?? ''}`;
    const score = fuzzyScore(query.trim(), haystack);
    if (score !== null) scored.push({ command, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.command);
}
