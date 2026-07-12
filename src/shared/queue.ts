// Shared queue types (Phase 9). A durable, per-workspace follow-up message queue.
// APPEND-ONLY shared contract: import-safe from main + renderer (no Node/DOM/electron).
import type { AgentMode, Attachment } from './harness';

/** One queued follow-up message for a workspace. `orderIdx` is 0-based, contiguous per workspace. */
export interface QueuedMessage {
  id: string; // UUIDv7
  workspaceId: string;
  prompt: string;
  attachments: Attachment[];
  mode?: AgentMode;
  orderIdx: number; // 0-based, contiguous per workspace
  createdAt: number; // epoch millis
}
