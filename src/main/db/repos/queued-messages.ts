// Queued-messages repository — typed CRUD over the `queued_messages` table (migration
// 0008), returning the shared `QueuedMessage` DTO (src/shared/queue.ts). IDs are UUIDv7;
// timestamps are epoch-millis. `attachments` is stored as a JSON TEXT column and mapped
// to/from the DTO's `Attachment[]` explicitly in `rowToQueuedMessage`, mirroring
// `todos.ts`'s row↔DTO convention. `mode` is NULL in the DB (→ `undefined` in the DTO)
// when unset, so a send picks up the settings default.
//
// The queue is a durable, per-workspace, ordered list of unsent follow-up messages
// (Phase 9 — mid-turn steer & message queue). `order_idx` is 0-based and contiguous per
// workspace; `enqueue` appends at the tail and `reorder` rewrites the whole ordering in a
// single transaction so a concurrent dequeue-head can never send the wrong item.

import { v7 as uuidv7 } from 'uuid';
import { AppError } from '@shared/errors';
import type { Attachment } from '@shared/harness';
import type { QueuedMessage } from '@shared/queue';
import type { AppDatabase } from '../index';
import type { QueuedMessagesTable } from '../schema';

/**
 * Map a DB row to the shared `QueuedMessage` DTO. `attachments_json` is parsed back into
 * the `Attachment[]`; a NULL `mode` maps to `undefined` (the DTO's optional field).
 */
function rowToQueuedMessage(row: QueuedMessagesTable): QueuedMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    prompt: row.prompt,
    attachments: JSON.parse(row.attachments_json) as Attachment[],
    mode: row.mode ?? undefined,
    orderIdx: row.order_idx,
    createdAt: row.created_at,
  };
}

/** The mutable subset of a queued message a `queue:update` may patch. */
export type QueuedMessagePatch = Partial<
  Pick<QueuedMessage, 'prompt' | 'attachments' | 'mode'>
>;

/**
 * Repository for the `queued_messages` table. Constructed with the shared `AppDatabase`
 * handle (mirrors `TodosRepo`).
 */
export class QueuedMessagesRepo {
  constructor(private readonly db: AppDatabase) {}

  /** List a workspace's queued messages ordered by `order_idx ASC` (head first). */
  async list(workspaceId: string): Promise<QueuedMessage[]> {
    const rows = await this.db
      .selectFrom('queued_messages')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('order_idx', 'asc')
      .execute();
    return rows.map(rowToQueuedMessage);
  }

  /**
   * Append a follow-up message at the tail: `order_idx = MAX(order_idx) + 1`, or `0` when
   * the workspace's queue is empty (SQLite `MAX` over zero rows returns NULL → coerced to
   * `-1`). Mints a fresh UUIDv7 and stamps `created_at`.
   */
  async enqueue(
    msg: Omit<QueuedMessage, 'id' | 'orderIdx' | 'createdAt'>,
  ): Promise<QueuedMessage> {
    const agg = await this.db
      .selectFrom('queued_messages')
      .select((eb) => eb.fn.max('order_idx').as('maxIdx'))
      .where('workspace_id', '=', msg.workspaceId)
      .executeTakeFirst();
    // maxIdx is NULL (→ undefined here) when the workspace queue is empty.
    const orderIdx = (agg?.maxIdx ?? -1) + 1;

    const row: QueuedMessagesTable = {
      id: uuidv7(),
      workspace_id: msg.workspaceId,
      prompt: msg.prompt,
      attachments_json: JSON.stringify(msg.attachments),
      mode: msg.mode ?? null,
      order_idx: orderIdx,
      created_at: Date.now(),
    };

    await this.db.insertInto('queued_messages').values(row).execute();
    return rowToQueuedMessage(row);
  }

  /**
   * Patch a still-unsent queued message. Only provided fields are written (`attachments`
   * is re-serialized; a present `mode` key maps `undefined` → NULL). Throws `not_found`
   * if no row exists for `id`.
   */
  async update(id: string, patch: QueuedMessagePatch): Promise<QueuedMessage> {
    const existing = await this.db
      .selectFrom('queued_messages')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) {
      throw new AppError('not_found', 'queued message not found', { id });
    }

    // Build the column set explicitly so only provided fields are touched and the
    // camelCase→snake_case / serialization mapping lives in one place.
    const set: Partial<QueuedMessagesTable> = {};
    if (patch.prompt !== undefined) set.prompt = patch.prompt;
    if (patch.attachments !== undefined) {
      set.attachments_json = JSON.stringify(patch.attachments);
    }
    if ('mode' in patch) set.mode = patch.mode ?? null;

    if (Object.keys(set).length > 0) {
      await this.db
        .updateTable('queued_messages')
        .set(set)
        .where('id', '=', id)
        .execute();
    }

    return rowToQueuedMessage({ ...existing, ...set });
  }

  /**
   * Rewrite a workspace's queue ordering. `orderedIds` MUST be an exact permutation of
   * the workspace's current queue ids (same length AND same set) — else `invalid_input`.
   * Runs in a SINGLE transaction so a concurrent dequeue-head can't observe a partially
   * rewritten ordering and send the wrong item.
   */
  async reorder(workspaceId: string, orderedIds: string[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('queued_messages')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute();
      const currentIds = rows.map((r) => r.id);

      // Assert `orderedIds` is an exact permutation: same length AND same set.
      const currentSet = new Set(currentIds);
      const orderedSet = new Set(orderedIds);
      const isPermutation =
        orderedIds.length === currentIds.length &&
        orderedSet.size === currentSet.size &&
        [...orderedSet].every((id) => currentSet.has(id));
      if (!isPermutation) {
        throw new AppError(
          'invalid_input',
          'orderedIds must be a permutation of the queue',
          { workspaceId },
        );
      }

      // Rewrite order_idx to 0..n-1 in orderedIds order.
      for (let i = 0; i < orderedIds.length; i++) {
        await trx
          .updateTable('queued_messages')
          .set({ order_idx: i })
          .where('id', '=', orderedIds[i])
          .where('workspace_id', '=', workspaceId)
          .execute();
      }
    });
  }

  /** Delete a queued message by id. Absent id is a no-op (idempotent remove). */
  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('queued_messages').where('id', '=', id).execute();
  }
}
