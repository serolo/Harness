// treeKillEscalate — the single reliable process-tree teardown path (README §7.4,
// spec §9 Risk R1). A tracked child (run script / PTY) may have spawned its own tree
// (a dev server forks a bundler, a watcher, …); killing just the root leaks the rest.
// `tree-kill` walks the descendants and signals each, so this is the ONLY teardown the
// registry uses.
//
// SECURITY (heightened scrutiny — process execution): escalation is SIGTERM → SIGKILL.
// We give the tree `graceMs` to exit cleanly on SIGTERM (flush buffers, remove sockets),
// then force it with SIGKILL so a process ignoring SIGTERM cannot wedge archive/quit.

import treeKill from 'tree-kill';

/** How often (ms) we re-check whether the root pid is gone. */
const POLL_INTERVAL_MS = 100;

/**
 * Hard cap (ms) added on top of `graceMs`: after SIGKILL a process must die, but we
 * never poll forever — `before-quit` awaits this, so an unkillable/zombie pid must not
 * be able to hang shutdown. Resolve best-effort once this elapses.
 */
const HARD_TIMEOUT_MS = 5000;

/**
 * Whether `pid` still exists. `process.kill(pid, 0)` sends no signal — it only probes:
 * `ESRCH` means gone; `EPERM` means it exists but we lack permission (still "there").
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kill the process tree rooted at `pid`, escalating SIGTERM → SIGKILL after `graceMs`.
 * Resolves once the root pid is gone (or after a hard-timeout backstop). Never rejects:
 * teardown is best-effort so one stubborn tree cannot abort sibling teardown or quit.
 *
 * @param pid      - Root pid (the child we spawned); its whole tree is targeted.
 * @param graceMs  - Grace period before escalating to SIGKILL (default 5s).
 */
export function treeKillEscalate(pid: number, graceMs = 5000): Promise<void> {
  return new Promise<void>((resolve) => {
    const start = Date.now();
    const hardDeadline = start + graceMs + HARD_TIMEOUT_MS;
    let escalated = false;

    // Ignore tree-kill callback errors: a failure usually means the tree already exited
    // (nothing to signal), which the poll below detects.
    const ignore = (): void => {};
    treeKill(pid, 'SIGTERM', ignore);

    const poll = (): void => {
      const now = Date.now();
      if (!isAlive(pid) || now >= hardDeadline) {
        resolve();
        return;
      }
      if (!escalated && now - start >= graceMs) {
        escalated = true;
        treeKill(pid, 'SIGKILL', ignore);
      }
      setTimeout(poll, POLL_INTERVAL_MS).unref();
    };
    setTimeout(poll, POLL_INTERVAL_MS).unref();
  });
}
