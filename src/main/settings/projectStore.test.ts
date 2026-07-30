import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type AppDatabase } from '../db';
import { ProjectsRepo } from '../db/repos/projects';
import { setUserDataRoot } from '../paths';
import {
  loadStoredProjectSettings,
  saveStoredProjectSetting,
} from './projectStore';

const databases: AppDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
  setUserDataRoot(undefined);
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-project-settings-'));
  mkdirSync(join(root, '.harness'));
  setUserDataRoot(root);
  const db = openDb(join(root, 'app.db'));
  databases.push(db);
  const project = await new ProjectsRepo(db).create({
    name: 'Example',
    originUrl: '',
    defaultBranch: 'main',
    repoPath: root,
  });
  return { root, db, project };
}

describe('database-backed project settings', () => {
  it('imports a legacy settings.toml, persists it, and removes the file', async () => {
    const { root, db, project } = await fixture();
    const legacyFile = join(root, '.harness', 'settings.toml');
    writeFileSync(
      legacyFile,
      '[git]\nbranchPrefix = "feature"\n\n[knowledge]\nenabled = true\n',
    );

    const loaded = await loadStoredProjectSettings(db, project);

    expect(loaded.issues).toEqual([]);
    expect(loaded.value).toMatchObject({
      git: { branchPrefix: 'feature' },
      knowledge: { enabled: true },
    });
    expect(existsSync(legacyFile)).toBe(false);
    expect(await loadStoredProjectSettings(db, project)).toEqual(loaded);
  });

  it('writes project changes to SQLite without recreating settings.toml', async () => {
    const { root, db, project } = await fixture();

    await saveStoredProjectSetting(db, project, 'knowledge.enabled', true);

    expect((await loadStoredProjectSettings(db, project)).value).toMatchObject({
      knowledge: { enabled: true },
    });
    expect(existsSync(join(root, '.harness', 'settings.toml'))).toBe(false);
  });

  it('preserves an invalid legacy file and reports the migration problem', async () => {
    const { root, db, project } = await fixture();
    const legacyFile = join(root, '.harness', 'settings.toml');
    writeFileSync(legacyFile, '[knowledge\ninvalid');

    const loaded = await loadStoredProjectSettings(db, project);

    expect(loaded.issues[0]?.message).toContain(
      'Could not migrate project settings',
    );
    expect(existsSync(legacyFile)).toBe(true);
  });
});
