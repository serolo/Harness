// buildEnv — the single place that derives the per-workspace environment injected
// into PTY terminals, run scripts, and the create-time setup command (spec §3.4,
// §5.2). Kept PURE: no `process.env` merge here (callers merge the inherited env at
// spawn time, exactly as `src/main/workspace/setup.ts` does), no Node/Electron/DOM
// imports — so it is trivially testable and safe to import from any main subsystem.
//
// SECURITY (heightened scrutiny — `.claude/rules/security.md`): `worktreePath`/`name`
// are workspace-derived and flow ONLY as environment VALUES here. They must never be
// interpolated into a shell string; callers pass this map as the child's `env`.

/** Inputs for {@link buildEnv}. `settingsEnv` is the user's `[env]` block (merged first). */
export interface BuildEnvOptions {
  /** Allocated free TCP port for the workspace (dev server binds here). */
  port: number;
  /** Absolute worktree path — surfaced as `WORKSPACE_PATH`. */
  worktreePath: string;
  /** Workspace (city) name — surfaced as `WORKSPACE_NAME`. */
  name: string;
  /** The user's `[env]` settings block; merged first so our vars always win. */
  settingsEnv?: Record<string, string>;
}

/**
 * Build the workspace environment map. The user's `[env]` block is applied first so
 * the app-owned variables (`PORT`/`APP_PORT`/`WORKSPACE_PATH`/`WORKSPACE_NAME`) always
 * take precedence — a misconfigured `[env]` cannot shadow the allocated port.
 */
export function buildEnv(opts: BuildEnvOptions): Record<string, string> {
  return {
    ...(opts.settingsEnv ?? {}),
    PORT: String(opts.port),
    APP_PORT: String(opts.port),
    WORKSPACE_PATH: opts.worktreePath,
    WORKSPACE_NAME: opts.name,
  };
}
