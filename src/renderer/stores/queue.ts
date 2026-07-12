// Renderer-side queue store (Zustand) — the durable, per-workspace follow-up message
// queue (Phase 9). Unlike the client-only composer store, this is DB-BACKED: every
// mutation round-trips through the `queue:*` IPC commands and then reflects the
// authoritative server state (re-`load` after each write) so the cache never diverges
// from the server's `orderIdx`.
//
// DTO types come from the FROZEN shared contract (@shared/queue); never redeclare them.
// Steer is deliberately NOT here — the capability-aware steer/fallback path lives in the
// chat wiring (it needs sendTurn/interrupt + capabilities); this store is pure queue CRUD.

import { create } from 'zustand';
import type { AgentMode, Attachment } from '@shared/harness';
import type { QueuedMessage } from '@shared/queue';
import { invoke } from '@renderer/ipc';

export interface QueueState {
  /** Cached queued messages per workspace, ordered by `orderIdx` (head first). */
  byWorkspace: Record<string, QueuedMessage[]>;

  /** Fetch + cache a workspace's queue (`queue:list`). Degrades to an empty list on error. */
  load: (workspaceId: string) => Promise<void>;
  /**
   * Enqueue a follow-up message at the tail (`queue:enqueue`), then re-`load` so the cache
   * reflects the server-assigned `orderIdx`. Rejects if the command rejects.
   */
  enqueue: (
    workspaceId: string,
    prompt: string,
    attachments: Attachment[],
    mode?: AgentMode,
  ) => Promise<void>;
  /**
   * Edit a still-unsent queued message (`queue:update`), then re-`load` its workspace
   * (derived from the authoritative response) so the cache reflects the server state.
   */
  update: (
    id: string,
    patch: { prompt?: string; attachments?: Attachment[]; mode?: AgentMode },
  ) => Promise<void>;
  /** Reorder a workspace's queue (`queue:reorder`), then re-`load` to reflect the new order. */
  reorder: (workspaceId: string, orderedIds: string[]) => Promise<void>;
  /** Remove a queued message (`queue:remove`), then re-`load` the workspace. */
  remove: (workspaceId: string, id: string) => Promise<void>;
}

export const useQueueStore = create<QueueState>((set, get) => ({
  byWorkspace: {},

  load: async (workspaceId) => {
    try {
      const messages = await invoke('queue:list', { workspaceId });
      set((state) => ({
        byWorkspace: { ...state.byWorkspace, [workspaceId]: messages },
      }));
    } catch {
      // Degrade gracefully: leave the existing cache untouched so the UI keeps its
      // last-known queue rather than flickering empty on a transient failure.
    }
  },

  enqueue: async (workspaceId, prompt, attachments, mode) => {
    await invoke('queue:enqueue', { workspaceId, prompt, attachments, mode });
    await get().load(workspaceId);
  },

  update: async (id, patch) => {
    const updated = await invoke('queue:update', { id, ...patch });
    await get().load(updated.workspaceId);
  },

  reorder: async (workspaceId, orderedIds) => {
    await invoke('queue:reorder', { workspaceId, orderedIds });
    await get().load(workspaceId);
  },

  remove: async (workspaceId, id) => {
    await invoke('queue:remove', { id });
    await get().load(workspaceId);
  },
}));
