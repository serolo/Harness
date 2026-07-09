// Renderer-side composer store (Zustand) — a tiny per-workspace `pendingPrompt`
// seam. The New-Workspace "From issue" flow drops the issue's text here keyed by the
// freshly-created workspace id; the chat <Composer> consumes it exactly ONCE on mount
// (`takePendingPrompt` returns AND clears) so a seeded prompt never re-fires on a
// re-render or when the user switches away and back after it was consumed.
//
// Deliberately NOT persisted and NOT sent to main — it is a transient, client-only
// hand-off between two renderer features. Mirrors the per-workspace `Record` idiom of
// `stores/chat.ts` / `stores/diff.ts`.

import { create } from 'zustand';

export interface ComposerState {
  /** One-time prompt to seed the composer with, keyed by workspace id. */
  pendingPromptByWorkspace: Record<string, string>;

  /** Stash a one-time prompt for a workspace (overwrites any un-consumed value). */
  setPendingPrompt: (workspaceId: string, text: string) => void;
  /**
   * Return AND clear the pending prompt for a workspace — consumed once. Returns
   * `undefined` when nothing is pending (so a second read is a no-op).
   */
  takePendingPrompt: (workspaceId: string) => string | undefined;
}

export const useComposerStore = create<ComposerState>((set, get) => ({
  pendingPromptByWorkspace: {},

  setPendingPrompt: (workspaceId, text) =>
    set((state) => ({
      pendingPromptByWorkspace: {
        ...state.pendingPromptByWorkspace,
        [workspaceId]: text,
      },
    })),

  takePendingPrompt: (workspaceId) => {
    const text = get().pendingPromptByWorkspace[workspaceId];
    if (text === undefined) return undefined;
    // Clear it as part of the read so it is consumed exactly once.
    set((state) => {
      const next = { ...state.pendingPromptByWorkspace };
      delete next[workspaceId];
      return { pendingPromptByWorkspace: next };
    });
    return text;
  },
}));
