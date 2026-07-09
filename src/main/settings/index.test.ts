// Settings layered-merge (Task 10 / phase doc §7).
//
// Precedence (HIGHEST WINS): defaults < user < project shared < project local.
// Absent files are skipped; defaults fill every gap; `get()` returns a deep CLONE.
//
// The service reads TOML from disk, so these tests write temp TOML files into
// os.tmpdir() and drive `load({ userPath, projectDir })` — the explicit test seam.
// `userPath` is ALWAYS passed (even when pointing at a non-existent file) so the test
// never accidentally reads the developer's real ~/.../settings.toml via the paths seam.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SettingsService } from './index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-settings-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Absolute path to a user-layer TOML file we may or may not create. */
function userFile(): string {
  return join(tmpDir, 'user-settings.toml');
}

/** Create a project dir with `.harness/` and optionally the shared/local TOML files. */
function makeProjectDir(
  files: { shared?: string; local?: string } = {},
): string {
  const projectDir = join(tmpDir, 'project');
  const agentDir = join(projectDir, '.harness');
  mkdirSync(agentDir, { recursive: true });
  if (files.shared !== undefined) {
    writeFileSync(join(agentDir, 'settings.toml'), files.shared, 'utf8');
  }
  if (files.local !== undefined) {
    writeFileSync(join(agentDir, 'settings.local.toml'), files.local, 'utf8');
  }
  return projectDir;
}

describe('SettingsService — defaults (0 file layers)', () => {
  it('returns fully-populated defaults when no files exist', () => {
    const svc = new SettingsService();
    // userPath points at a non-existent file; no projectDir → 0 layers on disk.
    svc.load({ userPath: userFile() });
    const s = svc.get();

    expect(s.agent.defaultHarness).toBe('claude_code');
    expect(s.agent.mode).toBe('default');
    expect(s.agent.permissionPolicy).toEqual({});
    expect(s.agent.prompts).toEqual({});
    expect(s.git.branchPrefix).toBe('agent');
    expect(s.git.mergeStrategy).toBe('squash');
    expect(s.scripts.run).toEqual([]);
    expect(s.scripts.run_mode).toBe('single');
    expect(s.env).toEqual({});
    expect(s.mcp).toEqual([]);
    // Phase 2 additive sections: default so `{}` still parses to a full object.
    expect(s.agent.harnessImpl).toBe('auto');
    expect(s.notifications).toEqual({
      enabled: true,
      onTurnComplete: true,
      onError: true,
      onNeedsAttention: true,
    });
  });

  it('exposes defaults even before load() is ever called', () => {
    const svc = new SettingsService();
    // Constructor seeds the snapshot from EffectiveSettingsSchema.parse({}).
    expect(svc.get().git.branchPrefix).toBe('agent');
  });
});

describe('SettingsService — single layer (1 file)', () => {
  it('user layer overrides defaults, defaults fill the gaps', () => {
    writeFileSync(
      userFile(),
      ['[git]', 'branchPrefix = "feat"', '', '[agent]', 'mode = "plan"'].join(
        '\n',
      ),
      'utf8',
    );
    const svc = new SettingsService();
    svc.load({ userPath: userFile() });
    const s = svc.get();

    expect(s.git.branchPrefix).toBe('feat'); // overridden
    expect(s.git.mergeStrategy).toBe('squash'); // default fills the gap
    expect(s.agent.mode).toBe('plan'); // overridden
    expect(s.agent.defaultHarness).toBe('claude_code'); // default fills the gap
  });

  it('project shared layer overrides defaults when no user file exists (absent user skipped)', () => {
    const projectDir = makeProjectDir({
      shared: ['[git]', 'mergeStrategy = "rebase"'].join('\n'),
    });
    const svc = new SettingsService();
    // userPath absent-on-disk → that layer is skipped; only shared applies.
    svc.load({ userPath: userFile(), projectDir });
    const s = svc.get();

    expect(s.git.mergeStrategy).toBe('rebase');
    expect(s.git.branchPrefix).toBe('agent'); // still default
  });
});

describe('SettingsService — two layers + full precedence', () => {
  it('project local wins over project shared wins over user wins over defaults', () => {
    // Same key set at every layer → highest present layer must win.
    writeFileSync(
      userFile(),
      ['[git]', 'branchPrefix = "from-user"', 'mergeStrategy = "merge"'].join(
        '\n',
      ),
      'utf8',
    );
    const projectDir = makeProjectDir({
      shared: ['[git]', 'branchPrefix = "from-shared"'].join('\n'),
      local: ['[git]', 'branchPrefix = "from-local"'].join('\n'),
    });

    const svc = new SettingsService();
    svc.load({ userPath: userFile(), projectDir });
    const s = svc.get();

    // branchPrefix set at user/shared/local → local (highest) wins.
    expect(s.git.branchPrefix).toBe('from-local');
    // mergeStrategy set ONLY at user → user survives (not clobbered by lower-layer absence).
    expect(s.git.mergeStrategy).toBe('merge');
  });

  it('deep-merges nested tables key-by-key across layers', () => {
    writeFileSync(
      userFile(),
      ['[env]', 'FOO = "user-foo"', 'SHARED_ONLY = "user"'].join('\n'),
      'utf8',
    );
    const projectDir = makeProjectDir({
      local: ['[env]', 'FOO = "local-foo"', 'LOCAL_ONLY = "local"'].join('\n'),
    });

    const svc = new SettingsService();
    svc.load({ userPath: userFile(), projectDir });
    const s = svc.get();

    // env is a table: keys merge; overlapping key takes the higher layer.
    expect(s.env).toEqual({
      FOO: 'local-foo',
      SHARED_ONLY: 'user',
      LOCAL_ONLY: 'local',
    });
  });

  it('replaces arrays wholesale (highest layer wins, no concat)', () => {
    writeFileSync(
      userFile(),
      ['[[mcp]]', 'name = "user-server"', 'command = "user-cmd"'].join('\n'),
      'utf8',
    );
    const projectDir = makeProjectDir({
      local: ['[[mcp]]', 'name = "local-server"', 'command = "local-cmd"'].join(
        '\n',
      ),
    });

    const svc = new SettingsService();
    svc.load({ userPath: userFile(), projectDir });
    const s = svc.get();

    // Array override, not concat: the local mcp list fully replaces the user's.
    expect(s.mcp).toHaveLength(1);
    expect(s.mcp[0]).toMatchObject({
      name: 'local-server',
      command: 'local-cmd',
    });
  });

  it('skips an absent project local file, keeping the shared layer', () => {
    writeFileSync(
      userFile(),
      ['[git]', 'branchPrefix = "u"'].join('\n'),
      'utf8',
    );
    const projectDir = makeProjectDir({
      shared: ['[git]', 'branchPrefix = "s"'].join('\n'),
      // no local file
    });
    const svc = new SettingsService();
    svc.load({ userPath: userFile(), projectDir });
    expect(svc.get().git.branchPrefix).toBe('s'); // shared wins over user; local absent
  });

  it('merges only defaults + user when projectDir is omitted', () => {
    writeFileSync(
      userFile(),
      ['[git]', 'branchPrefix = "u"'].join('\n'),
      'utf8',
    );
    const svc = new SettingsService();
    svc.load({ userPath: userFile() });
    expect(svc.get().git.branchPrefix).toBe('u');
  });
});

describe('SettingsService.get() — clone isolation', () => {
  it('returns a deep clone; mutating the result does not affect the snapshot', () => {
    const svc = new SettingsService();
    svc.load({ userPath: userFile() });

    const first = svc.get();
    first.git.branchPrefix = 'mutated';
    (first.env as Record<string, string>).INJECTED = 'x';

    const second = svc.get();
    expect(second.git.branchPrefix).toBe('agent'); // untouched by the mutation
    expect(second.env).toEqual({});
    // Two reads are distinct object graphs.
    expect(first).not.toBe(second);
    expect(first.git).not.toBe(second.git);
  });
});

describe('SettingsService — malformed TOML', () => {
  it('propagates a parse error (not silently swallowed like an absent file)', () => {
    writeFileSync(userFile(), 'this = = broken toml', 'utf8');
    const svc = new SettingsService();
    // ENOENT is skipped, but a genuine parse error must surface.
    expect(() => svc.load({ userPath: userFile() })).toThrow();
  });
});

// --- Phase 6 additions ------------------------------------------------------

describe('SettingsService.getProvenance() — per-leaf source layer', () => {
  it('reports which layer supplied each effective value', () => {
    writeFileSync(userFile(), '[git]\nbranchPrefix = "u"\n', 'utf8');
    const projectDir = makeProjectDir({
      local: '[git]\nbranchPrefix = "l"\n',
    });
    const svc = new SettingsService();
    svc.load({ userPath: userFile(), projectDir });
    const prov = svc.getProvenance();

    expect(prov['git.branchPrefix']).toBe('project-local'); // highest that set it
    expect(prov['git.mergeStrategy']).toBe('default'); // no layer set it
    expect(prov['mcp']).toBe('default'); // array leaf, atomic
  });
});

describe('SettingsService.loadResult() — non-throwing validation surfacing', () => {
  it('skips a malformed layer and reports an issue instead of throwing', () => {
    writeFileSync(userFile(), 'this = = broken toml', 'utf8');
    const svc = new SettingsService();
    const result = svc.loadResult({ userPath: userFile() });

    // Bad layer skipped → defaults survive; the problem is surfaced, not thrown.
    expect(result.settings.git.branchPrefix).toBe('agent');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]!.file).toBe(userFile());
  });

  it('drops a layer whose value violates the schema, keeping the good layers', () => {
    // user layer is valid; project-local sets a bad enum → dropped, user survives.
    writeFileSync(userFile(), '[git]\nbranchPrefix = "u"\n', 'utf8');
    const projectDir = makeProjectDir({
      local: '[git]\nmergeStrategy = "not-a-strategy"\n',
    });
    const svc = new SettingsService();
    const result = svc.loadResult({ userPath: userFile(), projectDir });

    expect(result.settings.git.branchPrefix).toBe('u'); // good layer kept
    expect(result.settings.git.mergeStrategy).toBe('squash'); // bad layer dropped → default
    expect(
      result.issues.some((i) => i.keyPath?.includes('mergeStrategy')),
    ).toBe(true);
  });

  it('returns no issues for a clean load', () => {
    writeFileSync(userFile(), '[agent]\nmode = "plan"\n', 'utf8');
    const svc = new SettingsService();
    const result = svc.loadResult({ userPath: userFile() });
    expect(result.issues).toEqual([]);
    expect(result.settings.agent.mode).toBe('plan');
  });
});

describe('SettingsService.set() — write + reload', () => {
  it('persists a value to the user file and reflects it in the snapshot', () => {
    const svc = new SettingsService();
    svc.load({ userPath: userFile() });
    const updated = svc.set('user', 'git.branchPrefix', 'feat');

    expect(updated.git.branchPrefix).toBe('feat');
    expect(svc.get().git.branchPrefix).toBe('feat'); // snapshot refreshed
    expect(svc.getProvenance()['git.branchPrefix']).toBe('user');
  });

  it('rejects an invalid value without changing the snapshot', () => {
    const svc = new SettingsService();
    svc.load({ userPath: userFile() });
    expect(() => svc.set('user', 'git.mergeStrategy', 'bogus')).toThrow();
    expect(svc.get().git.mergeStrategy).toBe('squash'); // unchanged
  });
});
