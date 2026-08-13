// Projects repository — typed CRUD over the `projects` table, returning the shared
// `Project` DTO (src/shared/models.ts). IDs are UUIDv7 (time-sortable); timestamps
// are epoch-millis from `Date.now()`. The row↔DTO mapping is explicit (`rowToProject`)
// so any schema drift surfaces here rather than silently.

import { v7 as uuidv7 } from 'uuid';
import type { Project } from '@shared/models';
import type { AppDatabase } from '../index';
import type { ProjectsTable } from '../schema';
import { allocateProjectDirectoryName } from '../../paths';

export interface StoredProject extends Project {
  /** Stable app-owned directory name; internal and intentionally absent from IPC types. */
  directoryName: string;
}

/** Fields a caller supplies to create a project; id + createdAt are generated. */
export interface CreateProjectInput {
  name: string;
  originUrl: string;
  defaultBranch: string;
  repoPath: string;
  directoryName?: string;
}

/** Map a DB row to the shared `Project` DTO (snake_case → camelCase). */
function rowToProject(row: ProjectsTable): StoredProject {
  return {
    id: row.id,
    name: row.name,
    originUrl: row.origin_url,
    defaultBranch: row.default_branch,
    repoPath: row.repo_path,
    createdAt: row.created_at,
    directoryName: row.directory_name ?? row.id,
  };
}

/**
 * Repository for the `projects` table. Constructed with the shared `AppDatabase`
 * handle (from `openDb`) and held on `AppContext`. All methods are synchronous
 * under better-sqlite3 but exposed as `Promise` via Kysely's async API.
 */
export class ProjectsRepo {
  constructor(private readonly db: AppDatabase) {}

  /** Insert a new project and return the created DTO. */
  async create(input: CreateProjectInput): Promise<StoredProject> {
    const existingDirectoryNames = input.directoryName
      ? []
      : (await this.list()).map((project) => project.directoryName);
    const row: ProjectsTable = {
      id: uuidv7(),
      name: input.name,
      origin_url: input.originUrl,
      default_branch: input.defaultBranch,
      repo_path: input.repoPath,
      created_at: Date.now(),
      directory_name:
        input.directoryName ??
        allocateProjectDirectoryName(input.name, existingDirectoryNames),
    };

    await this.db.insertInto('projects').values(row).execute();
    return rowToProject(row);
  }

  /** Fetch a project by id, or `null` if none exists. */
  async getById(id: string): Promise<StoredProject | null> {
    const row = await this.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToProject(row) : null;
  }

  /** List all projects, newest first (UUIDv7 is time-sortable, so id DESC works). */
  async list(): Promise<StoredProject[]> {
    const rows = await this.db
      .selectFrom('projects')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(rowToProject);
  }
}
