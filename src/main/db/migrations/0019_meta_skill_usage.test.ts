import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './index';

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
});

afterEach(() => db.close());

describe('migration 0019 meta skill usage', () => {
  it('adds durable evidence columns with a backwards-compatible default', () => {
    runMigrations(db);

    const runColumns = db.pragma('table_info(agent_runs)') as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const dispatchColumns = db.pragma('table_info(agent_dispatches)') as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(
      runColumns.find(
        (column) => column.name === 'coordinator_skill_usage_json',
      )?.dflt_value,
    ).toContain('reported');
    expect(
      dispatchColumns.find((column) => column.name === 'skill_usage_json')
        ?.dflt_value,
    ).toContain('reported');
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
