// FROZEN CONTRACT (src/shared/** is append-only for later phases — README §5.2).
//
// Phase 12 — per-workspace scheduled agent tasks. PURE types + tiny value constants,
// import-safe from BOTH main and renderer (no Node-only, DOM-only, or electron imports),
// mirroring the frozen-contract discipline of `harness.ts` / `ipc.ts`. A `ScheduledTask`
// is a prompt + optional model + optional permission mode + an OPTIONAL one-shot schedule
// time; the `TaskScheduler` (`src/main/scheduler`) fires timed tasks and drains queued
// ones. The `todos` feature (harness.ts `Todo`) is unrelated and untouched.

import type { AgentMode } from './harness';

/**
 * The lifecycle state of a scheduled task (design doc §4.1 state machine).
 * `missed` is assigned ONLY at boot reconciliation — a late tick while the app is
 * running (e.g. after laptop sleep) still fires the task.
 */
export type TaskState =
  | 'pending' // untimed, waiting for a manual action (Run now / Mark done)
  | 'scheduled' // timed, waiting for its moment
  | 'queued' // fired while the workspace was busy; drains FIFO on turn end
  | 'running' // its turn is active
  | 'done' // completed (turn succeeded, or the user marked it done)
  | 'missed' // its time passed while the app was closed; needs user action
  | 'error'; // its turn failed, or firing failed

/** Where a task came from: a user-authored task, or the usage-limit resume offer. */
export type TaskOrigin = 'user' | 'limit_resume';

/**
 * One scheduled task, scoped to a workspace. Timestamps are epoch millis; `model`,
 * `mode`, `scheduledAt`, `turnId`, and `errorMessage` are nullable per the DB DDL
 * (`null` = "unset / use the default").
 */
export interface ScheduledTask {
  id: string; // UUIDv7
  workspaceId: string;
  prompt: string;
  model: string | null; // null = CLI default
  mode: AgentMode | null; // null = effective settings agent.mode at fire time
  scheduledAt: number | null; // epoch millis; null = untimed
  state: TaskState;
  origin: TaskOrigin;
  turnId: string | null; // set once the task has produced a turn
  errorMessage: string | null;
  createdAt: number; // epoch millis
  updatedAt: number; // epoch millis
}

/**
 * Create request. State is DERIVED by the repo: `scheduledAt` present → `scheduled`,
 * absent → `pending`. `origin` defaults to `'user'`. A past `scheduledAt` is allowed —
 * it simply fires on the next scheduler tick.
 */
export interface CreateTaskReq {
  workspaceId: string;
  prompt: string;
  model?: string;
  mode?: AgentMode;
  scheduledAt?: number;
  origin?: TaskOrigin; // defaults to 'user'
}

/**
 * Edit request. The repo re-derives state from `scheduledAt`: setting it on a
 * pending/missed/error/scheduled task → `scheduled`; clearing it (`null`) → `pending`.
 * Rejected with `AppError('conflict')` while the task is `running`. Omitted fields are
 * left unchanged; `null` explicitly clears a nullable field.
 */
export interface UpdateTaskReq {
  id: string;
  prompt?: string;
  model?: string | null;
  mode?: AgentMode | null;
  scheduledAt?: number | null;
}

/** Preset dropdown values — `claude --model` accepts these family aliases. */
export const CLAUDE_MODEL_PRESETS = ['opus', 'sonnet', 'haiku'] as const;

/**
 * Conservative allowlist for the custom-model escape hatch. Validated at the IPC
 * boundary BEFORE the string can ever reach spawn argv (defense in depth on top of
 * `spawn(shell:false)`): a leading alphanumeric then up to 99 chars from a small safe
 * set (letters, digits, `._:@-`). Rejects whitespace and shell metacharacters.
 */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/;
