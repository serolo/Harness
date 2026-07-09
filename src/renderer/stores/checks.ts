// Renderer-side checks store (Zustand) — the per-workspace merge-readiness roll-up
// (the `ChecksResult` from `checks:get` / `checks:updated`). Single-slot cache per
// workspace, mirroring `stores/diff.ts`'s per-workspace `Record` shape.
//
// DTO types come from the FROZEN shared contract (@shared/checks); never redeclare them.

import { create } from 'zustand';
import type { ChecksResult } from '@shared/checks';

export interface ChecksState {
  /** The latest `ChecksResult` per workspace (from `checks:get` / `checks:updated`). */
  resultByWorkspace: Record<string, ChecksResult>;

  /** Replace a workspace's checks result (from `checks:get` / a refetch). */
  setResult: (workspaceId: string, result: ChecksResult) => void;
  /** Clear a workspace's cached checks (e.g. on workspace archive). */
  reset: (workspaceId: string) => void;
}

export const useChecksStore = create<ChecksState>((set) => ({
  resultByWorkspace: {},

  setResult: (workspaceId, result) =>
    set((state) => ({
      resultByWorkspace: {
        ...state.resultByWorkspace,
        [workspaceId]: result,
      },
    })),

  reset: (workspaceId) =>
    set((state) => {
      const resultByWorkspace = { ...state.resultByWorkspace };
      delete resultByWorkspace[workspaceId];
      return { resultByWorkspace };
    }),
}));
