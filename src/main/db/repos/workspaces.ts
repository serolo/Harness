// Workspaces repository — typed CRUD over the `workspaces` table, returning the
// shared `Workspace` DTO (src/shared/models.ts). IDs are UUIDv7; timestamps are
// epoch-millis. Nullable DDL columns (worktreePath, sourceKind, sourceRef, port,
// archivedAt) round-trip as `x | null`. The row↔DTO mapping is explicit
// (`rowToWorkspace`) so schema drift surfaces here.

import { v7 as uuidv7 } from 'uuid';
import type {
  Workspace,
  WorkspaceSourceKind,
  WorkspaceStatus,
} from '@shared/models';
import type { HarnessId } from '@shared/harness';
import type { AppDatabase } from '../index';
import type { WorkspacesTable } from '../schema';

/**
 * Fields a caller supplies to create a workspace. `id`, `createdAt` are generated;
 * `archivedAt` starts null. Nullable inputs default to null when omitted.
 */
export interface CreateWorkspaceInput {
  projectId: string;
  name: string;
  branch: string;
  baseBranch: string;
  harness: HarnessId;
  status: WorkspaceStatus;
  worktreePath?: string | null;
  sourceKind?: WorkspaceSourceKind | null;
  sourceRef?: string | null;
  port?: number | null;
  prNumber?: number | null;
}

/**
 * Partial mutable fields for `update`. `id`, `projectId`, `createdAt` are immutable;
 * status has its own focused `setStatus` but is also updatable here.
 */
export interface UpdateWorkspaceInput {
  name?: string;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string | null;
  status?: WorkspaceStatus;
  sourceKind?: WorkspaceSourceKind | null;
  sourceRef?: string | null;
  harness?: HarnessId;
  port?: number | null;
  archivedAt?: number | null;
  prNumber?: number | null;
}

/** Map a DB row to the shared `Workspace` DTO (snake_case → camelCase). */
function rowToWorkspace(row: WorkspacesTable): Workspace {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    branch: row.branch,
    baseBranch: row.base_branch,
    worktreePath: row.worktree_path,
    status: row.status,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    harness: row.harness,
    port: row.port,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    prNumber: row.pr_number,
  };
}

/**
 * Repository for the `workspaces` table. Constructed with the shared `AppDatabase`
 * handle and held on `AppContext`.
 */
export class WorkspacesRepo {
  constructor(private readonly db: AppDatabase) {}

  /** Insert a new workspace and return the created DTO. */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const row: WorkspacesTable = {
      id: uuidv7(),
      project_id: input.projectId,
      name: input.name,
      branch: input.branch,
      base_branch: input.baseBranch,
      worktree_path: input.worktreePath ?? null,
      status: input.status,
      source_kind: input.sourceKind ?? null,
      source_ref: input.sourceRef ?? null,
      harness: input.harness,
      port: input.port ?? null,
      pr_number: input.prNumber ?? null, // migration 0007 — set when a PR is opened (or seeded from a PR source)
      created_at: Date.now(),
      archived_at: null,
    };

    await this.db.insertInto('workspaces').values(row).execute();
    return rowToWorkspace(row);
  }

  /** Fetch a workspace by id, or `null` if none exists. */
  async getById(id: string): Promise<Workspace | null> {
    const row = await this.db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToWorkspace(row) : null;
  }

  /** List all workspaces for a project, newest first. */
  async listByProject(projectId: string): Promise<Workspace[]> {
    const rows = await this.db
      .selectFrom('workspaces')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(rowToWorkspace);
  }

  /**
   * Transition a workspace's status (spec §5.1 status machine). Returns the updated
   * DTO, or `null` if no row matched. Status transitions are otherwise owned by
   * `WorkspaceManager.setStatus()` (README §6.4); this is the persistence primitive.
   */
  async setStatus(
    id: string,
    status: WorkspaceStatus,
  ): Promise<Workspace | null> {
    await this.db
      .updateTable('workspaces')
      .set({ status })
      .where('id', '=', id)
      .execute();
    return this.getById(id);
  }

  /**
   * Apply a partial update to a workspace. Only the provided fields are written
   * (camelCase → snake_case). Returns the updated DTO, or `null` if no row matched.
   */
  async update(
    id: string,
    patch: UpdateWorkspaceInput,
  ): Promise<Workspace | null> {
    // Build the column set explicitly so we only touch provided fields and keep the
    // camelCase→snake_case mapping in one place.
    const set: Partial<WorkspacesTable> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.branch !== undefined) set.branch = patch.branch;
    if (patch.baseBranch !== undefined) set.base_branch = patch.baseBranch;
    if (patch.worktreePath !== undefined)
      set.worktree_path = patch.worktreePath;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.sourceKind !== undefined) set.source_kind = patch.sourceKind;
    if (patch.sourceRef !== undefined) set.source_ref = patch.sourceRef;
    if (patch.harness !== undefined) set.harness = patch.harness;
    if (patch.port !== undefined) set.port = patch.port;
    if (patch.archivedAt !== undefined) set.archived_at = patch.archivedAt;
    if (patch.prNumber !== undefined) set.pr_number = patch.prNumber;

    // Nothing to change → return the current row unmodified.
    if (Object.keys(set).length === 0) {
      return this.getById(id);
    }

    await this.db
      .updateTable('workspaces')
      .set(set)
      .where('id', '=', id)
      .execute();
    return this.getById(id);
  }
}
