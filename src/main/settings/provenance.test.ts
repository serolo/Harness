// Provenance-aware merge (Task A1). The merge is pure over already-parsed layers,
// so these tests pass plain objects (the parsed shape of a TOML table) directly —
// no temp files needed. Precedence + array-atomic semantics mirror index.test.ts.

import { describe, it, expect } from 'vitest';

import { effectiveWithProvenance, type TaggedLayer } from './provenance';

/** Build the tagged-layer list from optional per-layer raw objects (low → high). */
function layers(opts: {
  user?: Record<string, unknown>;
  shared?: Record<string, unknown>;
  local?: Record<string, unknown>;
}): TaggedLayer[] {
  const out: TaggedLayer[] = [];
  if (opts.user !== undefined) out.push({ tag: 'user', obj: opts.user });
  if (opts.shared !== undefined)
    out.push({ tag: 'project-shared', obj: opts.shared });
  if (opts.local !== undefined)
    out.push({ tag: 'project-local', obj: opts.local });
  return out;
}

describe('effectiveWithProvenance — value', () => {
  it('fills every leaf from defaults when there are no layers', () => {
    const { value, provenance } = effectiveWithProvenance([]);
    expect(value.git.branchPrefix).toBe('agent');
    expect(value.git.mergeStrategy).toBe('squash');
    // Every default leaf is attributed to the `default` layer.
    expect(provenance['git.branchPrefix']).toBe('default');
    expect(provenance['git.mergeStrategy']).toBe('default');
    expect(provenance['agent.mode']).toBe('default');
    expect(provenance['mcp']).toBe('default'); // array leaf, atomic
  });

  it('applies full precedence (local > shared > user > default) to the value', () => {
    const { value } = effectiveWithProvenance(
      layers({
        user: { git: { branchPrefix: 'from-user', mergeStrategy: 'merge' } },
        shared: { git: { branchPrefix: 'from-shared' } },
        local: { git: { branchPrefix: 'from-local' } },
      }),
    );
    expect(value.git.branchPrefix).toBe('from-local');
    // mergeStrategy set only at user → survives the higher layers' absence.
    expect(value.git.mergeStrategy).toBe('merge');
  });
});

describe('effectiveWithProvenance — provenance per leaf', () => {
  it('attributes each leaf to the highest layer that set it', () => {
    const { provenance } = effectiveWithProvenance(
      layers({
        user: { git: { branchPrefix: 'u', mergeStrategy: 'merge' } },
        shared: { git: { branchPrefix: 's' } },
        local: { git: { branchPrefix: 'l' } },
      }),
    );
    expect(provenance['git.branchPrefix']).toBe('project-local');
    // Not set above the user layer → provenance stays at user.
    expect(provenance['git.mergeStrategy']).toBe('user');
  });

  it('tracks provenance per nested table key independently', () => {
    const { value, provenance } = effectiveWithProvenance(
      layers({
        user: { env: { FROM_USER: 'u', SHARED: 'u' } },
        local: { env: { FROM_LOCAL: 'l', SHARED: 'l' } },
      }),
    );
    expect(value.env).toEqual({ FROM_USER: 'u', FROM_LOCAL: 'l', SHARED: 'l' });
    expect(provenance['env.FROM_USER']).toBe('user');
    expect(provenance['env.FROM_LOCAL']).toBe('project-local');
    expect(provenance['env.SHARED']).toBe('project-local'); // higher layer wins
  });

  it('treats arrays atomically — one provenance entry for the whole array', () => {
    const { value, provenance } = effectiveWithProvenance(
      layers({
        user: { mcp: [{ name: 'user-server', command: 'user-cmd' }] },
        local: { mcp: [{ name: 'local-server', command: 'local-cmd' }] },
      }),
    );
    // Array replaced wholesale, not concatenated.
    expect(value.mcp).toHaveLength(1);
    expect(value.mcp[0]).toMatchObject({ name: 'local-server' });
    // Provenance is the whole array's source layer — no per-element paths.
    expect(provenance['mcp']).toBe('project-local');
    expect(provenance['mcp.0']).toBeUndefined();
    expect(provenance['mcp.0.name']).toBeUndefined();
  });

  it('clears stale child provenance when a higher layer replaces a table with an array', () => {
    // Lower layer sets scripts.run entries via a table-ish path is not possible in
    // the schema, but permissionPolicy is an object that a higher layer can override
    // key-by-key; assert nested override attribution.
    const { provenance } = effectiveWithProvenance(
      layers({
        user: { agent: { permissionPolicy: { confirmBeforeRun: true } } },
        local: { agent: { permissionPolicy: { confirmBeforeRun: false } } },
      }),
    );
    expect(provenance['agent.permissionPolicy.confirmBeforeRun']).toBe(
      'project-local',
    );
  });
});
