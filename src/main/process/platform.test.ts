import { defaultTerminalShell, executableName } from './platform';

describe('platform process conventions', () => {
  it('uses the Windows command processor for terminal tabs', () => {
    expect(
      defaultTerminalShell('win32', { COMSPEC: 'C:\\Windows\\cmd.exe' }),
    ).toBe('C:\\Windows\\cmd.exe');
    expect(defaultTerminalShell('win32', {})).toBe('cmd.exe');
  });

  it('uses the login shell on Unix with safe platform fallbacks', () => {
    expect(
      defaultTerminalShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }),
    ).toBe('/opt/homebrew/bin/fish');
    expect(defaultTerminalShell('darwin', {})).toBe('/bin/zsh');
    expect(defaultTerminalShell('linux', {})).toBe('/bin/bash');
  });

  it('adds executable suffixes only on Windows', () => {
    expect(executableName('claude', 'win32')).toBe('claude.exe');
    expect(executableName('claude.exe', 'win32')).toBe('claude.exe');
    expect(executableName('claude', 'linux')).toBe('claude');
  });
});
