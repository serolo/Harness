/** Platform-specific process conventions kept behind testable pure helpers. */

export function executableName(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' && !command.toLowerCase().endsWith('.exe')
    ? `${command}.exe`
    : command;
}

export function defaultTerminalShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') return env.COMSPEC || 'cmd.exe';
  if (env.SHELL) return env.SHELL;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}
