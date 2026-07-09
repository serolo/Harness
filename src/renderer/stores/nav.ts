// Renderer navigation store (Phase 6, Track E2).
//
// The deep-link event (`nav:deepLink`, broadcast from main after `resolveDeepLink`)
// lands here as a pending target; AppLayout reads it, selects the workspace + pane,
// and clears it. Kept as its own tiny store (not folded into the workspaces store) so
// the deep-link seam is independently testable and the "requested pane" is transient
// UI intent rather than persisted workspace state.

import { create } from 'zustand';
import type { DeepLinkTarget } from '@shared/ipc';

export interface NavState {
  /** The most recent deep-link target awaiting handling, or null once consumed. */
  target: DeepLinkTarget | null;
  /** Record a new navigation intent (latest wins). */
  navigate: (target: DeepLinkTarget) => void;
  /** Clear the pending target after AppLayout has acted on it. */
  consume: () => void;
}

export const useNavStore = create<NavState>((set) => ({
  target: null,
  navigate: (target) => set({ target }),
  consume: () => set({ target: null }),
}));
