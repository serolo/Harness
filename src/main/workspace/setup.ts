// Setup-command runner — streams combined stdout+stderr from a short-lived
// shell command to an optional log sink.  Pure: no Electron, no DB, no
// ProcessRegistry.
//
// INTEGRATION(phase-3): consolidate with ProcessRunner.

import { execa } from 'execa';

/**
 * Run an arbitrary shell command in `cwd`, streaming combined output to
 * `onLog` as it arrives.
 *
 * The command is executed through the OS shell (`shell: true`) so callers may
 * pass compound expressions (`npm ci && npm run build`).  A non-zero exit code
 * resolves normally — it is returned in `exitCode` rather than thrown, so
 * callers can decide how to surface the failure (e.g. `setStatus('needs_attention')`).
 *
 * @param command - Shell command string to execute.
 * @param opts.cwd - Working directory; should be the worktree path.
 * @param opts.env - Extra environment variables merged on top of
 *   `process.env`.  Typical keys: `PORT`, `APP_PORT`, plus any project-level
 *   `settings.env` entries.
 * @param onLog - Optional callback invoked with each stdout/stderr chunk as a
 *   UTF-8 string.  Called on the main process tick; do not block it.
 * @returns Resolved promise carrying the process exit code (0 on success).
 */
export async function runSetup(
  command: string,
  opts: { cwd: string; env?: Record<string, string> },
  onLog?: (chunk: string) => void,
): Promise<{ exitCode: number }> {
  const cp = execa(command, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    shell: true,
    reject: false,
    all: true,
  });

  // Stream combined stdout+stderr live to the caller's sink.
  cp.all?.on('data', (b: Buffer) => {
    onLog?.(b.toString());
  });

  const result = await cp;

  return { exitCode: result.exitCode ?? 0 };
}
