// Todos repository — typed CRUD over the `todos` table (migration 0005), returning
// the shared `Todo` DTO (src/shared/harness.ts). IDs are UUIDv7; timestamps are
// epoch-millis. `done` is stored as INTEGER 0/1 (SQLite has no boolean type) and
// mapped to/from the DTO's `boolean` explicitly in `rowToTodo`, mirroring
// `turns.ts`'s row↔DTO convention.
//
// Two sources feed this table: user-authored todos (`source: 'user'`, one row per
// `todo:create` call) and agent-authored todos (`source: 'agent'`, REPLACED wholesale
// on every `todo_update` event — see `replaceAgentTodos`). `Todo` (the DTO) carries
// no `workspaceId`/timestamps, so `rowToTodo` maps only `id, body, done, source`.

import { v7 as uuidv7 } from 'uuid';
import { AppError } from '@shared/errors';
import type { Todo } from '@shared/harness';
import type { TodoInput } from '@shared/review';
import type { AppDatabase } from '../index';
import type { TodosTable } from '../schema';

/**
 * Map a DB row to the shared `Todo` DTO. `done` widens INTEGER 0/1 → boolean; the
 * DTO has no `workspaceId`/`createdAt`/`updatedAt`, so those columns are dropped here.
 */
function rowToTodo(row: TodosTable): Todo {
  return {
    id: row.id,
    body: row.body,
    done: row.done !== 0,
    source: row.source,
  };
}

/**
 * Repository for the `todos` table. Constructed with the shared `AppDatabase` handle.
 */
export class TodosRepo {
  constructor(private readonly db: AppDatabase) {}

  /**
   * List all todos (user + agent) for a workspace, ordered by `created_at ASC` so
   * agent todos preserve their first-seen order and user todos append after.
   */
  async list(workspaceId: string): Promise<Todo[]> {
    const rows = await this.db
      .selectFrom('todos')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(rowToTodo);
  }

  /** Insert a new user-authored todo (`source: 'user'`, `done: false`). */
  async create(input: TodoInput): Promise<Todo> {
    const now = Date.now();
    const row: TodosTable = {
      id: uuidv7(),
      workspace_id: input.workspaceId,
      body: input.body,
      done: 0,
      source: 'user',
      created_at: now,
      updated_at: now,
    };

    await this.db.insertInto('todos').values(row).execute();
    return rowToTodo(row);
  }

  /**
   * Flip a todo's `done` flag and bump `updated_at`. Throws `not_found` if no row
   * exists for `id` — the read-then-write is not atomic under concurrent toggles,
   * but todos are single-user/local so a lost update is not a real-world risk here.
   */
  async toggle(id: string): Promise<Todo> {
    const existing = await this.db
      .selectFrom('todos')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) {
      throw new AppError('not_found', 'todo not found', { id });
    }

    const done = existing.done === 0 ? 1 : 0;
    const updated_at = Date.now();
    await this.db
      .updateTable('todos')
      .set({ done, updated_at })
      .where('id', '=', id)
      .execute();

    return rowToTodo({ ...existing, done, updated_at });
  }

  /**
   * Replace-semantics upsert for the agent's todo set: the `todo_update` event
   * carries the FULL current set of agent todos each time (not a delta), so the
   * simplest correct write is DELETE all existing `source: 'agent'` rows for the
   * workspace, then INSERT the provided set fresh. User todos (`source: 'user'`)
   * are untouched — the DELETE is scoped to `source = 'agent'`. Runs in a single
   * Kysely transaction so a crash mid-replace can't leave the workspace with a
   * half-deleted, half-inserted agent todo set.
   *
   * Each row gets a FRESH `uuidv7()` primary key — the agent-supplied `todo.id` is
   * NOT reused as the PK. Harness todo ids are frequently session-local (small ints /
   * content hashes), so reusing them as a global PRIMARY KEY would collide across
   * workspaces (the DELETE only clears THIS workspace) and throw a UNIQUE violation,
   * silently dropping the agent's todos for the second workspace.
   */
  async replaceAgentTodos(workspaceId: string, todos: Todo[]): Promise<void> {
    const now = Date.now();
    const rows: TodosTable[] = todos.map((todo) => ({
      id: uuidv7(),
      workspace_id: workspaceId,
      body: todo.body,
      done: todo.done ? 1 : 0,
      source: 'agent',
      created_at: now,
      updated_at: now,
    }));

    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('todos')
        .where('workspace_id', '=', workspaceId)
        .where('source', '=', 'agent')
        .execute();

      if (rows.length > 0) {
        await trx.insertInto('todos').values(rows).execute();
      }
    });
  }
}
