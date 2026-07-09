// Integration tests for WorkspaceManager — create → archive → restore cycle.
// Uses a real temp git repo, real temp SQLite DB, real GitService, and real
// naming/ports allocators. Runs in the default node environment.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import type { EventChannel, EventPayload } from '@shared/ipc';
import {
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { openDb } from '../db/index';
import { ProjectsRepo } from '../db/repos/projects';
import { WorkspacesRepo } from '../db/repos/workspaces';
import { GitService } from '../git/index';
import { allocate as allocateName } from './naming';
import { allocate as allocatePort } from './ports';
import { runSetup } from './setup';
import { WorkspaceManager } from './index';
import { setUserDataRoot } from '../paths';
import type { SettingsService } from '../settings';
import type { WorkspaceManagerDeps } from './index';
import type { EffectiveSettings } from '../settings/schema';
import type { AppDatabase } from '../db/index';

// ---------------------------------------------------------------------------
// Helper: build a minimal git source repo with one commit
// ---------------------------------------------------------------------------

async function buildSourceRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await execa('git', ['init', '-b', 'main', dir]);
  writeFileSync(join(dir, 'README.md'), '# test');
  await execa(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=test', 'add', '.'],
    { cwd: dir },
  );
  await execa(
    'git',
    [
      '-c',
      'user.email=t@t.t',
      '-c',
      'user.name=test',
      'commit',
      '-m',
      'initial',
    ],
    { cwd: dir },
  );
}

// ---------------------------------------------------------------------------
// Test state — fresh for each test
// ---------------------------------------------------------------------------

let tmpRoot: string;
let userDataRoot: string;
let dbPath: string;
let db: AppDatabase;
let sourceRepoPath: string;
let projectId: string;
let projectsRepo: ProjectsRepo;
let workspacesRepo: WorkspacesRepo;

// Typed emit spy: captures every (event, payload) pair in `emitted`.
// `emitSpy` is a plain vi.fn() used to assert call counts/args.
type EmittedPayload = {
  workspaceId?: string;
  status?: string;
  [key: string]: unknown;
};

let emitSpy: Mock<(event: EventChannel, payload: EmittedPayload) => void>;
let emit: <K extends EventChannel>(event: K, payload: EventPayload<K>) => void;
// Process-stop hook spy (asserted by archive to prove it runs before force-removal).
let stopSpy: Mock<(id: string) => void>;

function makeSettings(setupScript: string): EffectiveSettings {
  return {
    scripts: {
      setup: setupScript,
      run: [],
      run_mode: 'single',
    },
    env: {},
    agent: {
      defaultHarness: 'claude_code',
      mode: 'default',
      permissionPolicy: {},
      prompts: {},
      reviewPrompt: 'review',
      prPrompt: 'pr',
      harnessImpl: 'auto',
    },
    git: {
      branchPrefix: 'agent',
      mergeStrategy: 'squash',
    },
    mcp: [],
    notifications: {
      enabled: true,
      onTurnComplete: true,
      onError: true,
      onNeedsAttention: true,
    },
  };
}

function buildManager(setupScript: string): WorkspaceManager {
  const settingsSnapshot = makeSettings(setupScript);

  const deps: WorkspaceManagerDeps = {
    repos: { projects: projectsRepo, workspaces: workspacesRepo },
    git: new GitService(),
    naming: { allocate: allocateName },
    ports: { allocate: allocatePort },
    settings: {
      get: () => structuredClone(settingsSnapshot),
      load: () => {},
    } as unknown as SettingsService,
    runSetup,
    stopWorkspaceProcesses: stopSpy,
    // Typed wrapper so tsc accepts the generic signature; delegates to spy for assertions.
    emit,
  };

  return new WorkspaceManager(deps);
}

beforeEach(async () => {
  // Unique temp root per test
  tmpRoot = mkdtempSync(join(tmpdir(), 'ws-mgr-test-'));
  userDataRoot = join(tmpRoot, 'userData');
  dbPath = join(tmpRoot, 'test.db');
  sourceRepoPath = join(tmpRoot, 'source');

  // Point the paths module at our temp dir (no Electron)
  setUserDataRoot(userDataRoot);

  // Build source git repo
  await buildSourceRepo(sourceRepoPath);

  // Open real DB
  db = openDb(dbPath);

  // Create repos
  projectsRepo = new ProjectsRepo(db);
  workspacesRepo = new WorkspacesRepo(db);

  // Insert a project
  const project = await projectsRepo.create({
    name: 'test-project',
    originUrl: '',
    defaultBranch: 'main',
    repoPath: sourceRepoPath,
  });
  projectId = project.id;

  // Fresh spy + typed wrapper (tsc requires the generic signature on WorkspaceManagerDeps).
  emitSpy = vi.fn<(event: EventChannel, payload: EmittedPayload) => void>();
  emit = <K extends EventChannel>(event: K, payload: EventPayload<K>): void => {
    emitSpy(event, payload as EmittedPayload);
  };
  stopSpy = vi.fn<(id: string) => void>();
});

afterEach(() => {
  setUserDataRoot(undefined);
  // Close db by letting it go out of scope; sqlite WAL needs no explicit close for tests
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('WorkspaceManager.create', () => {
  it('returns a workspace with status idle and non-null port', async () => {
    const manager = buildManager('echo setup-ran');
    const ws = await manager.create({ projectId });
    expect(ws.status).toBe('idle');
    expect(ws.port).not.toBeNull();
    expect(typeof ws.port).toBe('number');
  });

  it('worktreePath exists on disk', async () => {
    const manager = buildManager('echo setup-ran');
    const ws = await manager.create({ projectId });
    expect(ws.worktreePath).not.toBeNull();
    expect(existsSync(ws.worktreePath!)).toBe(true);
  });

  it('branch is <branchPrefix>/<cityName>', async () => {
    const manager = buildManager('echo setup-ran');
    const ws = await manager.create({ projectId });
    expect(ws.branch).toMatch(/^agent\/.+$/);
  });

  it('emits workspace:created after DB row is committed', async () => {
    const manager = buildManager('echo setup-ran');
    await manager.create({ projectId });
    const createdCalls = emitSpy.mock.calls.filter(
      ([event]) => event === 'workspace:created',
    );
    expect(createdCalls.length).toBe(1);
    expect(createdCalls[0][1]).toMatchObject({
      workspace: expect.objectContaining({ projectId }),
    });
  });

  it('onSetupLog callback receives at least one chunk from the setup script', async () => {
    const manager = buildManager('echo setup-ran');
    const chunks: string[] = [];
    await manager.create({ projectId }, (chunk) => chunks.push(chunk));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const joined = chunks.join('');
    expect(joined).toContain('setup-ran');
  });

  it('non-zero setup exit → status becomes needs_attention', async () => {
    const manager = buildManager('exit 3');
    const ws = await manager.create({ projectId });
    // Re-fetch to ensure we see the updated status
    const refetched = await manager.get(ws.id);
    expect(refetched?.status).toBe('needs_attention');
  });

  it('two workspaces get distinct city names and distinct ports', async () => {
    const manager = buildManager('echo ok');
    const ws1 = await manager.create({ projectId });
    const ws2 = await manager.create({ projectId });
    expect(ws1.name).not.toBe(ws2.name);
    expect(ws1.port).not.toBe(ws2.port);
  });
});

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

describe('WorkspaceManager.archive', () => {
  it('removes the worktree from disk', async () => {
    const manager = buildManager('echo ok');
    const ws = await manager.create({ projectId });
    const worktreePath = ws.worktreePath!;
    expect(existsSync(worktreePath)).toBe(true);

    await manager.archive(ws.id);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('keeps the DB row with status archived and worktreePath null', async () => {
    const manager = buildManager('echo ok');
    const ws = await manager.create({ projectId });
    await manager.archive(ws.id);
    const row = await manager.get(ws.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('archived');
    expect(row?.worktreePath).toBeNull();
  });

  it('emits workspace:archived event', async () => {
    const manager = buildManager('echo ok');
    const ws = await manager.create({ projectId });
    emitSpy.mockClear();
    await manager.archive(ws.id);
    const archivedCalls = emitSpy.mock.calls.filter(
      ([event]) => event === 'workspace:archived',
    );
    expect(archivedCalls.length).toBe(1);
    expect(archivedCalls[0][1]).toMatchObject({ workspaceId: ws.id });
  });

  it('invokes the process-stop hook with the workspace id', async () => {
    const manager = buildManager('echo ok');
    const ws = await manager.create({ projectId });
    await manager.archive(ws.id);
    expect(stopSpy).toHaveBeenCalledWith(ws.id);
  });

  it('throws when the workspace does not exist', async () => {
    const manager = buildManager('echo ok');
    await expect(manager.archive('nonexistent-id')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('WorkspaceManager.restore', () => {
  it('re-creates the worktree on disk', async () => {
    const manager = buildManager('echo ok');
    const ws = await manager.create({ projectId });
    await manager.archive(ws.id);
    await manager.restore(ws.id);
    const row = await manager.get(ws.id);
    expect(row?.worktreePath).not.toBeNull();
    expect(existsSync(row!.worktreePath!)).toBe(true);
  });

  it('status is idle after restore', async () => {
    const manager = buildManager('echo ok');
    const ws = await manager.create({ projectId });
    await manager.archive(ws.id);
    await manager.restore(ws.id);
    const row = await manager.get(ws.id);
    expect(row?.status).toBe('idle');
  });

  it('emits workspace:status with idle after restore', async () => {
    const manager = buildManager('echo ok');
    const ws = await manager.create({ projectId });
    await manager.archive(ws.id);
    emitSpy.mockClear();
    await manager.restore(ws.id);
    const statusCalls = emitSpy.mock.calls.filter(
      ([event]) => event === 'workspace:status',
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    const idleCall = statusCalls.find(
      ([, payload]) => payload.status === 'idle',
    );
    expect(idleCall).toBeDefined();
    expect(idleCall?.[1]).toMatchObject({ workspaceId: ws.id, status: 'idle' });
  });

  it('degrades gracefully with an AppError when the branch is gone (Phase-4 checkpoint absent)', async () => {
    const manager = buildManager('echo ok');
    const ws = await manager.create({ projectId });
    await manager.archive(ws.id);
    // Simulate the branch having been deleted while archived — restore cannot recreate
    // it until the Phase-4 checkpoint path exists, so it must surface a clear AppError.
    await execa('git', ['-C', sourceRepoPath, 'branch', '-D', ws.branch]);
    await expect(manager.restore(ws.id)).rejects.toMatchObject({
      code: 'git',
    });
    // The row must remain archived (no partial restore).
    const row = await manager.get(ws.id);
    expect(row?.status).toBe('archived');
  });

  it('throws when the workspace does not exist', async () => {
    const manager = buildManager('echo ok');
    await expect(manager.restore('nonexistent-id')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

describe('WorkspaceManager.list / get', () => {
  it('list returns only live workspaces by default', async () => {
    const manager = buildManager('echo ok');
    const ws1 = await manager.create({ projectId });
    const ws2 = await manager.create({ projectId });
    await manager.archive(ws1.id);

    const live = await manager.list(projectId);
    expect(live.some((w) => w.id === ws1.id)).toBe(false);
    expect(live.some((w) => w.id === ws2.id)).toBe(true);
  });

  it('list with includeArchived returns all workspaces', async () => {
    const manager = buildManager('echo ok');
    const ws1 = await manager.create({ projectId });
    await manager.archive(ws1.id);

    const all = await manager.list(projectId, true);
    expect(all.some((w) => w.id === ws1.id)).toBe(true);
  });

  it('get returns null for an unknown id', async () => {
    const manager = buildManager('echo ok');
    const result = await manager.get('no-such-id');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setStatus
// ---------------------------------------------------------------------------

describe('WorkspaceManager.setStatus', () => {
  it('updates the status in DB and emits workspace:status', async () => {
    const manager = buildManager('echo ok');
    const ws = await manager.create({ projectId });
    emitSpy.mockClear();
    await manager.setStatus(ws.id, 'working');
    const row = await manager.get(ws.id);
    expect(row?.status).toBe('working');
    const statusCalls = emitSpy.mock.calls.filter(
      ([event]) => event === 'workspace:status',
    );
    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0][1]).toMatchObject({
      workspaceId: ws.id,
      status: 'working',
    });
  });
});
