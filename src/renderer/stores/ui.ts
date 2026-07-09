// Cross-cutting UI intent store (Phase 6, Track H2).
//
// A tiny store for transient, app-global UI state that more than one feature needs to
// drive but that isn't workspace/nav data: the ⌘K command palette's open state and the
// "New Workspace" dialog's open state. Both were previously local to a single component
// (the palette didn't exist; the dialog lived inside the Sidebar), which meant a menu
// accelerator / palette entry had no way to open them. Lifting just the open flags here
// keeps the dialog/palette bodies where they are while giving the menu + palette one shared
// switch — a shortcut and a palette entry can't diverge.

import { create } from 'zustand';

export interface UiState {
  /** Whether the ⌘K command palette overlay is open. */
  paletteOpen: boolean;
  /** Open/close/toggle the command palette (the ⌘K accelerator toggles). */
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  /** Whether the New Workspace dialog is open (Sidebar renders it; menu/palette open it). */
  newWorkspaceOpen: boolean;
  setNewWorkspaceOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  newWorkspaceOpen: false,
  setNewWorkspaceOpen: (newWorkspaceOpen) => set({ newWorkspaceOpen }),
}));
