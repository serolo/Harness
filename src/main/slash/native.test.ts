import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    });

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'review',
          description: 'Review changes',
          template: 'Review this diff.\n\n$ARGS',
        }),
        expect.objectContaining({
          name: 'frontend',
          description: 'Build polished interfaces',
        }),
      ]),
    );
  });

  it('filters skills by provider and prefers workspace skills on duplicates', async () => {
    const home = await tempHome();
    const workspace = join(home, 'workspace');
    await markdown(
      join(home, '.codex', 'skills', 'deploy', 'SKILL.md'),
      '---\ndescription: Home deployment skill\n---\nDeploy.',
    );
    await markdown(
      join(home, '.claude', 'skills', 'claude-only', 'SKILL.md'),
      '---\ndescription: Claude only\n---\nClaude.',
    );
    await markdown(
      join(workspace, '.codex', 'skills', 'deploy', 'SKILL.md'),
      '---\ndescription: Workspace deployment skill\n---\nDeploy locally.',
    );

    const commands = await discoverNativeSlashCommands({
      harness: 'codex',
      homeDir: home,
      workspaceDir: workspace,
    });

    expect(commands.map((command) => command.name)).toEqual(['deploy']);
    expect(commands[0]?.description).toBe('Workspace deployment skill');
  });
});
