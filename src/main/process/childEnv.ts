// childProcessEnv — environment inherited by external user-facing tools.
//
// Electron/Node can run the app with IPC-only variables in process.env. Passing those
// through to Node-based CLIs can make the child try to attach to a file descriptor that
// does not exist in the spawned process, surfacing as `spawn EBADF` or an immediate
// bootstrap failure. Strip only those process-control variables; keep normal PATH,
// auth, shell, and user-provided settings intact.

const IPC_ENV_KEYS = ['NODE_CHANNEL_FD', 'NODE_UNIQUE_ID', 'ELECTRON_RUN_AS_NODE'];

export function childProcessEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  for (const key of IPC_ENV_KEYS) {
    delete env[key];
  }

  return env;
}
