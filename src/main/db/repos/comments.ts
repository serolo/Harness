// Diff-comments repository — typed CRUD over the `diff_comments` table (migration
// 0005), returning the shared `DiffComment` DTO (src/shared/review.ts). IDs are
// UUIDv7; timestamps are epoch-millis. A comment is created in `open` state and
// transitions open→sent→resolved over its lifecycle (spec §5.3). Nullable DDL
// columns (line_start, line_end, side) round-trip as `x | null` for file-level
// (not line-anchored) comments. The row↔DTO mapping is explicit (`rowToComment`)
// so schema drift surfaces here, mirroring `turns.ts`.

import { v7 as uuidv7 } from 'uuid';
import type {
  DiffComment,
  DiffCommentState,
  NewDiffComment,
} from '@shared/review';
import type { AppDatabase } from '../index';
import type { DiffCommentsTable } from '../schema';

/**
 * Map a DB row to the shared `DiffComment` DTO (snake_case → camelCase). Kept
 * explicit so a schema drift surfaces at the mapping rather than silently.
 */
function rowToComment(row: DiffCommentsTable): DiffComment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    filePath: row.file_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    side: row.side,
    body: row.body,
    state: row.state,
    createdAt: row.created_at,
  };
}

/**
 * Repository for the `diff_comments` table. Constructed with the shared
 * `AppDatabase` handle (like `TurnsRepo`). Pure CRUD — the review lifecycle
 * (build-to-agent, reconcile) lives in `DiffService`.
 */
export class DiffCommentsRepo {
  constructor(private readonly db: AppDatabase) {}

  /** Insert a new inline comment (starts in `open` state) and return the DTO. */
  async create(input: NewDiffComment): Promise<DiffComment> {
    const row: DiffCommentsTable = {
      id: uuidv7(),
      workspace_id: input.workspaceId,
      file_path: input.filePath,
      line_start: input.lineStart,
      line_end: input.lineEnd,
      side: input.side,
      body: input.body,
      state: 'open',
      created_at: Date.now(),
    };

    await this.db.insertInto('diff_comments').values(row).execute();
    return rowToComment(row);
  }

  /**
   * List a workspace's comments in creation order (`created_at ASC`), optionally
   * filtered to a single lifecycle `state`.
   */
  async list(
    workspaceId: string,
    state?: DiffCommentState,
  ): Promise<DiffComment[]> {
    let query = this.db
      .selectFrom('diff_comments')
      .selectAll()
      .where('workspace_id', '=', workspaceId);

    if (state !== undefined) {
      query = query.where('state', '=', state);
    }

    const rows = await query.orderBy('created_at', 'asc').execute();
    return rows.map(rowToComment);
  }

  /** Transition a comment's lifecycle state (open→sent when sent, →resolved). */
  async setState(commentId: string, state: DiffCommentState): Promise<void> {
    await this.db
      .updateTable('diff_comments')
      .set({ state })
      .where('id', '=', commentId)
      .execute();
  }

  /** Delete a comment permanently. */
  async remove(commentId: string): Promise<void> {
    await this.db
      .deleteFrom('diff_comments')
      .where('id', '=', commentId)
      .execute();
  }

  /** Fetch a single comment by id, or `null` if none exists (handy for guards). */
  async getById(commentId: string): Promise<DiffComment | null> {
    const row = await this.db
      .selectFrom('diff_comments')
      .selectAll()
      .where('id', '=', commentId)
      .executeTakeFirst();
    return row ? rowToComment(row) : null;
  }
}
