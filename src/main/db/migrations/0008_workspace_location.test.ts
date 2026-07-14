import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from './index';

let tmpDir: string;
let db: BetterSqlite3.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-location-migration-'));
  db = new BetterSqlite3(join(tmpDir, 'test.db'));
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY);');
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function workspaceColumns(): string[] {
  return (db.pragma('table_info(workspaces)') as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

describe('migration 0008 workspace location repair', () => {
  it('adds location when another migration already set user_version to 8', () => {
    db.pragma('user_version = 8');

    runMigrations(db);

    expect(workspaceColumns()).toContain('location');
    expect(db.pragma('user_version', { simple: true })).toBe(9);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('never lowers a newer user_version while repairing the missing column', () => {
    db.pragma('user_version = 11');

    runMigrations(db);

    expect(workspaceColumns()).toContain('location');
    expect(db.pragma('user_version', { simple: true })).toBe(11);
  });
});
