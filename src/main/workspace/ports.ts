// Workspace port allocator — probes a free TCP port in a configurable range.
// Pure: depends only on `node:net`, no Electron, no DB. Unit-tests run in
// plain Node.
//
// TOCTOU caveat: the probe releases the socket immediately after confirming the
// port is free (we do NOT hold it open).  A racing process can therefore claim
// the port between our probe and the caller's bind.  This is acceptable — the
// run script may override the port via an environment variable (settings/env),
// and the `taken` list lets WorkspaceManager exclude ports already recorded for
// live workspaces within the same project, which is the primary collision risk.

import * as net from 'node:net';

/** Options for {@link allocate}. */
export interface PortAllocateOptions {
  /**
   * Inclusive [min, max] port range to search.
   * Defaults to `[3000, 3999]`.
   */
  range?: [number, number];
  /**
   * Ports to skip unconditionally (e.g. ports already claimed by sibling
   * workspaces in the same project).
   */
  taken?: number[];
}

/**
 * Probe a single TCP port for availability.
 *
 * Resolves `true` if the port is free (we were able to bind and immediately
 * released it), `false` if `EADDRINUSE`.  Rejects on any unexpected error.
 */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => {
      // Port is free — release immediately (TOCTOU hint, not a hold).
      server.close(() => resolve(true));
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Return a free TCP port within `range`, excluding any port in `taken`.
 *
 * Iterates candidates in ascending order; for each candidate that is not in
 * `taken`, probes availability via a transient `net.createServer().listen()`
 * call and resolves with the first free port found.
 *
 * **TOCTOU caveat:** the probe releases the socket immediately.  A concurrent
 * process may claim the port before the caller binds it.  This is by design —
 * treat the returned value as a strong hint, not a reservation.  Run scripts
 * may accept a `PORT` / `APP_PORT` env override to handle the rare race.
 *
 * @param opts.range  - Inclusive [min, max] range; defaults to `[3000, 3999]`.
 * @param opts.taken  - Ports to exclude regardless of OS availability.
 * @throws {Error} When every port in the range is either taken or in use.
 */
export async function allocate(opts?: PortAllocateOptions): Promise<number> {
  const [min, max] = opts?.range ?? [3000, 3999];
  const excluded = new Set(opts?.taken ?? []);

  for (let port = min; port <= max; port++) {
    if (excluded.has(port)) {
      continue;
    }
    const free = await probePort(port);
    if (free) {
      return port;
    }
  }

  throw new Error(
    `no free port available in range [${min}, ${max}]` +
      (excluded.size > 0 ? ` (${excluded.size} port(s) excluded)` : ''),
  );
}
