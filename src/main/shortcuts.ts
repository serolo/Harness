// Keyboard-shortcut keymap (Phase 6, Task H1 / spec §5.4).
//
// PURE + Electron-free so it is unit-testable without booting the app: it is just the
// default accelerator table + a merge with user overrides. The main process turns the
// resolved table into an application `Menu` (whose items emit `menu:action` to the
// renderer) in `index.ts`; the renderer dispatches each `actionId` against the current
// UI. Accelerator strings are Electron's format (`CmdOrCtrl+Shift+D`).

/** One bindable action: a stable id, a human label, and its accelerator. */
export interface ShortcutAction {
  /** Stable id echoed to the renderer as `menu:action` `actionId`. */
  id: string;
  /** Human label for the menu item. */
  label: string;
  /** Electron accelerator string (e.g. `CmdOrCtrl+Shift+D`). */
  accelerator: string;
}

/**
 * Native Electron View-menu roles. Keeping these as roles (instead of forwarding
 * renderer actions) preserves the platform's standard zoom behavior and keyboard
 * accelerators, including ⌘+ / ⌘- / ⌘0 on macOS.
 */
export const NATIVE_VIEW_ROLES = ['resetZoom', 'zoomIn', 'zoomOut'] as const;

/** Build the `⌘1…⌘9` "select workspace N" entries. */
function workspaceSelectShortcuts(): ShortcutAction[] {
  const out: ShortcutAction[] = [];
  for (let n = 1; n <= 9; n++) {
    out.push({
      id: `selectWorkspace:${n}`,
      label: `Select Workspace ${n}`,
      accelerator: `CmdOrCtrl+${n}`,
    });
  }
  return out;
}

/**
 * The default keymap (spec §5.4). Ids are the contract with the renderer's
 * `menu:action` dispatcher; changing an id is a renderer-visible change.
 */
export const DEFAULT_SHORTCUTS: readonly ShortcutAction[] = [
  {
    id: 'newWorkspace',
    label: 'New Workspace',
    accelerator: 'CmdOrCtrl+Shift+N',
  },
  { id: 'showDiff', label: 'Show Diff', accelerator: 'CmdOrCtrl+Shift+D' },
  {
    id: 'openPr',
    label: 'Open Pull Request',
    accelerator: 'CmdOrCtrl+Shift+P',
  },
  {
    id: 'archiveWorkspace',
    label: 'Archive Workspace',
    accelerator: 'CmdOrCtrl+Shift+A',
  },
  { id: 'showTerminal', label: 'Show Terminal', accelerator: 'CmdOrCtrl+T' },
  {
    id: 'commandPalette',
    label: 'Command Palette',
    accelerator: 'CmdOrCtrl+K',
  },
  { id: 'openSettings', label: 'Settings', accelerator: 'CmdOrCtrl+,' },
  ...workspaceSelectShortcuts(),
] as const;

/**
 * Resolve the effective keymap: the defaults with any user overrides applied. An
 * override maps an action id → a replacement accelerator; a non-string / empty value
 * or an id that matches no default action is ignored (defaults are never dropped, only
 * re-bound). Returns a fresh array; the input is not mutated.
 */
export function resolveShortcuts(
  overrides: Record<string, string> = {},
): ShortcutAction[] {
  return DEFAULT_SHORTCUTS.map((action) => {
    const override = overrides[action.id];
    if (typeof override === 'string' && override !== '') {
      return { ...action, accelerator: override };
    }
    return { ...action };
  });
}
