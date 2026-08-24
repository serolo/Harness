import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverNativeSlashCommands } from './native';

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-native-slash-'));
  tempDirs.push(dir);
  return dir;
}

async function markdown(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

describe('discoverNativeSlashCommands', () => {
  it('discovers Claude commands and skills with their descriptions', async () => {
    const home = await tempHome();
    await markdown(
      join(home, '.claude', 'commands', 'review.md'),
      '---\ndescription: Review changes\n---\nReview this diff.\n\n$ARGS',
    );
    await markdown(
      join(home, '.claude', 'skills', 'frontend', 'SKILL.md'),
      '---\nname: frontend\ndescription: Build polished interfaces\n---\n# Frontend',
    );

    const commands = await discoverNativeSlashCommands({
      harness: 'claude_code',
      homeDir: home,
      adminDir: null,
    });

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'review',
          description: 'Review changes',
          template: 'Review this diff.\n\n$ARGS',
          source: 'native_command',
          provider: 'claude_code',
          provenance: 'user',
        }),
        expect.objectContaining({
          name: 'frontend',
          description: 'Build polished interfaces',
          template: '/frontend $ARGS',
          source: 'native_skill',
          invocation: 'slash',
        }),
      ]),
    );
  });

  it('uses Codex .agents roots, $ invocation, and preserves duplicate provenance', async () => {
    const home = await tempHome();
    const workspace = join(home, 'workspace');
    await markdown(
      join(home, '.agents', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Home deployment skill\n---\nDeploy.',
    );
    await markdown(
      join(home, '.codex', 'skills', 'legacy', 'SKILL.md'),
      '---\nname: legacy\ndescription: Legacy root\n---\nLegacy.',
    );
    await markdown(
      join(home, '.claude', 'skills', 'claude-only', 'SKILL.md'),
      '---\ndescription: Claude only\n---\nClaude.',
    );
    await markdown(
      join(workspace, '.agents', 'skills', 'deploy-folder', 'SKILL.md'),
      '---\nname: deploy\ndescription: >\n  Workspace deployment\n  skill\n---\nDeploy locally.',
    );

    const commands = await discoverNativeSlashCommands({
      harness: 'codex',
      homeDir: home,
      workspaceDir: workspace,
      adminDir: null,
    });

    expect(commands.map((command) => command.name)).toEqual([
      'deploy',
      'deploy',
    ]);
    expect(commands[0]?.description).toBe('Workspace deployment skill');
    expect(commands[0]).toMatchObject({
      template: '$deploy $ARGS',
      source: 'native_skill',
      provider: 'codex',
      provenance: 'workspace',
      invocation: 'dollar',
    });
    expect(commands[1]).toMatchObject({
      description: 'Home deployment skill',
      provenance: 'user',
    });
  });

  it('scans Codex skills from the working directory through repo root and admin scope', async () => {
    const home = await tempHome();
    const repo = join(home, 'repo');
    const workspace = join(repo, 'packages', 'app');
    const admin = join(home, 'etc-codex');
    await mkdir(join(repo, '.git'), { recursive: true });
    await markdown(
      join(workspace, '.agents', 'skills', 'local', 'SKILL.md'),
      '---\nname: local\ndescription: Local\n---\nLocal.',
    );
    await markdown(
      join(repo, 'packages', '.agents', 'skills', 'package', 'SKILL.md'),
      '---\nname: package\ndescription: Package\n---\nPackage.',
    );
    await markdown(
      join(repo, '.agents', 'skills', 'root', 'SKILL.md'),
      '---\nname: root\ndescription: Root\n---\nRoot.',
    );
    await markdown(
      join(admin, 'skills', 'admin', 'SKILL.md'),
      '---\nname: admin\ndescription: Admin\n---\nAdmin.',
    );

    const commands = await discoverNativeSlashCommands({
      harness: 'codex',
      homeDir: join(home, 'empty-home'),
      workspaceDir: workspace,
      adminDir: admin,
    });

    expect(commands.map(({ name, provenance }) => [name, provenance])).toEqual([
      ['local', 'workspace'],
      ['package', 'repository'],
      ['root', 'repository'],
      ['admin', 'admin'],
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the duplicated repository workflow skill catalogue in provider parity',
    async () => {
      const home = await tempHome();
      const workspaceDir = fileURLToPath(new URL('../../../', import.meta.url));
      const [codex, claude] = await Promise.all([
        discoverNativeSlashCommands({
          harness: 'codex',
          workspaceDir,
          homeDir: home,
          adminDir: null,
        }),
        discoverNativeSlashCommands({
          harness: 'claude_code',
          workspaceDir,
          homeDir: home,
          adminDir: null,
        }),
      ]);
      const workflowNames = (commands: typeof codex) =>
        commands
          .filter(
            (command) =>
              command.source === 'native_skill' &&
              command.name.startsWith('harness-'),
          )
          .map((command) => command.name)
          .sort();

      expect(workflowNames(codex)).toEqual(workflowNames(claude));
      expect(workflowNames(codex)).toEqual([
        'harness-implement',
        'harness-improve',
        'harness-plan',
        'harness-review',
      ]);
      expect(
        codex.find((command) => command.name === 'harness-plan'),
      ).toMatchObject({
        template: '$harness-plan $ARGS',
        invocation: 'dollar',
      });
      expect(
        claude.find((command) => command.name === 'harness-plan'),
      ).toMatchObject({ template: '/harness-plan $ARGS', invocation: 'slash' });
    },
  );
});
