import type { Database as SqliteDb } from 'better-sqlite3';
import type { Migration } from './index';

const DEFAULT_REPORT = `'${JSON.stringify({ reported: false, skills: [] })}'`;

function columns(db: SqliteDb, table: string): Set<string> {
  return new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
}

function isApplied(db: SqliteDb): boolean {
  const runs = columns(db, 'agent_runs');
  const dispatches = columns(db, 'agent_dispatches');
  // Partial-schema migration fixtures intentionally omit feature tables.
  if (runs.size === 0 && dispatches.size === 0) return true;
  return (
    runs.has('coordinator_skill_usage_json') &&
    dispatches.has('skill_usage_json')
  );
}

function up(db: SqliteDb): void {
  // Rollback/back-compat: both columns are additive and old binaries ignore them.
  // A manual rollback can rebuild the two tables without these columns, losing only
  // usage evidence—not run, dispatch, transcript, or immutable snapshot data.
  const runs = columns(db, 'agent_runs');
  const dispatches = columns(db, 'agent_dispatches');
  if (!runs.has('coordinator_skill_usage_json')) {
    db.exec(
      `ALTER TABLE agent_runs ADD COLUMN coordinator_skill_usage_json TEXT NOT NULL DEFAULT ${DEFAULT_REPORT}`,
    );
  }
  if (!dispatches.has('skill_usage_json')) {
    db.exec(
      `ALTER TABLE agent_dispatches ADD COLUMN skill_usage_json TEXT NOT NULL DEFAULT ${DEFAULT_REPORT}`,
    );
  }
}

export const migration0019MetaSkillUsage: Migration = {
  version: 19,
  isApplied,
  up,
};
