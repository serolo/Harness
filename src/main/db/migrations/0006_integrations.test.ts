// Migration 0006 + 0007 round-trip (Phase 5 — integrations + workspaces.pr_number).
//
// Opens a real better-sqlite3 file in os.tmpdir() (path injected into `openDb`, so no
// Electron `app.getPath` is touched) — proving migrations 0006/0007 apply on a fresh
// DB: the `integrations` table + `idx_integrations_kind` index exist, `workspaces`
// gains a nullable `pr_number` column, and re-running `runMigrations` is a clean no-op
// (mirrors 0005_diff_review.test.ts / index.test.ts). Also exercises `IntegrationsRepo`
// end to end and asserts the DTO carries only `tokenRef` — never a plaintext token
// (spec §7).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { openDb, type AppDatabase } from '../index';
import { runMigrations } from './index';
import { IntegrationsRepo } from '../repos/integrations';

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-integrations-'));
  dbFile = join(tmpDir, 'test.db');
  db = undefined;
});

afterEach(async () => {
  if (db) {
    await db.destroy();
    db = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrations 0006/0007 (fresh temp DB)', () => {
  it('applies all migrations: user_version becomes 9 (latest)', () => {
    db = openDb(dbFile);

    // Inspect the raw file with a fresh handle (asserts persisted state, not the
    // Kysely cache) — mirrors 0005_diff_review.test.ts.
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(9);
    } finally {
      raw.close();
    }
  });

  it('creates the integrations table + idx_integrations_kind index', () => {
    db = openDb(dbFile);
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      const tables = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toContain('integrations');

      const indexes = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(indexes).toContain('idx_integrations_kind');
    } finally {
      raw.close();
    }
  });

  it('adds workspaces.pr_number as a nullable INTEGER column (migration 0007)', () => {
    db = openDb(dbFile);
    const raw = new BetterSqlite3(dbFile, { readonly: true });
    try {
      const columns = raw
        .prepare('PRAGMA table_info(workspaces)')
        .all()
        .map((r) => r as { name: string; type: string; notnull: number });
      const prNumber = columns.find((c) => c.name === 'pr_number');
      expect(prNumber).toBeDefined();
      expect(prNumber?.type).toBe('INTEGER');
      // notnull === 0 → the column is nullable (NULL until a PR is opened).
      expect(prNumber?.notnull).toBe(0);
    } finally {
      raw.close();
    }
  });

  it('is idempotent: a second runMigrations is a no-op (user_version stays 9)', () => {
    db = openDb(dbFile);

    // Run the migrations a second time against a fresh raw handle on the same file.
    // Already at the latest version → every migration is skipped, no throw, no
    // double-apply ("table already exists" would throw otherwise).
    const raw = new BetterSqlite3(dbFile);
    try {
      expect(() => runMigrations(raw)).not.toThrow();
      expect(raw.pragma('user_version', { simple: true })).toBe(9);
      // Exactly one integrations table — a double-apply would have thrown.
      const count = raw
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='integrations'",
        )
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      raw.close();
    }
  });

  it('IntegrationsRepo round-trips create → getById/list with tokenRef and no plaintext token', async () => {
    db = openDb(dbFile);
    const repo = new IntegrationsRepo(db);

    const created = await repo.create({
      kind: 'github',
      accountLabel: 'octocat',
      tokenRef: 'secret-blob-42',
    });

    expect(created).toEqual({
      id: created.id,
      kind: 'github',
      accountLabel: 'octocat',
      tokenRef: 'secret-blob-42',
    });
    // The DTO must NEVER surface a raw token — only the ciphertext reference.
    expect(Object.keys(created).sort()).toEqual([
      'accountLabel',
      'id',
      'kind',
      'tokenRef',
    ]);
    expect(created).not.toHaveProperty('token');

    const fetched = await repo.getById(created.id);
    expect(fetched).toEqual(created);
    expect(fetched).not.toHaveProperty('token');

    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(created);

    // Filtering by kind returns github; a different kind returns none.
    expect(await repo.list('github')).toHaveLength(1);
    expect(await repo.list('linear')).toHaveLength(0);
  });

  it('IntegrationsRepo.list returns integrations newest first, remove deletes', async () => {
    db = openDb(dbFile);
    const repo = new IntegrationsRepo(db);

    const first = await repo.create({
      kind: 'github',
      accountLabel: 'first',
      tokenRef: 'ref-1',
    });
    const second = await repo.create({
      kind: 'linear',
      accountLabel: 'second',
      tokenRef: 'ref-2',
    });

    // Newest first by created_at DESC — `second` was created after `first`.
    const listed = await repo.list();
    expect(listed.map((i) => i.id)).toEqual([second.id, first.id]);

    await repo.remove(first.id);
    expect(await repo.getById(first.id)).toBeNull();
    expect((await repo.list()).map((i) => i.id)).toEqual([second.id]);
  });
});
