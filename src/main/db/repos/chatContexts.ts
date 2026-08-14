// Chat contexts repository — typed CRUD over the `chat_contexts` table (migration 0016),
// returning the shared `ChatContextRecord` DTO (src/shared/models.ts). IDs are UUIDv7;
// timestamps are epoch-millis. The row↔DTO mapping is kept explicit (`rowToChatContext`)
// so schema drift surfaces here, mirroring `todos.ts`/`turns.ts`.
//
// A chat context IS a durable chat tab. Ownership of turns lives on the other side of the
// edge (`turns.context_id`), deliberately the same direction as the existing task→turn
// edge (`scheduled_tasks.turn_id`) so the two never collide: scheduler-fired turns carry
// no context, so a task-owned turn keeps `context_id = NULL` forever and task tabs keep
// reconstructing from `task:list` exactly as before.

import { v7 as uuidv7 } from 'uuid';
import { AppError } from '@shared/errors';
import type { ChatContextRecord } from '@shared/models';
import type { AppDatabase } from '../index';
import type { ChatContextsTable } from '../schema';

/** Fields a caller supplies to open a chat tab. `id`/`position`/`createdAt` are assigned here. */
export interface CreateChatContextInput {
  workspaceId: string;
  /** User-visible tab label; defaults to `'Untitled'` when omitted or blank. */
  label?: string;
  /** Provider session the tab resumes from; null/omitted starts fresh. */
  initialSessionId?: string | null;
}

/** The label a bootstrapped or unlabelled tab gets — matches the migration's backfill. */
const DEFAULT_LABEL = 'Untitled';

/** Map a DB row to the shared `ChatContextRecord` DTO (snake_case → camelCase). */
function rowToChatContext(row: ChatContextsTable): ChatContextRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    initialSessionId: row.initial_session_id,
    position: row.position,
    createdAt: row.created_at,
  };
}

/**
 * Repository for the `chat_contexts` table. Constructed with the shared `AppDatabase`
 * handle (per call, like `TodosRepo` — it holds no state of its own).
 */
export class ChatContextsRepo {
  constructor(private readonly db: AppDatabase) {}

  /**
   * The workspace's tabs in `position` order, bootstrapping a single `'Untitled'` tab when
   * it has none. Bootstrapping lives HERE rather than in the renderer so the default tab
   * has exactly one source of truth: two panel mounts racing on the same empty workspace
   * would otherwise each invent their own default and split the transcript again — the
   * very bug this table exists to fix.
   */
  async listOrBootstrap(workspaceId: string): Promise<ChatContextRecord[]> {
    const rows = await this.selectByWorkspace(workspaceId);
    if (rows.length > 0) {
      return rows.map(rowToChatContext);
    }
    return [await this.create({ workspaceId })];
  }

  /**
   * Insert a new tab at the next `position` (`MAX(position) + 1`, or `0` for the first).
   * The id is always a FRESH `uuidv7()` — never a caller-supplied value — so a renderer
   * can't choose a primary key and collide with another workspace's tab.
   */
  async create(input: CreateChatContextInput): Promise<ChatContextRecord> {
    const label = input.label?.trim();
    const row: ChatContextsTable = {
      id: uuidv7(),
      workspace_id: input.workspaceId,
      label: label === undefined || label === '' ? DEFAULT_LABEL : label,
      initial_session_id: input.initialSessionId ?? null,
      position: await this.nextPosition(input.workspaceId),
      created_at: Date.now(),
    };

    await this.db.insertInto('chat_contexts').values(row).execute();
    return rowToChatContext(row);
  }

  /**
   * Relabel a tab. Throws `not_found` when no row matched — a rename racing a close must
   * surface as an error rather than silently doing nothing, so the renderer drops the
   * stale tab instead of showing a label the DB never accepted. The row count comes from
   * the UPDATE itself (rather than `TodosRepo.toggle`'s read-then-write) because nothing
   * here needs the prior row: one statement, no lost-update window.
   */
  async rename(id: string, label: string): Promise<void> {
    const result = await this.db
      .updateTable('chat_contexts')
      .set({ label })
      .where('id', '=', id)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new AppError('not_found', 'chat context not found', { id });
    }
  }

  /**
   * Close a tab: orphan its turns (`context_id` → NULL) then delete the row, in ONE
   * transaction so a crash mid-close can never leave turns pointing at a deleted tab.
   * Correctness deliberately does NOT rest on the column's `REFERENCES` clause: it was
   * added via `ALTER TABLE ADD COLUMN` and carries no `ON DELETE` action, and no other
   * migration here exercises FK actions on such a column.
   *
   * Turn history itself is never deleted — `chat:history` is unaffected, and the renderer
   * simply stops showing NULL-context turns in any manual tab. A no-op when the context
   * is already gone (double-click on close, or two windows closing the same tab).
   */
  async close(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('turns')
        .set({ context_id: null })
        .where('context_id', '=', id)
        .execute();

      await trx.deleteFrom('chat_contexts').where('id', '=', id).execute();
    });
  }

  /** Fetch a tab by id, or `null` if none exists (used to validate an inbound `contextId`). */
  async get(id: string): Promise<ChatContextRecord | null> {
    const row = await this.db
      .selectFrom('chat_contexts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToChatContext(row) : null;
  }

  /** All rows for a workspace in tab order; `created_at` breaks a `position` tie stably. */
  private async selectByWorkspace(
    workspaceId: string,
  ): Promise<ChatContextsTable[]> {
    return this.db
      .selectFrom('chat_contexts')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * Next tab slot for a workspace: `MAX(position) + 1`, or `0` when it has none. SQLite
   * `MAX` over zero rows returns NULL → coerced to `-1` so the first tab is `0`
   * (mirroring `TurnsRepo.nextIdx`). `position` is not UNIQUE, so a racing duplicate
   * yields two tabs sharing a slot rather than an error — harmless for display order.
   */
  private async nextPosition(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom('chat_contexts')
      .select((eb) => eb.fn.max('position').as('maxPosition'))
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return (row?.maxPosition ?? -1) + 1;
  }
}
