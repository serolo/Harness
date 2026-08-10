// Migration 0016 — durable chat contexts (chat tabs). Mirrors
// 0014_task_effort.test.ts's "reproduce a pre-migration DB" pattern: run every
// migration on a fresh temp-file DB (so every OTHER table is in its latest shape),
// then manually revert JUST 0016's DDL (drop its table/column/indexes, rewind
// `user_version`) and seed data in the shape a real pre-0016 database would have
// before re-running the migrations.
//
// Coverage: one 'Untitled' context synthesized per workspace with pre-existing,
// unowned, non-task turns; a task-owned turn (via `scheduled_tasks.turn_id`) is
// excluded and keeps `context_id = NULL` forever; a SECOND scheduled_tasks row with
// `turn_id = NULL` must not poison the `NOT IN (...)` backfill query (the migration's
// own comment calls this out as load-bearing); `user_version` lands on 16; and a
// second `runMigrations` call is a no-op (idempotent, no double-insert).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from './index';

let tmpDir: string;
let db: BetterSqlite3.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-chat-contexts-migration-'));
  db = new BetterSqlite3(join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertProject(id: string): void {
  db.prepare(
    `INSERT INTO projects
       (id, name, origin_url, default_branch, repo_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, id, '', 'main', `/repo/${id}`, 1);
}

function insertWorkspace(id: string, projectId: string): void {
  db.prepare(
    `INSERT INTO workspaces
      (id, project_id, name, branch, base_branch, worktree_path, status,
       source_kind, source_ref, harness, port, created_at, archived_at,
       pr_number, location, is_unread, is_pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    id,
    id,
    'main',
    `/repo/${id}`,
    'idle',
    null,
    null,
    'claude_code',
    null,
    1,
    null,
    null,
    'worktree',
    0,
    0,
  );
}

/** Insert a turn WITHOUT `context_id` — the column has just been dropped by the test. */
function insertTurn(id: string, workspaceId: string, idx: number): void {
  db.prepare(
    `INSERT INTO turns
      (id, workspace_id, idx, status, session_id, mode, started_at, ended_at,
       input_tokens, output_tokens, reverted_at, harness, model,
       cached_input_tokens, cache_write_input_tokens, cost_micros, pricing_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    idx,
    'completed',
    null,
    'default',
    1,
    2,
    null,
    null,
    null,
    'claude_code',
    null,
    null,
    null,
    null,
    null,
  );
}

function insertScheduledTask(
  id: string,
  workspaceId: string,
  turnId: string | null,
): void {
  db.prepare(
    `INSERT INTO scheduled_tasks
      (id, workspace_id, prompt, model, mode, scheduled_at, state, origin,
       turn_id, error_message, created_at, updated_at, harness_override,
       attachments_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    'do it',
    null,
    null,
    null,
    'pending',
    'user',
    turnId,
    null,
    1,
    1,
    null,
    '[]',
  );
}

/**
 * Revert migration 0016's DDL on an already-fully-migrated DB, reproducing a
 * pre-0016 database (every other table stays in its LATEST shape, matching how
 * 0014_task_effort.test.ts reproduces a pre-0014 `scheduled_tasks`). Order matters:
 * the column carrying the `REFERENCES chat_contexts(id)` clause must go before the
 * table it references (see the migration's own rollback note).
 */
function revertMigration16(): void {
  db.exec('DROP INDEX idx_turns_context_id;');
  db.exec('ALTER TABLE turns DROP COLUMN context_id;');
  db.exec('DROP INDEX idx_chat_contexts_workspace_id;');
  db.exec('DROP TABLE chat_contexts;');
  db.pragma('user_version = 15');
}

describe('migration 0016 chat contexts', () => {
  it('backfills one Untitled context per workspace, excludes task-owned turns, and stays idempotent', () => {
    runMigrations(db);
    revertMigration16();

    insertProject('project-1');
    insertWorkspace('ws-a', 'project-1');
    insertWorkspace('ws-b', 'project-1');

    // Workspace A: a task-owned turn (must stay context_id = NULL forever) and an
    // unowned turn (must be backfilled to a new context).
    insertTurn('turn-a1', 'ws-a', 0);
    insertTurn('turn-a2', 'ws-a', 1);
    // Workspace B: one unowned turn, in its own workspace-scoped context.
    insertTurn('turn-b1', 'ws-b', 0);

    // The task-owning row, PLUS a second, untimed scheduled_tasks row whose turn_id
    // is NULL. Without the migration's `turn_id IS NOT NULL` guard, this second row
    // would appear in `SELECT turn_id FROM scheduled_tasks`, poisoning
    // `id NOT IN (...)` with a NULL and silently excluding EVERY turn from the
    // backfill (SQLite: `x NOT IN (set containing NULL)` is never true).
    insertScheduledTask('task-1', 'ws-a', 'turn-a1');
    insertScheduledTask('task-2', 'ws-a', null);

    runMigrations(db);

    expect(db.pragma('user_version', { simple: true })).toBe(16);

    const contextsA = db
      .prepare('SELECT * FROM chat_contexts WHERE workspace_id = ?')
      .all('ws-a') as Array<{ id: string; label: string; position: number }>;
    expect(contextsA).toHaveLength(1);
    expect(contextsA[0].label).toBe('Untitled');
    expect(contextsA[0].position).toBe(0);

    const contextsB = db
      .prepare('SELECT * FROM chat_contexts WHERE workspace_id = ?')
      .all('ws-b') as Array<{ id: string; label: string }>;
    expect(contextsB).toHaveLength(1);
    expect(contextsB[0].label).toBe('Untitled');
    // Each workspace gets its OWN context row — never shared across workspaces.
    expect(contextsB[0].id).not.toBe(contextsA[0].id);

    const turnA1 = db
      .prepare('SELECT context_id FROM turns WHERE id = ?')
      .get('turn-a1') as { context_id: string | null };
    expect(turnA1.context_id).toBeNull(); // task-owned — never adopted

    const turnA2 = db
      .prepare('SELECT context_id FROM turns WHERE id = ?')
      .get('turn-a2') as { context_id: string | null };
    expect(turnA2.context_id).toBe(contextsA[0].id);

    const turnB1 = db
      .prepare('SELECT context_id FROM turns WHERE id = ?')
      .get('turn-b1') as { context_id: string | null };
    expect(turnB1.context_id).toBe(contextsB[0].id);

    // Idempotent re-run: no double-insert, no re-adoption, version stays put.
    runMigrations(db);
    const contextsAAfter = db
      .prepare('SELECT * FROM chat_contexts WHERE workspace_id = ?')
      .all('ws-a');
    expect(contextsAAfter).toHaveLength(1);
    const contextsBAfter = db
      .prepare('SELECT * FROM chat_contexts WHERE workspace_id = ?')
      .all('ws-b');
    expect(contextsBAfter).toHaveLength(1);
    expect(db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('is a no-op schema-probe repair when chat_contexts and turns.context_id already exist', () => {
    // A fresh DB never had 0016 reverted — isApplied should short-circuit `up` on
    // a second run without needing to touch user_version manually.
    runMigrations(db);
    const before = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='chat_contexts'",
      )
      .get() as { n: number };
    expect(before.n).toBe(1);

    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(16);
    const after = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='chat_contexts'",
      )
      .get() as { n: number };
    expect(after.n).toBe(1);
  });
});
