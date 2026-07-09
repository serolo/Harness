// Checkpoints repository — typed CRUD over the `checkpoints` table (migration 0005),
// returning the shared `Checkpoint` DTO (src/shared/review.ts). IDs are UUIDv7;
// timestamps are epoch-millis. The row↔DTO mapping is explicit (`rowToCheckpoint`)
// so schema drift surfaces here, mirroring `turns.ts` / `workspaces.ts`.
//
// Two kinds of row live in this table, distinguished only by `ref_name`:
//   - per-turn checkpoints  `refs/checkpoints/<ws>/<idx>`
//   - auto-backup snapshots `refs/checkpoints/<ws>/backup/<timestamp>`
// `latestForWorkspace` deliberately excludes backup rows so the NEXT snapshot chains
// onto the last real per-turn checkpoint, not a backup created during a revert.

import { v7 as uuidv7 } from 'uuid';
import type { Checkpoint } from '@shared/review';
import type { AppDatabase } from '../index';
import type { CheckpointsTable } from '../schema';

/**
 * Fields a caller supplies to record a checkpoint. `id` is generated; `createdAt`
 * defaults to now. `refName`/`sha` are computed by the caller (CheckpointService).
 */
export interface CreateCheckpointInput {
  workspaceId: string;
  turnId: string;
  refName: string;
  sha: string;
}

/** Substring that marks a row as an auto-backup ref rather than a per-turn checkpoint. */
const BACKUP_REF_MARKER = '/backup/';

/** Map a DB row to the shared `Checkpoint` DTO (snake_case → camelCase). */
function rowToCheckpoint(row: CheckpointsTable): Checkpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    turnId: row.turn_id,
    refName: row.ref_name,
    sha: row.sha,
    createdAt: row.created_at,
  };
}

/**
 * Repository for the `checkpoints` table. Constructed with the shared `AppDatabase`
 * handle and held on `AppContext`.
 */
export class CheckpointsRepo {
  constructor(private readonly db: AppDatabase) {}

  /** Insert a new checkpoint and return the created DTO. */
  async create(input: CreateCheckpointInput): Promise<Checkpoint> {
    const row: CheckpointsTable = {
      id: uuidv7(),
      workspace_id: input.workspaceId,
      turn_id: input.turnId,
      ref_name: input.refName,
      sha: input.sha,
      created_at: Date.now(),
    };

    await this.db.insertInto('checkpoints').values(row).execute();
    return rowToCheckpoint(row);
  }

  /**
   * List all checkpoints for a workspace ordered by `created_at ASC` (monotonic with
   * turn order). Includes backup rows — the service/UI filters by `ref_name` as needed.
   */
  async list(workspaceId: string): Promise<Checkpoint[]> {
    const rows = await this.db
      .selectFrom('checkpoints')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(rowToCheckpoint);
  }

  /**
   * The most recent NON-backup checkpoint for a workspace (highest `created_at` whose
   * `ref_name` is not a `/backup/` ref), or `null`. Used as the parent SHA for the
   * next snapshot so per-turn checkpoints form a chain independent of backups.
   */
  async latestForWorkspace(workspaceId: string): Promise<Checkpoint | null> {
    const row = await this.db
      .selectFrom('checkpoints')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      // Exclude auto-backup refs — the snapshot chain threads real per-turn
      // checkpoints only. SQLite LIKE: `%/backup/%` matches anywhere in the ref.
      .where('ref_name', 'not like', `%${BACKUP_REF_MARKER}%`)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? rowToCheckpoint(row) : null;
  }

  /**
   * Find a workspace's checkpoint by exact ref name (e.g.
   * `refs/checkpoints/<ws>/<idx>`), or `null`. Used to resolve a revert target.
   */
  async findByRef(
    workspaceId: string,
    refName: string,
  ): Promise<Checkpoint | null> {
    const row = await this.db
      .selectFrom('checkpoints')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('ref_name', '=', refName)
      .executeTakeFirst();
    return row ? rowToCheckpoint(row) : null;
  }
}
