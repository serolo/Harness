// Shortcuts keymap (Task H1). Pure — no Electron. Covers the default table and the
// override merge (rebind, ignore-unknown, ignore-empty, no-mutation).

import { describe, it, expect } from 'vitest';

import { DEFAULT_SHORTCUTS, resolveShortcuts } from './shortcuts';

describe('DEFAULT_SHORTCUTS', () => {
  it('includes the named actions and the ⌘1..9 workspace selectors', () => {
    const ids = DEFAULT_SHORTCUTS.map((a) => a.id);
    expect(ids).toContain('openSettings');
    expect(ids).toContain('showDiff');
    expect(ids).toContain('commandPalette');
    expect(ids).toContain('selectWorkspace:1');
    expect(ids).toContain('selectWorkspace:9');
    expect(ids).not.toContain('selectWorkspace:10');
  });

  it('has a unique id per action', () => {
    const ids = DEFAULT_SHORTCUTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('resolveShortcuts', () => {
  it('returns the defaults when there are no overrides', () => {
    const resolved = resolveShortcuts();
    expect(resolved).toEqual([...DEFAULT_SHORTCUTS]);
    // A fresh array of fresh objects — not the frozen defaults.
    expect(resolved).not.toBe(DEFAULT_SHORTCUTS);
  });

  it('rebinds a matching action and leaves the rest untouched', () => {
    const resolved = resolveShortcuts({ showDiff: 'CmdOrCtrl+D' });
    expect(resolved.find((a) => a.id === 'showDiff')?.accelerator).toBe(
      'CmdOrCtrl+D',
    );
    expect(resolved.find((a) => a.id === 'showTerminal')?.accelerator).toBe(
      'CmdOrCtrl+T',
    );
  });

  it('ignores an override for an unknown id', () => {
    const resolved = resolveShortcuts({ doesNotExist: 'CmdOrCtrl+X' });
    expect(resolved.some((a) => a.id === 'doesNotExist')).toBe(false);
  });

  it('ignores an empty override (keeps the default binding)', () => {
    const resolved = resolveShortcuts({ openSettings: '' });
    expect(resolved.find((a) => a.id === 'openSettings')?.accelerator).toBe(
      'CmdOrCtrl+,',
    );
  });

  it('does not mutate DEFAULT_SHORTCUTS', () => {
    resolveShortcuts({ showDiff: 'CmdOrCtrl+D' });
    expect(
      DEFAULT_SHORTCUTS.find((a) => a.id === 'showDiff')?.accelerator,
    ).toBe('CmdOrCtrl+Shift+D');
  });
});
