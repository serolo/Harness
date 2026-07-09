// Renderer-side terminal store (Zustand) — CLIENT-SIDE ONLY (no DB, plan §4).
//
// Tracks which terminal tabs are open per workspace and which one is active, plus a
// global "big terminal" toggle (maximize the terminal pane). This is ephemeral UI state:
// closing the app forgets open tabs — the shells themselves live in the main process and
// are torn down by the ProcessRegistry, not persisted here.
//
// A tab's `id` is a client-side identity used to key its xterm instance; it is NOT the
// main-side `ptyId` (that arrives on the `pty:open` stream's leading frame — see
// `useTerminal`). Keeping them separate lets a tab exist in the UI before/after its pty.

import { create } from 'zustand';

/** One open terminal tab as the UI tracks it (client-side identity + display title). */
export interface TerminalTabInfo {
  id: string;
  title: string;
}

export interface TerminalState {
  /** Open tabs per workspace id, in display order. */
  tabsByWorkspace: Record<string, TerminalTabInfo[]>;
  /** The active tab id per workspace id (null when a workspace has no tabs). */
  activeTabByWorkspace: Record<string, string | null>;
  /** Global maximize toggle for the terminal pane (keyboard wiring is a later phase). */
  bigTerminal: boolean;

  /** Open a new tab for a workspace and focus it; returns the new tab's id. */
  openTab: (workspaceId: string) => string;
  /** Close a tab; if it was active, focus the last remaining tab (or none). */
  closeTab: (workspaceId: string, tabId: string) => void;
  /** Focus an existing tab. */
  setActiveTab: (workspaceId: string, tabId: string) => void;
  /** Flip the big-terminal (maximize) state. */
  toggleBigTerminal: () => void;
  /** Set the big-terminal state explicitly. */
  setBigTerminal: (big: boolean) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  tabsByWorkspace: {},
  activeTabByWorkspace: {},
  bigTerminal: false,

  openTab: (workspaceId) => {
    const id = crypto.randomUUID();
    set((state) => {
      const tabs = state.tabsByWorkspace[workspaceId] ?? [];
      const tab: TerminalTabInfo = { id, title: `Terminal ${tabs.length + 1}` };
      return {
        tabsByWorkspace: {
          ...state.tabsByWorkspace,
          [workspaceId]: [...tabs, tab],
        },
        activeTabByWorkspace: {
          ...state.activeTabByWorkspace,
          [workspaceId]: id,
        },
      };
    });
    return id;
  },

  closeTab: (workspaceId, tabId) =>
    set((state) => {
      const tabs = state.tabsByWorkspace[workspaceId] ?? [];
      const next = tabs.filter((t) => t.id !== tabId);
      const wasActive = state.activeTabByWorkspace[workspaceId] === tabId;
      const active = wasActive
        ? (next[next.length - 1]?.id ?? null)
        : (state.activeTabByWorkspace[workspaceId] ?? null);
      return {
        tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: next },
        activeTabByWorkspace: {
          ...state.activeTabByWorkspace,
          [workspaceId]: active,
        },
      };
    }),

  setActiveTab: (workspaceId, tabId) =>
    set((state) => ({
      activeTabByWorkspace: {
        ...state.activeTabByWorkspace,
        [workspaceId]: tabId,
      },
    })),

  toggleBigTerminal: () =>
    set((state) => ({ bigTerminal: !state.bigTerminal })),

  setBigTerminal: (big) => set({ bigTerminal: big }),
}));
