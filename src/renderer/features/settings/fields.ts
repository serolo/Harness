// Declarative field catalogue for the Settings panel (Phase 6, Track B/G).
//
// The panel renders sections → rows from these descriptors rather than hand-writing
// each control, so a new editable setting is one entry here. Each field names a dotted
// key path into the effective settings (the SAME path shape `settings:set` +
// provenance use), a control kind, and (for selects) the allowed values. Kept as pure
// data so it is trivially unit-testable and shared by the panel + its tests.

import { COMPLETION_SOUNDS } from '@shared/settings';

/** The control a settings row renders. */
export type FieldKind = 'text' | 'select' | 'boolean';

/** One editable setting: where it lives + how to edit it. */
export interface FieldDef {
  /** Dotted key path into the effective settings (e.g. `git.branchPrefix`). */
  keyPath: string;
  /** Human label for the row. */
  label: string;
  kind: FieldKind;
  /** Allowed values for a `select`. */
  options?: readonly string[];
  /** Optional user-facing labels keyed by stored select value. */
  optionLabels?: Readonly<Record<string, string>>;
  /** Optional one-line hint under the label. */
  hint?: string;
}

/** A titled group of fields. */
export interface SectionDef {
  title: string;
  fields: readonly FieldDef[];
}

/**
 * The editable settings surface. Scalars / enums / booleans only — array-valued
 * sections (`scripts.run`, `mcp`, `env`) get their own editors (Track B2) and are not
 * listed here. Notification toggles (Track G) are included.
 */
export const SETTINGS_SECTIONS: readonly SectionDef[] = [
  {
    title: 'Git',
    fields: [
      {
        keyPath: 'git.branchPrefix',
        label: 'Branch prefix',
        kind: 'text',
        hint: 'Prefix used for new agent-created branches.',
      },
      {
        keyPath: 'git.mergeStrategy',
        label: 'Merge strategy',
        kind: 'select',
        options: ['merge', 'squash', 'rebase'],
        hint: 'Default strategy used by the Merge button.',
      },
      {
        keyPath: 'git.deleteWorktreeOnArchive',
        label: 'Delete worktree on archive',
        kind: 'boolean',
        hint: 'Remove managed worktrees from disk when archiving a workspace.',
      },
    ],
  },
  {
    title: 'Agent',
    fields: [
      {
        keyPath: 'agent.defaultHarness',
        label: 'Default harness',
        kind: 'select',
        options: ['claude_code', 'codex', 'cursor'],
        hint: 'Harness used for new workspaces unless one is selected.',
      },
      {
        keyPath: 'agent.mode',
        label: 'Run mode',
        kind: 'select',
        options: ['plan', 'default', 'auto_accept'],
        hint: 'Default agent behavior for new turns.',
      },
      {
        keyPath: 'agent.harnessImpl',
        label: 'Harness implementation',
        kind: 'select',
        options: ['auto', 'mock'],
        hint: 'auto = real CLI · mock = scripted harness',
      },
    ],
  },
  {
    title: 'Notifications',
    fields: [
      {
        keyPath: 'notifications.completionSound',
        label: 'Work finished sound',
        kind: 'select',
        options: COMPLETION_SOUNDS,
        optionLabels: {
          none: 'None',
          glass: 'Glass',
          hero: 'Hero',
          ping: 'Ping',
          pop: 'Pop',
          submarine: 'Submarine',
        },
        hint: 'Play this sound when work finishes in any chat. Changing it previews the tone.',
      },
      {
        keyPath: 'notifications.enabled',
        label: 'Desktop notifications',
        kind: 'boolean',
        hint: 'Get notified when AI finishes working in a chat.',
      },
      {
        keyPath: 'notifications.onTurnComplete',
        label: 'Completion notifications',
        kind: 'boolean',
        hint: 'Notify when a turn completes cleanly.',
      },
      {
        keyPath: 'notifications.onError',
        label: 'Error notifications',
        kind: 'boolean',
        hint: 'Notify when a turn ends with an error.',
      },
      {
        keyPath: 'notifications.onNeedsAttention',
        label: 'Needs attention',
        kind: 'boolean',
        hint: 'Notify when a turn needs attention.',
      },
    ],
  },
] as const;

/** Read the value at a dotted key path from an object, or `undefined` if absent. */
export function getAtPath(obj: unknown, keyPath: string): unknown {
  let cursor: unknown = obj;
  for (const segment of keyPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
