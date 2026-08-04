import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));
vi.mock('../../process/executable', () => ({
  resolveExecutable: () => 'gh',
}));
vi.mock('../../paths', () => ({
  githubCliPath: () => '/definitely/missing/harness-gh',
}));

import { githubCliAuthStatus, githubCliLogout } from './ghCli';

describe('githubCliAuthStatus', () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it('reports gh as unavailable when execa resolves an ENOENT result', async () => {
    execaMock.mockResolvedValue({
      failed: true,
      code: 'ENOENT',
      stdout: '',
      stderr: '',
    });

    await expect(githubCliAuthStatus()).resolves.toEqual({
      available: false,
      authenticated: false,
      message: 'GitHub CLI is not installed.',
    });
  });

  it('distinguishes an installed but unauthenticated gh', async () => {
    execaMock.mockResolvedValue({
      failed: true,
      exitCode: 1,
      stdout: '',
      stderr: 'You are not logged into any GitHub hosts.',
    });

    await expect(githubCliAuthStatus()).resolves.toMatchObject({
      available: true,
      authenticated: false,
    });
  });

  it('logs out the detected github.com account without an interactive prompt', async () => {
    execaMock
      .mockResolvedValueOnce({
        failed: true,
        exitCode: 1,
        stdout: '',
        stderr: 'Failed to log in to github.com account octo',
      })
      .mockResolvedValueOnce({ failed: false, exitCode: 0 });

    await githubCliLogout();

    expect(execaMock).toHaveBeenLastCalledWith(
      'gh',
      ['auth', 'logout', '--hostname', 'github.com', '--user', 'octo'],
      { reject: false, timeout: 10_000 },
    );
  });
});
