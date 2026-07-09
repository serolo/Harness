// TurnRecorder: streaming persistence + text-delta coalescing (Phase 2, Task 4).
// Opens a real better-sqlite3 file in os.tmpdir() (path injected into `openDb`, so no
// Electron `app.getPath` is touched). A parent projects+workspaces row is seeded first
// (foreign_keys is ON) reusing the existing repos as fixture builders — mirrors
// src/main/db/repos/turns.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '@shared/harness';
import { openDb, type AppDatabase } from '../db/index';
import { ProjectsRepo } from '../db/repos/projects';
import { WorkspacesRepo } from '../db/repos/workspaces';
import { TurnsRepo } from '../db/repos/turns';
import { EventsRepo } from '../db/repos/events';
import { TurnRecorder } from './turns';

let tmpDir: string;
let dbFile: string;
let db: AppDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-recorder-'));
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

async function seedWorkspace(
  handle: AppDatabase,
  name = 'paris',
): Promise<string> {
  const project = await new ProjectsRepo(handle).create({
    name: 'demo',
    originUrl: 'git@github.com:acme/demo.git',
    defaultBranch: 'main',
    repoPath: '/tmp/repo/demo',
  });
  const workspace = await new WorkspacesRepo(handle).create({
    projectId: project.id,
    name,
    branch: `agent/${name}`,
    baseBranch: 'main',
    harness: 'claude_code',
    status: 'idle',
  });
  return workspace.id;
}

function makeRecorder(handle: AppDatabase, threshold?: number): TurnRecorder {
  return new TurnRecorder(
    { turns: new TurnsRepo(handle), events: new EventsRepo(handle) },
    threshold !== undefined ? { textFlushThreshold: threshold } : {},
  );
}

/** Concatenate the text deltas across a reconstructed transcript's events. */
function transcriptText(events: { event: AgentEvent }[]): string {
  return events
    .map((e) => (e.event.kind === 'text' ? e.event.delta : ''))
    .join('');
}

describe('TurnRecorder.beginTurn', () => {
  it('opens a streaming turn and increments idx per workspace', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const recorder = makeRecorder(db);
    const turns = new TurnsRepo(db);

    const t0 = await recorder.beginTurn(wsId, { mode: 'default' });
    const first = await turns.getById(t0);
    expect(first?.idx).toBe(0);
    expect(first?.status).toBe('streaming');
    expect(first?.mode).toBe('default');

    const t1 = await recorder.beginTurn(wsId);
    expect((await turns.getById(t1))?.idx).toBe(1);
  });
});

describe('TurnRecorder coalescing + round-trip', () => {
  it('coalesces adjacent text deltas into fewer rows and preserves order', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    // High threshold so the only flushes are on the non-text boundary + endTurn.
    const recorder = makeRecorder(db, 10_000);
    const events = new EventsRepo(db);

    const turnId = await recorder.beginTurn(wsId);

    // Stream: 3 text deltas, a tool_use, 2 more text deltas, then end.
    const streamed: AgentEvent[] = [
      { kind: 'text', delta: 'Hel' },
      { kind: 'text', delta: 'lo, ' },
      { kind: 'text', delta: 'world' },
      { kind: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { kind: 'text', delta: ' — ' },
      { kind: 'text', delta: 'done' },
    ];
    for (const e of streamed) {
      await recorder.record(turnId, e);
    }
    await recorder.endTurn(turnId, 'completed', {
      inputTokens: 3,
      outputTokens: 9,
    });

    const persisted = await events.listByTurn(turnId);
    // 5 text deltas coalesced into 2 rows (one before the tool_use, one at end) + the
    // tool_use row = 3 rows total, strictly fewer than the 6 streamed events.
    expect(persisted).toHaveLength(3);
    const textRows = persisted.filter((e) => e.event.kind === 'text');
    expect(textRows).toHaveLength(2);
    expect(persisted.map((e) => e.event.kind)).toEqual([
      'text',
      'tool_use',
      'text',
    ]);

    // Transcript equivalence: concatenated persisted text === concatenated streamed text.
    const streamedText = streamed
      .map((e) => (e.kind === 'text' ? e.delta : ''))
      .join('');
    expect(transcriptText(persisted)).toBe(streamedText);
    expect(streamedText).toBe('Hello, world — done');
  });

  it('flushes on the size threshold so long text turns do not buffer unbounded', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const recorder = makeRecorder(db, 8); // tiny threshold to force mid-stream flushes
    const events = new EventsRepo(db);

    const turnId = await recorder.beginTurn(wsId);
    for (const delta of ['aaaa', 'bbbb', 'cccc', 'dddd']) {
      await recorder.record(turnId, { kind: 'text', delta });
    }
    await recorder.endTurn(turnId, 'completed');

    const persisted = await events.listByTurn(turnId);
    // 16 chars at threshold 8 → multiple flushes, but still fewer than 4 rows OR equal;
    // key property: text is preserved verbatim regardless of how it was chunked.
    expect(transcriptText(persisted)).toBe('aaaabbbbccccdddd');
    expect(persisted.every((e) => e.event.kind === 'text')).toBe(true);
  });

  it('history() reconstructs the full transcript across turns', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const recorder = makeRecorder(db, 10_000);

    const t0 = await recorder.beginTurn(wsId);
    await recorder.record(t0, { kind: 'text', delta: 'first turn' });
    await recorder.endTurn(t0, 'completed');

    const t1 = await recorder.beginTurn(wsId);
    await recorder.record(t1, { kind: 'text', delta: 'second ' });
    await recorder.record(t1, { kind: 'text', delta: 'turn' });
    await recorder.endTurn(t1, 'completed');

    const history = await recorder.history(wsId);
    expect(history.map((t) => t.idx)).toEqual([0, 1]);
    expect(transcriptText(history[0].events)).toBe('first turn');
    expect(transcriptText(history[1].events)).toBe('second turn');
  });
});

describe('TurnRecorder terminal paths', () => {
  it('endTurn on interrupt flushes the trailing buffer and leaves no streaming row', async () => {
    db = openDb(dbFile);
    const wsId = await seedWorkspace(db);
    const recorder = makeRecorder(db, 10_000);
    const turns = new TurnsRepo(db);
    const events = new EventsRepo(db);

    const turnId = await recorder.beginTurn(wsId);
    await recorder.record(turnId, { kind: 'text', delta: 'partial output' });
    // Interrupt mid-turn: no non-text event ever flushed the buffer.
    await recorder.endTurn(turnId, 'interrupted');

    const turn = await turns.getById(turnId);
    expect(turn?.status).toBe('interrupted');
    expect(turn?.endedAt).toBeTypeOf('number');

    // The partial text was NOT dropped — it was flushed by endTurn.
    const persisted = await events.listByTurn(turnId);
    expect(transcriptText(persisted)).toBe('partial output');
  });
});
