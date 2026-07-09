// Renderer-side harness store (Zustand) — the SINGLE place the UI reads per-harness
// capabilities, so no feature code branches on a hardcoded harness id (Phase 7, Task 4).
//
// It lazily fetches `harness:list` once and caches the `HarnessInfo[]` keyed by id.
// Capability reads flow through `capabilitiesFor` / the `useHarnessCapabilities` hook, and
// `useSelectedHarnessCapabilities` composes with `useWorkspacesStore` so a feature gets the
// SELECTED workspace's harness capabilities without knowing which harness that is. The
// selected-workspace lookup lives in the hook (not baked into store state) so it stays
// reactive to selection changes.
//
// DTO types come from the FROZEN shared contract (@shared/*); never redeclare them.

import { useEffect } from 'react';
import { create } from 'zustand';
import type { HarnessCapabilities, HarnessId } from '@shared/harness';
import type { HarnessInfo } from '@shared/ipc';
import { invoke } from '@renderer/ipc';
import { useWorkspacesStore } from '@renderer/stores/workspaces';

export interface HarnessState {
  /** Cached `harness:list` entries keyed by harness id (empty until `load` populates it). */
  infoById: Partial<Record<HarnessId, HarnessInfo>>;
  /** True once a `harness:list` fetch has populated the cache. */
  loaded: boolean;
  /** In-flight guard so concurrent callers issue a single fetch. */
  loading: boolean;

  /**
   * Fetch + cache `harness:list` once (idempotent — a no-op once loaded or in flight).
   * Errors degrade gracefully to an empty, unloaded cache (mirroring the composer's
   * optimistic default) and clear the guard so a later caller can retry.
   */
  load: () => Promise<void>;
  /** Capabilities for a harness id, or undefined while unloaded / for an unknown id. */
  capabilitiesFor: (id: HarnessId) => HarnessCapabilities | undefined;
}

export const useHarnessStore = create<HarnessState>((set, get) => ({
  infoById: {},
  loaded: false,
  loading: false,

  load: async () => {
    const { loaded, loading } = get();
    if (loaded || loading) return;
    set({ loading: true });
    try {
      const list = await invoke('harness:list', undefined);
      const infoById: Partial<Record<HarnessId, HarnessInfo>> = {};
      for (const info of list) infoById[info.id] = info;
      set({ infoById, loaded: true, loading: false });
    } catch {
      // Degrade gracefully: leave the cache empty/unloaded so callers keep their
      // optimistic UI, and release the guard so a later mount can retry.
      set({ loading: false });
    }
  },

  capabilitiesFor: (id) => get().infoById[id]?.capabilities,
}));

/**
 * Read a harness's capabilities, ensuring the cache is loaded. Returns undefined while the
 * cache is unloaded (or for an unknown/undefined id) so callers can apply an optimistic
 * default. Re-renders when the cache populates or `id` changes.
 */
export function useHarnessCapabilities(
  id: HarnessId | undefined,
): HarnessCapabilities | undefined {
  const load = useHarnessStore((s) => s.load);
  const info = useHarnessStore((s) => (id ? s.infoById[id] : undefined));
  useEffect(() => {
    void load();
  }, [load]);
  return info?.capabilities;
}

/**
 * Capabilities of the SELECTED workspace's harness (or undefined when nothing is selected
 * or the cache is unloaded). Composes `useWorkspacesStore` so it stays reactive to both
 * selection changes and the workspace list; the harness-id lookup is a primitive selector
 * (stable under Zustand's Object.is equality).
 */
export function useSelectedHarnessCapabilities():
  HarnessCapabilities | undefined {
  const harnessId = useWorkspacesStore((s) => {
    const id = s.selectedWorkspaceId;
    if (id === null) return undefined;
    return s.workspaces.find((w) => w.id === id)?.harness;
  });
  return useHarnessCapabilities(harnessId);
}
