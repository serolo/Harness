// Scheduled tasks repository — typed CRUD over the `scheduled_tasks` table (migration
// 0008), returning the shared `ScheduledTask` DTO (src/shared/tasks.ts). Mirrors the
// `todos.ts` conventions: UUIDv7 ids, epoch-millis timestamps, an EXPLICIT `rowToTask`
// row↔DTO mapping (so schema drift surfaces at the mapping), and `AppError('not_found')`
// on a missing row. `update`/`delete` refuse a `running` task with `AppError('conflict')`
// — the caller must interrupt the turn first (design doc §4.1).
//
// State derivation lives HERE (not in the IPC layer): `create` picks `scheduled` vs
// `pending` from whether a time was given; `update` re-derives when `scheduledAt` changes;
// `setState` is the scheduler's explicit lifecycle writer. `reconcileOnBoot` runs the
// boot-time state fixups in a SINGLE transaction (design doc §5.2) and returns the
// affected workspace ids so the caller can emit one `task:changed` per workspace.

import { v7 as uuidv7 } from 'uuid';
import { AppError } from '@shared/errors';
import type {
  CreateTaskReq,
  ScheduledTask,
  TaskState,
  UpdateTaskReq,
} from '@shared/tasks';
import type { AppDatabase } from '../index';
import type { ScheduledTasksTable } from '../schema';

/** States from which `update` is allowed (design doc §5.2 editable source states). */
const EDITABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'pending',
  'scheduled',
  'missed',
  'error',
]);

/** Boot-reconcile message for a task whose turn did not finish cleanly before quit. */
const APP_CLOSED_MESSAGE = 'app closed while the task was running';
/** Boot-reconcile message when the task's turn itself ended in an error. */
const TURN_ERROR_MESSAGE = "the task's turn ended with an error";

/** Map a DB row to the shared `ScheduledTask` DTO (explicit, per the repo convention). */
function rowToTask(row: ScheduledTasksTable): ScheduledTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    prompt: row.prompt,
    model: row.model,
    mode: row.mode,
    scheduledAt: row.scheduled_at,
    state: row.state,
    origin: row.origin,
    turnId: row.turn_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Repository for the `scheduled_tasks` table. Constructed with the shared handle. */
export class ScheduledTasksRepo {
  constructor(private readonly db: AppDatabase) {}

  /** All tasks for a workspace, `created_at ASC` (the UI does any display grouping). */
  async list(workspaceId: string): Promise<ScheduledTask[]> {
    const rows = await this.db
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(rowToTask);
  }

  /** Fetch one task by id. Throws `not_found` if no row exists. */
  async get(id: string): Promise<ScheduledTask> {
    const row = await this.requireRow(id);
    return rowToTask(row);
  }

  /**
   * Insert a task. State is derived: a `scheduledAt` → `scheduled`, none → `pending`.
   * `origin` defaults to `'user'`. `model`/`mode`/`scheduledAt` default to NULL.
   */
  async create(input: CreateTaskReq): Promise<ScheduledTask> {
    const now = Date.now();
    const scheduledAt = input.scheduledAt ?? null;
    const row: ScheduledTasksTable = {
      id: uuidv7(),
      workspace_id: input.workspaceId,
      prompt: input.prompt,
      model: input.model ?? null,
      mode: input.mode ?? null,
      scheduled_at: scheduledAt,
      state: scheduledAt !== null ? 'scheduled' : 'pending',
      origin: input.origin ?? 'user',
      turn_id: null,
      error_message: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insertInto('scheduled_tasks').values(row).execute();
    return rowToTask(row);
  }

  /**
   * Edit a task's prompt/model/mode/schedule. Rejected with `conflict` while `running`.
   * When `scheduledAt` is part of the patch the state is re-derived: a number → the row
   * becomes `scheduled`; `null` → `pending`. Omitted fields are left unchanged.
   */
  async update(
    id: string,
    patch: Omit<UpdateTaskReq, 'id'>,
  ): Promise<ScheduledTask> {
    const existing = await this.requireRow(id);
    // Only the sanctioned source states are editable (design doc §5.2). Rejecting
    // `queued`/`done`/`running` prevents an edit from pulling a task out of the FIFO
    // drain (queued → scheduled) or resurrecting a finished task (done → scheduled).
    if (!EDITABLE_STATES.has(existing.state)) {
      throw new AppError('conflict', `cannot edit a ${existing.state} task`, {
        id,
      });
    }

    const set: Partial<ScheduledTasksTable> = { updated_at: Date.now() };
    if (patch.prompt !== undefined) set.prompt = patch.prompt;
    if (patch.model !== undefined) set.model = patch.model;
    if (patch.mode !== undefined) set.mode = patch.mode;
    // Re-derive state ONLY when the schedule itself changes (design doc §5.2):
    //   a time → 'scheduled'; cleared (null) → 'pending'.
    if (patch.scheduledAt !== undefined) {
      set.scheduled_at = patch.scheduledAt;
      set.state = patch.scheduledAt !== null ? 'scheduled' : 'pending';
    }

    await this.db
      .updateTable('scheduled_tasks')
      .set(set)
      .where('id', '=', id)
      .execute();
    return rowToTask({ ...existing, ...set });
  }

  /**
   * The scheduler's explicit lifecycle writer: set `state`, optionally recording a
   * `turnId` and/or an `errorMessage` (passing `errorMessage: null` clears a stale one).
   * Does NOT gate on the current state — the scheduler owns the transitions.
   */
  async setState(
    id: string,
    state: TaskState,
    extra: { turnId?: string; errorMessage?: string | null } = {},
  ): Promise<ScheduledTask> {
    const existing = await this.requireRow(id);
    const set: Partial<ScheduledTasksTable> = {
      state,
      updated_at: Date.now(),
    };
    if (extra.turnId !== undefined) set.turn_id = extra.turnId;
    if (extra.errorMessage !== undefined)
      set.error_message = extra.errorMessage;

    await this.db
      .updateTable('scheduled_tasks')
      .set(set)
      .where('id', '=', id)
      .execute();
    return rowToTask({ ...existing, ...set });
  }

  /** Delete a task. Rejected with `conflict` while `running`. */
  async delete(id: string): Promise<void> {
    const existing = await this.requireRow(id);
    if (existing.state === 'running') {
      throw new AppError('conflict', 'cannot delete a running task', { id });
    }
    await this.db.deleteFrom('scheduled_tasks').where('id', '=', id).execute();
  }

  /** Due tasks: `state='scheduled' AND scheduled_at <= now`, `scheduled_at ASC`. */
  async listDue(now: number): Promise<ScheduledTask[]> {
    const rows = await this.db
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('state', '=', 'scheduled')
      .where('scheduled_at', '<=', now)
      .orderBy('scheduled_at', 'asc')
      .execute();
    return rows.map(rowToTask);
  }

  /** The oldest `queued` task for a workspace (FIFO by `created_at`), or undefined. */
  async nextQueued(workspaceId: string): Promise<ScheduledTask | undefined> {
    const row = await this.db
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('state', '=', 'queued')
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst();
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Boot-time reconciliation (design doc §4.1), in a SINGLE transaction:
   *   - `scheduled` whose time has passed (`scheduled_at <= now`) → `missed`;
   *   - `queued` → `missed`;
   *   - stale `running` → resolved from its joined turn: turn `completed` → `done`;
   *     turn `error` → `error`; turn `interrupted`/still-`streaming`/no turn → `error`
   *     with an "app closed while the task was running" message.
   * Returns the affected workspace ids so the caller can emit `task:changed` per workspace.
   */
  async reconcileOnBoot(now: number): Promise<string[]> {
    return this.db.transaction().execute(async (trx) => {
      const affected = new Set<string>();
      const updatedAt = Date.now();

      // scheduled (overdue) + queued → missed.
      const overdue = await trx
        .selectFrom('scheduled_tasks')
        .select(['id', 'workspace_id'])
        .where('state', '=', 'scheduled')
        .where('scheduled_at', '<=', now)
        .execute();
      const queued = await trx
        .selectFrom('scheduled_tasks')
        .select(['id', 'workspace_id'])
        .where('state', '=', 'queued')
        .execute();
      const toMissed = [...overdue, ...queued];
      if (toMissed.length > 0) {
        await trx
          .updateTable('scheduled_tasks')
          .set({ state: 'missed', updated_at: updatedAt })
          .where(
            'id',
            'in',
            toMissed.map((r) => r.id),
          )
          .execute();
        for (const r of toMissed) affected.add(r.workspace_id);
      }

      // Stale `running` rows → reconcile from the joined turn's status.
      const running = await trx
        .selectFrom('scheduled_tasks')
        .selectAll()
        .where('state', '=', 'running')
        .execute();
      for (const task of running) {
        let target: TaskState = 'error';
        let errorMessage: string | null = APP_CLOSED_MESSAGE;
        if (task.turn_id) {
          const turn = await trx
            .selectFrom('turns')
            .select(['status'])
            .where('id', '=', task.turn_id)
            .executeTakeFirst();
          if (turn?.status === 'completed') {
            target = 'done';
            errorMessage = null;
          } else if (turn?.status === 'error') {
            target = 'error';
            errorMessage = TURN_ERROR_MESSAGE;
          }
          // interrupted / still-streaming / no turn row → error + APP_CLOSED_MESSAGE.
        }
        await trx
          .updateTable('scheduled_tasks')
          .set({
            state: target,
            error_message: errorMessage,
            updated_at: updatedAt,
          })
          .where('id', '=', task.id)
          .execute();
        affected.add(task.workspace_id);
      }

      return [...affected];
    });
  }

  /** Fetch a row or throw `not_found` (shared by get/update/setState/delete). */
  private async requireRow(id: string): Promise<ScheduledTasksTable> {
    const row = await this.db
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) {
      throw new AppError('not_found', 'scheduled task not found', { id });
    }
    return row;
  }
}
