// Declarative field catalogue for the Settings panel (Phase 6, Track B/G).
//
// The panel renders sections → rows from these descriptors rather than hand-writing
// each control, so a new editable setting is one entry here. Each field names a dotted
// key path into the effective settings (the SAME path shape `settings:set` +
// provenance use), a control kind, and (for selects) the allowed values. Kept as pure
// data so it is trivially unit-testable and shared by the panel + its tests.

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
      { keyPath: 'git.branchPrefix', label: 'Branch prefix', kind: 'text' },
      {
        keyPath: 'git.mergeStrategy',
        label: 'Merge strategy',
        kind: 'select',
        options: ['merge', 'squash', 'rebase'],
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
      },
      {
        keyPath: 'agent.mode',
        label: 'Run mode',
        kind: 'select',
        options: ['plan', 'default', 'auto_accept'],
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
        keyPath: 'notifications.enabled',
        label: 'Enable notifications',
        kind: 'boolean',
      },
      {
        keyPath: 'notifications.onTurnComplete',
        label: 'On turn complete',
        kind: 'boolean',
      },
      { keyPath: 'notifications.onError', label: 'On error', kind: 'boolean' },
      {
        keyPath: 'notifications.onNeedsAttention',
        label: 'On needs attention',
        kind: 'boolean',
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
