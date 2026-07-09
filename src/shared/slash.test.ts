// Pure slash-command helpers (Task D1). No Electron / no IPC — shared logic used by
// both the main `slash:list` handler and the renderer composer.

import { describe, it, expect } from 'vitest';

import {
  parseSlash,
  expandSlashTemplate,
  matchSlashCommands,
  type SlashCommand,
} from './slash';

describe('parseSlash', () => {
  it('parses a bare command', () => {
    expect(parseSlash('/review')).toEqual({ name: 'review', args: '' });
  });

  it('parses a command with trailing args', () => {
    expect(parseSlash('/pr focus on the diff')).toEqual({
      name: 'pr',
      args: 'focus on the diff',
    });
  });

  it('allows digits and hyphens in the name', () => {
    expect(parseSlash('/fix-checks now')).toEqual({
      name: 'fix-checks',
      args: 'now',
    });
  });

  it('returns null for non-commands', () => {
    expect(parseSlash('just prose')).toBeNull();
    expect(parseSlash('/')).toBeNull(); // bare slash
    expect(parseSlash('/ leading space')).toBeNull(); // space after slash
    expect(parseSlash('email a/b')).toBeNull(); // slash not at start
  });
});

describe('expandSlashTemplate', () => {
  it('substitutes $ARGS when present', () => {
    expect(expandSlashTemplate('Review: $ARGS please', 'the auth code')).toBe(
      'Review: the auth code please',
    );
  });

  it('appends args after a blank line when there is no placeholder', () => {
    expect(expandSlashTemplate('Do a review', 'of the diff')).toBe(
      'Do a review\n\nof the diff',
    );
  });

  it('returns the template unchanged when there are no args', () => {
    expect(expandSlashTemplate('Do a review', '')).toBe('Do a review');
    expect(expandSlashTemplate('Review: $ARGS', '')).toBe('Review: ');
  });
});

describe('matchSlashCommands', () => {
  const cmds: SlashCommand[] = [
    { name: 'review', template: 'r' },
    { name: 'refactor', template: 'rf' },
    { name: 'pr', template: 'p' },
  ];

  it('returns the whole catalogue for an empty query', () => {
    expect(matchSlashCommands('', cmds).map((c) => c.name)).toEqual([
      'review',
      'refactor',
      'pr',
    ]);
  });

  it('prefers prefix matches, then shorter names', () => {
    // "re" prefixes review + refactor; review is shorter → first.
    expect(matchSlashCommands('re', cmds).map((c) => c.name)).toEqual([
      'review',
      'refactor',
    ]);
  });

  it('falls back to subsequence matches', () => {
    // "rf" is a subsequence of refactor (r..f) but not a prefix of anything.
    expect(matchSlashCommands('rf', cmds).map((c) => c.name)).toContain(
      'refactor',
    );
  });
});
