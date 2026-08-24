import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { preparePtyCommand } from './pty-command';

describe('private PTY command launcher', () => {
  it('keeps command arguments in a private config instead of launcher argv', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-pty-command-'));
    try {
      const launch = await preparePtyCommand({
        privateDirectory: directory,
        command: 'claude',
        args: ['--prompt', 'secret; $(whoami)'],
        env: { PROVIDER_TOKEN: 'private' },
        stdoutPath: join(directory, 'stdout'),
        stderrPath: join(directory, 'stderr'),
        launcherPath: '/app/pty-command-launcher.js',
        runtimePath: '/app/electron',
      });

      expect(launch).toMatchObject({
        shell: '/app/electron',
        args: ['/app/pty-command-launcher.js'],
      });
      expect(launch.args.join(' ')).not.toContain('secret');
      expect(launch.env).toMatchObject({
        ELECTRON_RUN_AS_NODE: '1',
        HARNESS_PTY_COMMAND_CONFIG: launch.configPath,
      });
      expect(
        JSON.parse(await readFile(launch.configPath, 'utf8')),
      ).toMatchObject({
        command: 'claude',
        args: ['--prompt', 'secret; $(whoami)'],
        env: { PROVIDER_TOKEN: 'private' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
