// Migration 0001 — core tables: `projects` and `workspaces`.
//
// DDL is a verbatim transcription of spec §3 (the authoritative column set),
// executed as raw SQL on the underlying better-sqlite3 handle. Raw SQL (rather
// than the Kysely schema builder) is chosen here so the DDL reads 1:1 against the
// spec and the migration stays synchronous — the whole runner applies inside a
// single better-sqlite3 transaction (see ./index.ts).

import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Create the two core tables plus the two required indexes:
 *   - workspaces(project_id)                 — list-by-project lookups
 *   - UNIQUE workspaces(project_id, name)    — city name unique per project (spec §3)
 */
function up(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE projects (
      id             TEXT PRIMARY KEY,      -- UUIDv7
      name           TEXT NOT NULL,
      origin_url     TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      repo_path      TEXT NOT NULL,
      created_at     INTEGER NOT NULL       -- epoch millis
    );

    CREATE TABLE workspaces (
      id            TEXT PRIMARY KEY,       -- UUIDv7
      project_id    TEXT NOT NULL REFERENCES projects(id),
      name          TEXT NOT NULL,          -- city name, unique per project
      branch        TEXT NOT NULL,
      base_branch   TEXT NOT NULL,
      worktree_path TEXT,                   -- NULL when archived
      status        TEXT NOT NULL,          -- idle|working|needs_attention|running|archived
      source_kind   TEXT,                   -- none|branch|pr|github_issue|linear_issue
      source_ref    TEXT,                   -- PR number / issue key / branch name
      harness       TEXT NOT NULL,          -- claude_code|codex|cursor
      port          INTEGER,                -- allocated dev-server port
      created_at    INTEGER NOT NULL,       -- epoch millis
      archived_at   INTEGER                 -- epoch millis, NULL until archived
    );

    CREATE INDEX idx_workspaces_project_id
      ON workspaces (project_id);

    CREATE UNIQUE INDEX uidx_workspaces_project_id_name
      ON workspaces (project_id, name);
  `);
}

/** Migration 0001. Registered in the ordered array in ./index.ts. */
export const migration0001Core: Migration = {
  version: 1,
  up,
};
