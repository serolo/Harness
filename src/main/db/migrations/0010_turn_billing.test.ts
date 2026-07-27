import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { openDb, type AppDatabase } from '../index';

let tmpDir: string;
let dbFile: string;
let db: AppDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-billing-'));
  dbFile = join(tmpDir, 'test.db');
  db = openDb(dbFile);
});

afterEach(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 0010 turn billing', () => {
  it('adds nullable billing columns and the month index', () => {
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      const columns = raw.pragma('table_info(turns)') as Array<{
        name: string;
        notnull: number;
      }>;
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'harness', notnull: 0 }),
          expect.objectContaining({ name: 'model', notnull: 0 }),
          expect.objectContaining({ name: 'cached_input_tokens', notnull: 0 }),
          expect.objectContaining({
            name: 'cache_write_input_tokens',
            notnull: 0,
          }),
          expect.objectContaining({ name: 'cost_micros', notnull: 0 }),
          expect.objectContaining({ name: 'pricing_key', notnull: 0 }),
        ]),
      );
      const indexes = raw.pragma('index_list(turns)') as Array<{
        name: string;
      }>;
      expect(indexes.map((row) => row.name)).toContain(
        'idx_turns_billing_month',
      );
    } finally {
      raw.close();
    }
  });
});
