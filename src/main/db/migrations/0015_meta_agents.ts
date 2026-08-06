import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

const TASK_AGENT_COLUMNS = [
  ['agent_id', 'TEXT'],
  ['agent_name', 'TEXT'],
  ['agent_revision', 'TEXT'],
  ['agent_snapshot_json', 'TEXT'],
  ['agent_snapshot_digest', 'TEXT'],
  ['meta_run_id', 'TEXT REFERENCES agent_runs(id)'],
] as const;

const META_AGENT_INDEXES = [
  'agent_runs_project_created_idx',
  'agent_runs_status_idx',
  'agent_dispatches_run_created_idx',
  'agent_dispatches_status_idx',
] as const;

const DISPATCH_DEBATE_COLUMNS = [
  ['debate_stage', "TEXT CHECK (debate_stage IN ('partner','critique'))"],
  ['debate_round', 'INTEGER CHECK (debate_round >= 0)'],
] as const;

function hasSchemaObject(
  db: SqliteDb,
  type: 'table' | 'index',
  name: string,
): boolean {
  return (
    db
      .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
      .get(type, name) !== undefined
  );
}

function hasColumn(db: SqliteDb, table: string, column: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column) !== undefined
  );
}

/**
 * Additive/back-compatible: older binaries ignore these tables and nullable task columns.
 * Manual rollback rebuilds scheduled_tasks without the six meta-agent columns, then drops
 * agent_dispatches and agent_runs. That loses only run history and task-agent metadata.
 */
export const migration0015MetaAgents: Migration = {
  version: 15,
  isApplied(db) {
    return (
      hasSchemaObject(db, 'table', 'agent_runs') &&
      hasSchemaObject(db, 'table', 'agent_dispatches') &&
      META_AGENT_INDEXES.every((index) =>
        hasSchemaObject(db, 'index', index),
      ) &&
      TASK_AGENT_COLUMNS.every(([column]) =>
        hasColumn(db, 'scheduled_tasks', column),
      ) &&
      DISPATCH_DEBATE_COLUMNS.every(([column]) =>
        hasColumn(db, 'agent_dispatches', column),
      )
    );
  },
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        source_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        coordinator_workspace_id TEXT REFERENCES workspaces(id),
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        agent_revision TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        goal TEXT NOT NULL,
        allow_push INTEGER NOT NULL DEFAULT 0 CHECK (allow_push IN (0, 1)),
        allow_open_pr INTEGER NOT NULL DEFAULT 0 CHECK (allow_open_pr IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('starting','running','completed','failed','cancelled','interrupted','taken_over')),
        final_summary TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS agent_runs_project_created_idx ON agent_runs(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs(status);

      CREATE TABLE IF NOT EXISTS agent_dispatches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        parent_dispatch_id TEXT REFERENCES agent_dispatches(id),
        role TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('research','plan','implement','test','review','verify','critique')),
        child_agent_slug TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id),
        branch TEXT,
        turn_id TEXT REFERENCES turns(id),
        session_id TEXT,
        harness TEXT NOT NULL CHECK (harness IN ('claude_code','codex','cursor')),
        model TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled','timed_out')),
        summary TEXT,
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        diff_stat TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS agent_dispatches_run_created_idx ON agent_dispatches(run_id, created_at);
      CREATE INDEX IF NOT EXISTS agent_dispatches_status_idx ON agent_dispatches(status);
    `);
    for (const [column, definition] of TASK_AGENT_COLUMNS) {
      if (!hasColumn(db, 'scheduled_tasks', column)) {
        db.exec(
          `ALTER TABLE scheduled_tasks ADD COLUMN ${column} ${definition};`,
        );
      }
    }
    for (const [column, definition] of DISPATCH_DEBATE_COLUMNS) {
      if (!hasColumn(db, 'agent_dispatches', column)) {
        db.exec(
          `ALTER TABLE agent_dispatches ADD COLUMN ${column} ${definition};`,
        );
      }
    }
  },
};
